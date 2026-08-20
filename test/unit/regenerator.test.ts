/**
 * Unit tests for SectionRegenerator (T-06).
 *
 * Acceptance criteria verified:
 * - AC-3: rawFile.slice(0, sectionStart) prefix is byte-for-byte identical to original.
 * - AC-3: rawFile.slice(sectionEnd) suffix is byte-for-byte identical to original.
 * - remark-stringify is not imported anywhere in src/regenerator/index.ts (static check).
 * - buildScaffoldSection output matches the canonical template from architecture §4 Step 6.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  buildScaffoldSection,
  regenerateMarkdownSection,
  regenerateConfluenceSection,
} from '../../src/regenerator/index.js';
import type { DocSection, ExportedFunction } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Helpers to locate the source file for static content checks
// ---------------------------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const regeneratorSource = readFileSync(
  join(__dirname, '../../src/regenerator/index.ts'),
  'utf-8'
);

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

/** A minimal ExportedFunction fixture used in most tests. */
const sampleFn: ExportedFunction = {
  name: 'myFunction',
  signature: 'export function myFunction(x: number): string',
  jsdoc: 'Converts a number to a string.',
  sourceFilePath: 'src/utils.ts',
  changeType: 'modified',
};

/** Another function — used in multi-section Markdown tests. */
const otherFn: ExportedFunction = {
  name: 'otherFunction',
  signature: 'export function otherFunction(): void',
  jsdoc: 'Does nothing.',
  sourceFilePath: 'src/utils.ts',
  changeType: 'added',
};

// ---------------------------------------------------------------------------
// Static check: remark-stringify must not be imported
// ---------------------------------------------------------------------------

