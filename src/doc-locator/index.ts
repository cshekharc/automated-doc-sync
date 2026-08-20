/**
 * DocLocator module — Markdown and Confluence paths.
 *
 * Provides utilities for locating existing documentation sections in Markdown
 * files and in Confluence pages, and for resolving scaffold target paths when
 * a section is missing.
 *
 * @module doc-locator
 */

import { remark } from 'remark';
import { glob } from 'glob';
import * as fs from 'node:fs';
import * as path from 'node:path';
import axios from 'axios';
import type { Heading, Root, PhrasingContent } from 'mdast';
import type { DocSection } from '../types.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Extracts the plain-text content from a Markdown heading node.
 *
 * Concatenates the `value` property of every `text` and `inlineCode` child.
 * Nested phrasing content inside emphasis/strong wrappers is intentionally
 * skipped: function names used as headings are always plain text or inline
 * code in this project.
 */
function extractHeadingText(heading: Heading): string {
  return heading.children
    .map((child: PhrasingContent): string => {
      if (child.type === 'text') {
        return (child as { value: string }).value;
      }
      if (child.type === 'inlineCode') {
        return (child as { value: string }).value;
      }
      return '';
    })
    .join('');
}

// ---------------------------------------------------------------------------
// Public exports
// ---------------------------------------------------------------------------

/**
 * Locates the documentation section for `functionName` by searching every
 * Markdown file that matches `docsGlob`. Each file is parsed with remark into
 * an mdast AST; the first `##`-level heading whose text exactly equals
 * `functionName` is treated as the section boundary.
 *
 * When a match is found the returned {@link DocSection} contains:
 * - `target: 'markdown'`
 * - `markdownFilePath` — path to the matching file as returned by `glob`
 * - `sectionContent` — raw string slice from the heading start to the next
 *   same-or-higher-level heading (or end of file)
 * - `sectionStartOffset` / `sectionEndOffset` — zero-based character offsets
 *   in the raw file string, ready for use by `SectionRegenerator` (F-3)
 *
 * When no heading matches, returns a sentinel with `target: 'not-found'` and
 * `sectionContent: ''`. The raw file content is never re-serialised (F-3).
 *
 * @param functionName - Exact function name to match against `##` heading text.
 * @param docsGlob - Glob pattern for Markdown files to search.
 *   Defaults to `'docs/**​/*.md'`.
 * @returns The first matching {@link DocSection}, or a not-found sentinel.
 */
export async function locateMarkdownSection(
  functionName: string,
  docsGlob: string = 'docs/**/*.md',
): Promise<DocSection> {
  const files = await glob(docsGlob);

  for (const filePath of files) {
    const rawContent = fs.readFileSync(filePath, 'utf8');
    const tree = remark().parse(rawContent) as Root;
    const children = tree.children;

    for (let i = 0; i < children.length; i++) {
      const node = children[i];
      if (node.type !== 'heading') continue;

      const heading = node as Heading;
      if (heading.depth !== 2) continue;

      const headingText = extractHeadingText(heading);
      if (headingText !== functionName) continue;

      const sectionStartOffset = heading.position!.start.offset!;

      // Find where this section ends: the start of the next heading at depth
      // ≤ 2 (i.e. ## or #). If no such sibling exists, the section runs to
      // the end of the file.
      let sectionEndOffset = rawContent.length;
      for (let j = i + 1; j < children.length; j++) {
        const sibling = children[j];
        if (sibling.type === 'heading' && (sibling as Heading).depth <= 2) {
          sectionEndOffset = sibling.position!.start.offset!;
          break;
        }
      }

      const sectionContent = rawContent.slice(sectionStartOffset, sectionEndOffset);

      return {
        functionName,
        target: 'markdown',
        markdownFilePath: filePath,
        sectionContent,
        sectionStartOffset,
        sectionEndOffset,
      };
    }
  }

  return {
    functionName,
    target: 'not-found',
    sectionContent: '',
  };
}

/**
 * Resolves the scaffold target documentation file path for a TypeScript
 * source file using the heuristic from architecture §5.4:
 *
 * 1. Derive `<base>` from the source file's base name (without `.ts`).
 *    If `docs/<base>.md` exists, return it.
 * 2. Derive `<dir>` from the source file's immediate parent directory name.
 *    If `docs/<dir>.md` exists, return it.
 * 3. If neither exists, return the value of the `DOCS_DEFAULT_FILE`
 *    environment variable, falling back to `'docs/api.md'`.
 *
 * The function does not create any files; it only resolves a path.
 * Both forward-slash and backslash path separators are accepted in
 * `sourceFilePath` (Windows paths are normalised internally).
 *
 * Environment variable:
 *   `DOCS_DEFAULT_FILE` — overrides the final fallback path when set.
 *
 * @param sourceFilePath - Repo-relative source file path,
 *   e.g. `'src/foo/bar.ts'` or `'src\\foo\\bar.ts'`.
 * @returns The resolved target documentation file path relative to the repo root.
 */
