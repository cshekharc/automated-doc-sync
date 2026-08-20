/**
 * DriftComparator — compares a parsed exported function against its corresponding
 * documentation section to determine whether the documentation is up to date.
 *
 * The canonical section form is:
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
 * where `<jsdoc body>` is `fn.jsdoc` (already stripped of `/** *\/` delimiters
 * and leading ` * ` prefixes by the extractor).
 *
 * Both the expected canonical string and `section.sectionContent` are normalised
 * before comparison: leading/trailing whitespace is trimmed and runs of three or
 * more consecutive newlines are collapsed to two.
 *
 * @module drift-comparator
 */

import type { ExportedFunction, DocSection, ComparisonResult } from './types.js';

/**
 * Normalises a text block for whitespace-insensitive comparison.
 * Trims the string and collapses any sequence of three or more consecutive
 * newlines down to two (a single blank line).
 */
function normalise(text: string): string {
  return text.trim().replace(/\n{3,}/g, '\n\n');
}

/**
 * Renders the canonical documentation section string for the given function.
 * The output format is: Markdown heading, TypeScript fenced code block
 * containing the implementation signature, blank line, then the JSDoc body.
 */
function renderCanonical(fn: ExportedFunction): string {
  const parts = [
    `## ${fn.name}`,
    '',
    '```typescript',
    fn.signature,
    '```',
    '',
    fn.jsdoc,
  ];
  return parts.join('\n') + '\n';
}

/**
 * Compares an exported function's current signature and JSDoc against its
 * corresponding documentation section.
 *
 * @param fn - The exported function extracted from the diff.
 * @param section - The documentation section located for that function.
 * @returns
 *   - `'not-found'` — `section.target` is `'not-found'`; no section exists.
 *   - `'current'`   — the section content matches the canonical rendering
 *                     (whitespace-normalised).
 *   - `'stale'`     — the section exists but the signature or JSDoc differs.
 */
export function compareDrift(fn: ExportedFunction, section: DocSection): ComparisonResult {
  if (section.target === 'not-found') {
    return 'not-found';
  }

  const expected = normalise(renderCanonical(fn));
  const actual = normalise(section.sectionContent);

  return expected === actual ? 'current' : 'stale';
}