describe('static constraint: remark-stringify not imported', () => {
  it('does not import "remark-stringify" in src/regenerator/index.ts', () => {
    // The file may MENTION remark-stringify in a comment (to document what is
    // NOT done), but it must never contain an actual import of it.
    // We check for both ESM and CJS import patterns.
    expect(regeneratorSource).not.toMatch(/from\s+['"]remark-stringify['"]/);
    expect(regeneratorSource).not.toMatch(/require\s*\(\s*['"]remark-stringify['"]\s*\)/);
  });
});

// ---------------------------------------------------------------------------
// buildScaffoldSection
// ---------------------------------------------------------------------------

describe('buildScaffoldSection', () => {
  it('returns the canonical heading + typescript fence + jsdoc body template', () => {
    const result = buildScaffoldSection(sampleFn);
    const expected =
      '## myFunction\n\n' +
      '```typescript\n' +
      'export function myFunction(x: number): string\n' +
      '```\n\n' +
      'Converts a number to a string.\n';
    expect(result).toBe(expected);
  });

  it('starts with "## <functionName>"', () => {
    const result = buildScaffoldSection(sampleFn);
    expect(result.startsWith('## myFunction\n')).toBe(true);
  });

  it('contains a typescript fenced code block with the signature', () => {
    const result = buildScaffoldSection(sampleFn);
    expect(result).toContain('```typescript\n' + sampleFn.signature + '\n```');
  });

  it('contains the jsdoc body after the code fence', () => {
    const result = buildScaffoldSection(sampleFn);
    expect(result).toContain('Converts a number to a string.');
  });

  it('trims leading/trailing whitespace from jsdoc', () => {
    const fn: ExportedFunction = { ...sampleFn, jsdoc: '  trimmed jsdoc  ' };
    const result = buildScaffoldSection(fn);
    expect(result).toContain('trimmed jsdoc\n');
    expect(result).not.toContain('  trimmed jsdoc  ');
  });

  it('handles empty jsdoc gracefully', () => {
    const fn: ExportedFunction = { ...sampleFn, jsdoc: '' };
    const result = buildScaffoldSection(fn);
    // Should still have heading and fence; jsdoc section produces an empty body
    expect(result).toContain('## myFunction\n\n');
    expect(result).toContain('```typescript\n');
    // Result ends with newline
    expect(result.endsWith('\n')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// regenerateMarkdownSection — with pre-set offsets (no remark invoked)
// ---------------------------------------------------------------------------

describe('regenerateMarkdownSection with pre-set offsets', () => {
  const prefix = '# Module docs\n\nSome intro text.\n\n';
  const oldSection =
    '## myFunction\n\nOld description.\n\n```typescript\nfunction old(): void\n```\n\n';
  const suffix = '## anotherFunction\n\nAnother section.\n';
  const rawFile = prefix + oldSection + suffix;

  const sectionStart = prefix.length;
  const sectionEnd = prefix.length + oldSection.length;

  const section: DocSection = {
    functionName: 'myFunction',
    target: 'markdown',
    markdownFilePath: 'docs/api.md',
    sectionContent: oldSection,
    sectionStartOffset: sectionStart,
    sectionEndOffset: sectionEnd,
  };

  it('returns a string with the section replaced', () => {
    const result = regenerateMarkdownSection(rawFile, section, sampleFn);
    expect(result).toContain('## myFunction');
    expect(result).toContain('export function myFunction(x: number): string');
    expect(result).not.toContain('Old description.');
    expect(result).not.toContain('function old(): void');
  });

  it('prefix is byte-for-byte identical to original (AC-3)', () => {
    const result = regenerateMarkdownSection(rawFile, section, sampleFn);
    expect(result.startsWith(prefix)).toBe(true);
  });

  it('suffix is byte-for-byte identical to original (AC-3)', () => {
    const result = regenerateMarkdownSection(rawFile, section, sampleFn);
    expect(result.endsWith(suffix)).toBe(true);
  });

  it('prefix extracted from result equals original prefix exactly', () => {
    const result = regenerateMarkdownSection(rawFile, section, sampleFn);
    const newSection = buildScaffoldSection(sampleFn);
    const resultPrefix = result.slice(0, sectionStart);
    expect(resultPrefix).toBe(rawFile.slice(0, sectionStart));
  });

  it('suffix extracted from result equals original suffix exactly', () => {
    const result = regenerateMarkdownSection(rawFile, section, sampleFn);
    const newSection = buildScaffoldSection(sampleFn);
    const resultSuffixStart = sectionStart + newSection.length;
    const resultSuffix = result.slice(resultSuffixStart);
    expect(resultSuffix).toBe(rawFile.slice(sectionEnd));
  });
});

// ---------------------------------------------------------------------------
// regenerateMarkdownSection — without pre-set offsets (remark invoked)
// ---------------------------------------------------------------------------

describe('regenerateMarkdownSection without pre-set offsets (remark fallback)', () => {
  const prefix = '# Module\n\nIntro.\n\n';
  const oldSection =
    '## myFunction\n\nOld content here.\n\n';
  const suffix = '## nextSection\n\nNext section content.\n';
  const rawFile = prefix + oldSection + suffix;

  const section: DocSection = {
    functionName: 'myFunction',
    target: 'markdown',
    sectionContent: oldSection,
    // sectionStartOffset and sectionEndOffset intentionally omitted
  };

  it('uses remark to find offsets and performs the splice', () => {
    const result = regenerateMarkdownSection(rawFile, section, sampleFn);
    expect(result).toContain('export function myFunction(x: number): string');
    expect(result).not.toContain('Old content here.');
  });

  it('prefix is byte-for-byte identical to original (AC-3)', () => {
    const result = regenerateMarkdownSection(rawFile, section, sampleFn);
    expect(result.startsWith(prefix)).toBe(true);
  });

  it('suffix is byte-for-byte identical to original (AC-3)', () => {
    const result = regenerateMarkdownSection(rawFile, section, sampleFn);
    expect(result.endsWith(suffix)).toBe(true);
  });

  it('throws when function heading is not found in Markdown', () => {
    const sectionNotFound: DocSection = {
      functionName: 'nonExistentFunction',
      target: 'markdown',
      sectionContent: '',
    };
    expect(() =>
      regenerateMarkdownSection(rawFile, sectionNotFound, sampleFn)
    ).toThrow(/no heading found for "nonExistentFunction"/i);
  });
});

// ---------------------------------------------------------------------------
// regenerateMarkdownSection — multi-section file to verify correct targeting
// ---------------------------------------------------------------------------

describe('regenerateMarkdownSection with multiple sections', () => {
  const intro = '# API Reference\n\n';
  const section1 =
    '## firstFunction\n\nFirst docs.\n\n```typescript\nexport function firstFunction(): void\n```\n\nSome notes.\n\n';
  const targetSection =
    '## myFunction\n\nOld docs.\n\n```typescript\nexport function myFunction(x: number): string\n```\n\nOld jsdoc.\n\n';
  const section3 =
    '## lastFunction\n\nLast docs.\n\n';
  const rawFile = intro + section1 + targetSection + section3;

  const sectionStart = (intro + section1).length;
  const sectionEnd = sectionStart + targetSection.length;

  const section: DocSection = {
    functionName: 'myFunction',
    target: 'markdown',
    sectionContent: targetSection,
    sectionStartOffset: sectionStart,
    sectionEndOffset: sectionEnd,
  };

  it('only replaces the target section, leaves others untouched', () => {
    const result = regenerateMarkdownSection(rawFile, section, sampleFn);
    expect(result).toContain('## firstFunction\n\nFirst docs.');
    expect(result).toContain('## lastFunction\n\nLast docs.');
    expect(result).not.toContain('Old docs.');
    expect(result).not.toContain('Old jsdoc.');
  });

  it('prefix (intro + section1) is byte-for-byte identical to original', () => {
    const result = regenerateMarkdownSection(rawFile, section, sampleFn);
    expect(result.slice(0, sectionStart)).toBe(rawFile.slice(0, sectionStart));
  });

  it('suffix (section3) is byte-for-byte identical to original', () => {
    const result = regenerateMarkdownSection(rawFile, section, sampleFn);
    const newSection = buildScaffoldSection(sampleFn);
    const resultSuffixStart = sectionStart + newSection.length;
    expect(result.slice(resultSuffixStart)).toBe(rawFile.slice(sectionEnd));
  });
});

// ---------------------------------------------------------------------------
// regenerateConfluenceSection — with pre-set offsets
// ---------------------------------------------------------------------------

describe('regenerateConfluenceSection', () => {
  const prefix = '<div><h1>API Reference</h1>';
  const oldSection = '<h2>myFunction</h2><p>Old description.</p>';
  const suffix = '<h2>otherFunction</h2><p>Other content.</p></div>';
  const rawXhtml = prefix + oldSection + suffix;

  const sectionStart = prefix.length;
  const sectionEnd = prefix.length + oldSection.length;

  const section: DocSection = {
    functionName: 'myFunction',
    target: 'confluence',
    confluencePageId: '32833537',
    sectionContent: oldSection,
    sectionStartOffset: sectionStart,
    sectionEndOffset: sectionEnd,
  };

  it('replaces only the target section with new XHTML content', () => {
    const result = regenerateConfluenceSection(rawXhtml, section, sampleFn);
    expect(result).not.toContain('Old description.');
    expect(result).toContain('myFunction');
  });

  it('prefix is byte-for-byte identical to original (AC-3)', () => {
    const result = regenerateConfluenceSection(rawXhtml, section, sampleFn);
    expect(result.startsWith(prefix)).toBe(true);
  });

  it('suffix is byte-for-byte identical to original (AC-3)', () => {
    const result = regenerateConfluenceSection(rawXhtml, section, sampleFn);
    expect(result.endsWith(suffix)).toBe(true);
  });

  it('prefix extracted from result equals original prefix exactly', () => {
    const result = regenerateConfluenceSection(rawXhtml, section, sampleFn);
    expect(result.slice(0, sectionStart)).toBe(rawXhtml.slice(0, sectionStart));
  });

  it('suffix extracted from result equals original suffix exactly', () => {
    const result = regenerateConfluenceSection(rawXhtml, section, sampleFn);
    // New section length: find where suffix starts in result
    const newSectionStr =
      `<h2>${sampleFn.name}</h2>` +
      `<pre><code class="language-typescript">${sampleFn.signature}</code></pre>` +
      `<p>${sampleFn.jsdoc.trim()}</p>`;
    const resultSuffixStart = sectionStart + newSectionStr.length;
    expect(result.slice(resultSuffixStart)).toBe(rawXhtml.slice(sectionEnd));
  });

  it('throws when sectionStartOffset is missing', () => {
    const sectionNoOffsets: DocSection = {
      functionName: 'myFunction',
      target: 'confluence',
      sectionContent: oldSection,
      // sectionStartOffset and sectionEndOffset intentionally omitted
    };
    expect(() =>
      regenerateConfluenceSection(rawXhtml, sectionNoOffsets, sampleFn)
    ).toThrow(/sectionStartOffset and sectionEndOffset must be set/i);
  });

  it('throws when sectionEndOffset is missing', () => {
    const sectionPartial: DocSection = {
      functionName: 'myFunction',
      target: 'confluence',
      sectionContent: oldSection,
      sectionStartOffset: sectionStart,
      // sectionEndOffset intentionally omitted
    };
    expect(() =>
      regenerateConfluenceSection(rawXhtml, sectionPartial, sampleFn)
    ).toThrow(/sectionStartOffset and sectionEndOffset must be set/i);
  });

  it('contains the function signature in the XHTML output', () => {
    const result = regenerateConfluenceSection(rawXhtml, section, sampleFn);
    expect(result).toContain(sampleFn.signature);
  });

  it('contains the function name as an h2 heading in the XHTML output', () => {
    const result = regenerateConfluenceSection(rawXhtml, section, sampleFn);
    expect(result).toContain(`<h2>${sampleFn.name}</h2>`);
  });
});

// ---------------------------------------------------------------------------
// Edge cases: offsets at boundaries
// ---------------------------------------------------------------------------

describe('edge cases', () => {
  it('regenerateMarkdownSection: section at start of file (sectionStart === 0)', () => {
    const section1 = '## myFunction\n\nOld content.\n\n';
    const rest = '## nextSection\n\nOther content.\n';
    const rawFile = section1 + rest;

    const section: DocSection = {
      functionName: 'myFunction',
      target: 'markdown',
      sectionContent: section1,
      sectionStartOffset: 0,
      sectionEndOffset: section1.length,
    };

    const result = regenerateMarkdownSection(rawFile, section, sampleFn);
    expect(result.slice(0, 0)).toBe(''); // empty prefix — pass through
    expect(result.endsWith(rest)).toBe(true);
    expect(result).toContain('export function myFunction(x: number): string');
  });

  it('regenerateMarkdownSection: section at end of file (sectionEnd === rawFile.length)', () => {
    const intro = '# Docs\n\nIntro.\n\n';
    const section1 = '## myFunction\n\nOld content.\n\n';
    const rawFile = intro + section1;

    const section: DocSection = {
      functionName: 'myFunction',
      target: 'markdown',
      sectionContent: section1,
      sectionStartOffset: intro.length,
      sectionEndOffset: rawFile.length,
    };

    const result = regenerateMarkdownSection(rawFile, section, sampleFn);
    expect(result.slice(0, intro.length)).toBe(intro);
    expect(result).toContain('export function myFunction(x: number): string');
  });

  it('regenerateConfluenceSection: section at start of XHTML string', () => {
    const section1 = '<h2>myFunction</h2><p>Old.</p>';
    const rest = '<h2>other</h2><p>Other.</p>';
    const rawXhtml = section1 + rest;

    const section: DocSection = {
      functionName: 'myFunction',
      target: 'confluence',
      sectionContent: section1,
      sectionStartOffset: 0,
      sectionEndOffset: section1.length,
    };

    const result = regenerateConfluenceSection(rawXhtml, section, sampleFn);
    expect(result.endsWith(rest)).toBe(true);
  });

  it('regenerateMarkdownSection: remark finds correct section when multiple headings share same level', () => {
    const rawFile =
      '## alpha\n\nAlpha content.\n\n## myFunction\n\nOld content.\n\n## gamma\n\nGamma content.\n';

    const section: DocSection = {
      functionName: 'myFunction',
      target: 'markdown',
      sectionContent: '## myFunction\n\nOld content.\n\n',
    };

    const result = regenerateMarkdownSection(rawFile, section, sampleFn);
    expect(result).toContain('## alpha\n\nAlpha content.');
    expect(result).toContain('## gamma\n\nGamma content.');
    expect(result).not.toContain('Old content.');
    expect(result).toContain('export function myFunction(x: number): string');
  });
});