export function resolveScaffoldTarget(sourceFilePath: string): string {
  // Normalise backslashes so path.posix helpers work on Windows-style paths.
  const normalizedPath = sourceFilePath.replace(/\\/g, '/');

  const basename = path.posix.basename(normalizedPath, '.ts');
  const dir = path.posix.basename(path.posix.dirname(normalizedPath));

  // Step 1 — docs/<base>.md
  const byBase = `docs/${basename}.md`;
  if (fs.existsSync(byBase)) {
    return byBase;
  }

  // Step 2 — docs/<dir>.md
  const byDir = `docs/${dir}.md`;
  if (fs.existsSync(byDir)) {
    return byDir;
  }

  // Step 3 — configurable fallback via DOCS_DEFAULT_FILE env var
  // (e.g. 'docs/api.md').  The env var is read at call time so that tests
  // can set it without module-level side effects.
  return process.env['DOCS_DEFAULT_FILE'] ?? 'docs/api.md';
}

// ---------------------------------------------------------------------------
// Confluence helpers and public exports (T-10)
// ---------------------------------------------------------------------------

/**
 * Extracts a documentation section for `functionName` from Confluence
 * storage-format XHTML using regex matching. A regex strategy is required
 * because the `ac:` namespace elements present in Confluence storage-format
 * XHTML break standard XML parsers.
 *
 * Handled heading forms:
 * - `<h2>functionName</h2>`
 * - `<h2><span class="...">functionName</span></h2>`
 *
 * This function is exported so the fixture-based unit test (R-4) can call
 * the extraction logic directly against the on-disk fixture without needing
 * an HTTP mock.
 *
 * @param functionName  - Exact function name to match against heading text.
 * @param headingLevel  - HTML heading tag to search, e.g. `'h2'` or `'h3'`.
 * @param xhtml         - Raw Confluence storage-format XHTML string.
 * @returns Object with `found` flag plus `sectionContent` and character offsets.
 */
export function extractConfluenceSection(
  functionName: string,
  headingLevel: string,
  xhtml: string,
): {
  found: boolean;
  sectionContent: string;
  sectionStartOffset: number;
  sectionEndOffset: number;
} {
  // Escape any regex special characters in the function name.
  const escaped = functionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Match <hN>functionName</hN> or <hN><span ...>functionName</span></hN>.
  // Optional whitespace is allowed around the name and the span tags.
  const headingPattern = new RegExp(
    `<${headingLevel}>\\s*(?:<span[^>]*>\\s*)?${escaped}\\s*(?:</span>\\s*)?</${headingLevel}>`,
    'i',
  );

  const match = headingPattern.exec(xhtml);
  if (!match) {
    return { found: false, sectionContent: '', sectionStartOffset: 0, sectionEndOffset: 0 };
  }

  const sectionStartOffset = match.index;
  const headingEndPos = sectionStartOffset + match[0].length;

  // Find the next same-or-higher heading (lower level number = higher hierarchy).
  // For h2 this searches for the next <h1> or <h2> after the current heading.
  const levelNum = parseInt(headingLevel.substring(1), 10);
  const remaining = xhtml.slice(headingEndPos);
  const nextHeadingPattern = new RegExp(`<h[1-${levelNum}][^>]*>`, 'i');
  const nextMatch = nextHeadingPattern.exec(remaining);
  const sectionEndOffset = nextMatch ? headingEndPos + nextMatch.index : xhtml.length;

  return {
    found: true,
    sectionContent: xhtml.slice(sectionStartOffset, sectionEndOffset),
    sectionStartOffset,
    sectionEndOffset,
  };
}

