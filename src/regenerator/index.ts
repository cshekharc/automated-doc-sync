/**
 * SectionRegenerator — replaces stale documentation sections via raw-string splice.
 *
 * IMPORTANT (F-3): `remark-stringify` is never imported or called anywhere in
 * this file. remark is used only to locate section character offsets when they
 * are not already set on the {@link DocSection}. All content outside the
 * replaced section is preserved byte-for-byte (AC-3).
 *
 * @module regenerator
 */

import { unified } from 'unified';
import remarkParse from 'remark-parse';
import type { Root, Heading, Text } from 'mdast';
import type { DocSection, ExportedFunction } from '../types.js';

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Builds the Confluence storage-format XHTML scaffold for a newly added exported function.
 * Produces an `<h2>` heading, a typed code block, and a JSDoc paragraph.
 *
 * @param fn - The exported function to scaffold.
 * @returns XHTML string with h2 heading, typed code block, and JSDoc body.
 */
export function buildConfluenceScaffoldSection(fn: ExportedFunction): string {
  const jsdocBody = fn.jsdoc.trim();
  return (
    `<h2>${fn.name}</h2>` +
    `<pre><code class="language-typescript">${fn.signature}</code></pre>` +
    `<p>${jsdocBody}</p>`
  );
}

/**
 * Uses remark to find the character offsets of a named section in a Markdown file.
 * remark-stringify is not called — only the AST's position metadata is read.
 *
 * @param rawFile - The raw Markdown file content.
 * @param functionName - Exact heading text to search for.
 * @returns `{ sectionStartOffset, sectionEndOffset }` or `null` if not found.
 */
function findMarkdownSectionOffsets(
  rawFile: string,
  functionName: string
): { sectionStartOffset: number; sectionEndOffset: number } | null {
  const processor = unified().use(remarkParse);
  const tree = processor.parse(rawFile) as Root;

  // Collect all heading nodes that have position metadata
  const headingEntries: Array<{ node: Heading; startOffset: number }> = [];
  for (const node of tree.children) {
    if (
      node.type === 'heading' &&
      node.position !== undefined &&
      node.position.start.offset !== undefined
    ) {
      headingEntries.push({
        node: node as Heading,
        startOffset: node.position.start.offset,
      });
    }
  }

  // Find the first heading whose plain text matches functionName exactly
  const matchIndex = headingEntries.findIndex(({ node }) => {
    const text = node.children
      .filter((c): c is Text => c.type === 'text')
      .map(c => c.value)
      .join('');
    return text === functionName;
  });

  if (matchIndex === -1) {
    return null;
  }

  const matchedEntry = headingEntries[matchIndex];
  const headingDepth = matchedEntry.node.depth;
  const sectionStartOffset = matchedEntry.startOffset;

  // Section ends at the first subsequent heading at the same or higher level
  // (lower depth number), or at the end of the file.
  let sectionEndOffset = rawFile.length;
  for (let i = matchIndex + 1; i < headingEntries.length; i++) {
    if (headingEntries[i].node.depth <= headingDepth) {
      sectionEndOffset = headingEntries[i].startOffset;
      break;
    }
  }

  return { sectionStartOffset, sectionEndOffset };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Builds a Markdown scaffold section for a newly added or stale exported function.
 *
 * Canonical section format (architecture §4 Step 6):
 * ```
 * ## functionName
 *
 * ```typescript
 * <signature>
 * ```
 *
 * <jsdoc body>
 * ```
 *
 * @param fn - The exported function to scaffold.
 * @returns Markdown string: level-2 heading + TypeScript code fence + JSDoc body.
 */
export function buildScaffoldSection(fn: ExportedFunction): string {
  const jsdocBody = fn.jsdoc.trim();
  return (
    `## ${fn.name}\n\n` +
    `\`\`\`typescript\n${fn.signature}\n\`\`\`\n\n` +
    `${jsdocBody}\n`
  );
}

/**
 * Regenerates a Markdown documentation section using a raw-string splice.
 *
 * If `section.sectionStartOffset` and `section.sectionEndOffset` are already
 * set (e.g., populated by `DocLocator`), they are used directly and remark is
 * not invoked. If either offset is missing, remark is used to locate the
 * heading in `rawFile` and derive the offsets — remark-stringify is never
 * called.
 *
 * After the splice, `rawFile.slice(0, sectionStart)` and
 * `rawFile.slice(sectionEnd)` in the returned string are byte-for-byte
 * identical to the corresponding ranges in the original (AC-3).
 *
 * @param rawFile - The raw Markdown file content as a string.
 * @param section - The documentation section to replace. Provides
 *   `functionName` and optionally pre-computed character offsets.
 * @param fn - The exported function with updated `signature` and `jsdoc`.
 * @returns The full Markdown file content with the section replaced.
 * @throws {Error} If offsets are absent and no matching heading is found.
 */
export function regenerateMarkdownSection(
  rawFile: string,
  section: DocSection,
  fn: ExportedFunction
): string {
  let sectionStart = section.sectionStartOffset;
  let sectionEnd = section.sectionEndOffset;

  if (sectionStart === undefined || sectionEnd === undefined) {
    const offsets = findMarkdownSectionOffsets(rawFile, section.functionName);
    if (offsets === null) {
      throw new Error(
        `regenerateMarkdownSection: no heading found for "${section.functionName}" in the provided Markdown content.`
      );
    }
    sectionStart = offsets.sectionStartOffset;
    sectionEnd = offsets.sectionEndOffset;
  }

  const newSection = buildScaffoldSection(fn);
  // Prefix and suffix are sliced directly from rawFile — byte-for-byte identity guaranteed.
  return rawFile.slice(0, sectionStart) + newSection + rawFile.slice(sectionEnd);
}

/**
 * Regenerates a Confluence storage-format XHTML documentation section using a
 * raw-string splice. No XHTML re-serializer is invoked; unchanged content is
 * preserved byte-for-byte (AC-3).
 *
 * `section.sectionStartOffset` and `section.sectionEndOffset` must be pre-set
 * (typically populated by `DocLocator`). The Confluence path does not invoke
 * remark — the XHTML heading boundaries are resolved by `DocLocator` before
 * this function is called.
 *
 * @param rawXhtml - The raw Confluence storage-format XHTML content.
 * @param section - The documentation section to replace. Must have
 *   `sectionStartOffset` and `sectionEndOffset` set.
 * @param fn - The exported function with updated `signature` and `jsdoc`.
 * @returns The full XHTML string with the section replaced.
 * @throws {Error} If `sectionStartOffset` or `sectionEndOffset` is not set.
 */
export function regenerateConfluenceSection(
  rawXhtml: string,
  section: DocSection,
  fn: ExportedFunction
): string {
  const sectionStart = section.sectionStartOffset;
  const sectionEnd = section.sectionEndOffset;

  if (sectionStart === undefined || sectionEnd === undefined) {
    throw new Error(
      `regenerateConfluenceSection: sectionStartOffset and sectionEndOffset must be ` +
      `set for "${section.functionName}". Use DocLocator to populate them before calling this function.`
    );
  }

  const newSection = buildConfluenceScaffoldSection(fn);
  // Prefix and suffix are sliced directly from rawXhtml — byte-for-byte identity guaranteed.
  return rawXhtml.slice(0, sectionStart) + newSection + rawXhtml.slice(sectionEnd);
}
