/**
 * DriftDetector module. Detects semantic drift between the base and head
 * versions of changed TypeScript source files by comparing exported function
 * signatures and JSDoc comments.
 *
 * Uses `simple-git` to fetch the base file content from `${sha}^1:<filePath>`
 * and reads the head version directly from disk. Both versions are parsed
 * in-memory via `ts-morph` — no temporary files are written to disk.
 *
 * Overload deduplication (F-9): when multiple declarations share the same
 * function name, only the last one (the implementation signature) is kept;
 * overload-only declarations are discarded.
 *
 * @module drift-detector
 */

import { readFile } from 'fs/promises';
import { simpleGit } from 'simple-git';
import { Project, FunctionDeclaration } from 'ts-morph';
import type { ExportedFunction } from '../types.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Internal shape holding the extracted signature and JSDoc for one function. */
interface FunctionInfo {
  /** Full implementation signature text, without the function body. */
  signature: string;
  /** Cleaned JSDoc text with delimiters and leading ` * ` stripped. */
  jsdoc: string;
}

/**
 * Extracts the function signature — the full declaration text excluding the
 * body block — from a `ts-morph` FunctionDeclaration node.
 *
 * For functions that have a body, the text from the start of the declaration
 * up to (but not including) the opening brace `{` is returned, trimmed of
 * trailing whitespace.
 *
 * For overload declarations (no body), the full node text is returned.
 *
 * @param fn - The function declaration node to inspect.
 * @returns The trimmed signature string.
 */
function extractSignature(fn: FunctionDeclaration): string {
  const body = fn.getBody();
  if (body !== undefined) {
    const fnStart = fn.getStart();           // position of first keyword (e.g. 'export')
    const bodyStart = body.getStart();       // position of opening '{'
    const sourceText = fn.getSourceFile().getFullText();
    return sourceText.slice(fnStart, bodyStart).trim();
  }
  return fn.getText().trim();
}

/**
 * Extracts the JSDoc comment from a `ts-morph` FunctionDeclaration node,
 * with `/** *\/` delimiters stripped.
 *
 * Returns an empty string when no JSDoc is attached to the declaration.
 *
 * @param fn - The function declaration node to inspect.
 * @returns The cleaned JSDoc text, or `''` if no JSDoc is present.
 */
function extractJsDoc(fn: FunctionDeclaration): string {
  const jsDocs = fn.getJsDocs();
  if (jsDocs.length === 0) return '';
  // Use the last JSDoc block (the one closest to the declaration)
  const jsDoc = jsDocs[jsDocs.length - 1];
  return jsDoc.getInnerText().trim();
}

/**
 * Parses a TypeScript source string with an in-memory `ts-morph` Project and
 * returns a map of exported function names to their extracted info.
 *
 * Overload deduplication (F-9): all declarations for the same name are
 * iterated in source order; later declarations overwrite earlier ones, so the
 * final map entry always holds the implementation signature (last declaration).
 *
 * @param content - Raw TypeScript source text.
 * @returns Map from function name to {@link FunctionInfo}.
 */
function parseExportedFunctions(content: string): Map<string, FunctionInfo> {
  if (!content.trim()) return new Map();

  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFile = project.createSourceFile('__temp__.ts', content);

  const result = new Map<string, FunctionInfo>();

  const fns = sourceFile.getFunctions().filter((fn) => fn.isExported());

  for (const fn of fns) {
    const name = fn.getName();
    if (!name) continue;
    // Last declaration wins — handles overload deduplication (F-9)
    result.set(name, {
      signature: extractSignature(fn),
      jsdoc: extractJsDoc(fn),
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detects drift in exported TypeScript functions for a set of changed files.
 *
 * For each `.ts` file in `changedFilePaths`:
 * 1. Fetches the base version via `git show ${sha}^1:<filePath>` (F-4).
 * 2. Reads the head version from disk.
 * 3. Parses exported functions in both versions using in-memory `ts-morph`
 *    projects — no files are written to disk.
 * 4. Classifies each head function as `'added'` (absent in base) or
 *    `'modified'` (present in base but signature or JSDoc differs).
 *    Functions identical in both versions are omitted from the result.
 *    Functions removed in the head are also omitted (not the concern of this
 *    module).
 *
 * If `git show` throws (e.g. the file is brand-new and has no base version),
 * the base is treated as empty, making all head functions `'added'`.
 *
 * @param changedFilePaths - Repo-relative paths to the changed `.ts` files.
 *   Non-`.ts` paths are silently skipped.
 * @param sha - The head commit SHA. The base is resolved as `sha^1`.
 * @returns Resolved array of {@link ExportedFunction} entries for every
 *   function that was added or modified.
 */
export async function detectDrift(
  changedFilePaths: string[],
  sha: string,
): Promise<ExportedFunction[]> {
  // GITHUB_TOKEN is never needed here; only the local git history is accessed.
  const git = simpleGit();
  const results: ExportedFunction[] = [];

  for (const filePath of changedFilePaths) {
    if (!filePath.endsWith('.ts')) continue;

    // Fetch base content via git show ${sha}^1:<filePath> (F-4)
    let baseContent: string;
    try {
      baseContent = await git.show([`${sha}^1:${filePath}`]);
    } catch {
      // File did not exist at base commit (e.g. newly added file in this PR)
      baseContent = '';
    }

    // Read head version from disk
    const headContent = await readFile(filePath, 'utf-8');

    const baseFunctions = parseExportedFunctions(baseContent);
    const headFunctions = parseExportedFunctions(headContent);

    for (const [name, headInfo] of headFunctions) {
      const baseInfo = baseFunctions.get(name);

      if (baseInfo === undefined) {
        // Function not present in base → added
        results.push({
          name,
          signature: headInfo.signature,
          jsdoc: headInfo.jsdoc,
          sourceFilePath: filePath,
          changeType: 'added',
        });
      } else if (
        headInfo.signature !== baseInfo.signature ||
        headInfo.jsdoc !== baseInfo.jsdoc
      ) {
        // Function present in both but signature or JSDoc changed → modified
        results.push({
          name,
          signature: headInfo.signature,
          jsdoc: headInfo.jsdoc,
          sourceFilePath: filePath,
          changeType: 'modified',
        });
      }
      // Functions identical in both versions are intentionally omitted
    }
  }

  return results;
}