/**
 * Locates the documentation section for `functionName` in a Confluence page.
 *
 * **Page ID resolution order:**
 * 1. `docs/confluence-map.json` keyed on `sourceFilePath`.
 * 2. `CONFLUENCE_PAGE_ID` environment variable (fallback).
 * 3. If neither is configured, returns a `not-found` sentinel immediately —
 *    no HTTP request is issued.
 *
 * **Fetch:** `GET <CONFLUENCE_BASE_URL>/api/v2/pages/<pageId>?body-format=storage`
 * with `Authorization: Basic <base64(":" + CONFLUENCE_API_TOKEN)>` and a
 * request timeout of `CONFLUENCE_REQUEST_TIMEOUT_MS` ms (default 30 000 ms).
 *
 * **Parse:** the returned storage-format XHTML body is searched using
 * {@link extractConfluenceSection} at the heading level specified by
 * `CONFLUENCE_HEADING_LEVEL` (default `h2`).
 *
 * Environment variables (all read at call time):
 * - `CONFLUENCE_BASE_URL`           — Base URL of the Confluence instance.
 * - `CONFLUENCE_API_TOKEN`          — API token for Basic auth; never logged (NFR-2).
 * - `CONFLUENCE_PAGE_ID`            — Fallback page ID when not found in the map.
 * - `CONFLUENCE_HEADING_LEVEL`      — Heading tag to search, default `'h2'` (A-2, F-2).
 * - `CONFLUENCE_REQUEST_TIMEOUT_MS` — HTTP request timeout in ms, default 30 000.
 *
 * @param functionName   - Exact function name to match against heading text.
 * @param sourceFilePath - Repo-relative source file path used to look up the
 *   page ID in `docs/confluence-map.json`, e.g. `'src/drift-detector/index.ts'`.
 * @returns The matching {@link DocSection}, or a not-found sentinel.
 */
export async function locateConfluenceSection(
  functionName: string,
  sourceFilePath: string,
): Promise<DocSection> {
  // ---- 1. Resolve page ID -------------------------------------------------

  let pageId: string | undefined;

  try {
    const mapRaw = fs.readFileSync('docs/confluence-map.json', 'utf8');
    const map = JSON.parse(mapRaw) as Record<string, string>;
    pageId = map[sourceFilePath];
  } catch {
    // Map file unreadable or invalid JSON — fall through to env var.
  }

  if (!pageId) {
    // CONFLUENCE_PAGE_ID — fallback page ID when not present in confluence-map.json
    pageId = process.env['CONFLUENCE_PAGE_ID'];
  }

  if (!pageId) {
    return { functionName, target: 'not-found', sectionContent: '' };
  }

  // ---- 2. Fetch page body via Confluence REST API v2 ----------------------

  // CONFLUENCE_BASE_URL — base URL of the Confluence instance
  const baseUrl = process.env['CONFLUENCE_BASE_URL'] ?? '';
  // CONFLUENCE_API_TOKEN — Basic auth credential; never logged (NFR-2)
  const token = process.env['CONFLUENCE_API_TOKEN'] ?? '';
  // CONFLUENCE_REQUEST_TIMEOUT_MS — HTTP timeout in milliseconds; default 30 000
  const timeout = parseInt(process.env['CONFLUENCE_REQUEST_TIMEOUT_MS'] ?? '30000', 10);

  // Basic auth with empty username: base64(":" + token)
  const auth = Buffer.from(':' + token).toString('base64');

  const response = await axios.get(
    `${baseUrl}/api/v2/pages/${pageId}?body-format=storage`,
    {
      headers: { Authorization: `Basic ${auth}` },
      timeout,
    },
  );

  // Loosely typed response data to handle partial or unknown API shapes.
  const data = response.data as {
    title?: string;
    version?: { number?: number };
    body?: { storage?: { value?: string } };
  };

  const pageTitle = data.title ?? '';
  const versionNumber = data.version?.number ?? 0;
  const bodyXhtml = data.body?.storage?.value ?? '';

  // ---- 3. Extract heading-delimited section from XHTML --------------------

  // CONFLUENCE_HEADING_LEVEL — heading element to search; default 'h2' (A-2, F-2)
  const headingLevel = process.env['CONFLUENCE_HEADING_LEVEL'] ?? 'h2';
  const extracted = extractConfluenceSection(functionName, headingLevel, bodyXhtml);

  if (!extracted.found) {
    return { functionName, target: 'not-found', sectionContent: '' };
  }

  return {
    functionName,
    target: 'confluence',
    confluencePageId: pageId,
    confluencePageTitle: pageTitle,
    confluenceVersionNumber: versionNumber,
    sectionContent: extracted.sectionContent,
    sectionStartOffset: extracted.sectionStartOffset,
    sectionEndOffset: extracted.sectionEndOffset,
  };
}
