/**
 * Unit tests for T-08 — DocLocator, Markdown path.
 *
 * Acceptance criteria verified:
 * - Returns correct sectionStartOffset / sectionEndOffset for a heading in a
 *   fixture .md file.
 * - Returns target: 'not-found' when no heading matches.
 * - Searches across multiple .md files and returns the first match.
 * - resolveScaffoldTarget: docs/<base>.md lookup, docs/<dir>.md fallback, and
 *   DOCS_DEFAULT_FILE / 'docs/api.md' final fallback.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import * as fs from 'node:fs';
import {
  locateMarkdownSection,
  resolveScaffoldTarget,
} from '../../src/doc-locator/index.js';

// ---------------------------------------------------------------------------
// Path helpers (ESM-compatible __dirname equivalent)
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Absolute path to the test fixture docs directory. */
const FIXTURE_DOCS_DIR = resolve(__dirname, '../fixtures/docs');

/**
 * Glob pattern that targets only the test fixture docs, not the real
 * project docs/ directory. Relative to the project root (Vitest CWD).
 */
const FIXTURE_GLOB = 'test/fixtures/docs/**/*.md';

// ---------------------------------------------------------------------------
// locateMarkdownSection
// ---------------------------------------------------------------------------

describe('locateMarkdownSection', () => {
  // -------------------------------------------------------------------------
  // Happy path — heading found in api.md
  // -------------------------------------------------------------------------

  describe('when the heading exists', () => {
    it('returns target: markdown for a known heading', async () => {
      const result = await locateMarkdownSection('fetchUser', FIXTURE_GLOB);
      expect(result.target).toBe('markdown');
      expect(result.functionName).toBe('fetchUser');
    });

    it('populates markdownFilePath with the matching file path', async () => {
      const result = await locateMarkdownSection('fetchUser', FIXTURE_GLOB);
      expect(result.markdownFilePath).toBeDefined();
      expect(result.markdownFilePath).toMatch(/api\.md$/);
    });

    it('returns correct sectionStartOffset pointing to the ## heading', async () => {
      const result = await locateMarkdownSection('fetchUser', FIXTURE_GLOB);

      const raw = readFileSync(result.markdownFilePath!, 'utf8');
      const start = result.sectionStartOffset!;

      // The character at the start offset must be '#'.
      expect(raw[start]).toBe('#');
      // The slice from the offset must begin with the heading.
      expect(raw.slice(start, start + 13)).toBe('## fetchUser\n');
    });

    it('returns correct sectionEndOffset equal to the start of the next ## heading', async () => {
      const result = await locateMarkdownSection('fetchUser', FIXTURE_GLOB);

      const raw = readFileSync(result.markdownFilePath!, 'utf8');
      const expectedEnd = raw.indexOf('## createUser');

      expect(result.sectionEndOffset).toBe(expectedEnd);
    });

    it('sectionContent equals raw.slice(sectionStartOffset, sectionEndOffset)', async () => {
      const result = await locateMarkdownSection('fetchUser', FIXTURE_GLOB);

      const raw = readFileSync(result.markdownFilePath!, 'utf8');
      const expected = raw.slice(result.sectionStartOffset!, result.sectionEndOffset!);

      expect(result.sectionContent).toBe(expected);
    });

    it('sectionContent contains the heading text and body but not the next heading', async () => {
      const result = await locateMarkdownSection('fetchUser', FIXTURE_GLOB);

      expect(result.sectionContent).toMatch(/^## fetchUser/);
      expect(result.sectionContent).toContain('Fetches a user');
      expect(result.sectionContent).not.toContain('## createUser');
    });
  });

  // -------------------------------------------------------------------------
  // Last section in file — sectionEndOffset === file length
  // -------------------------------------------------------------------------

  describe('last heading in file', () => {
    it('sets sectionEndOffset to the file length for the last heading', async () => {
      const result = await locateMarkdownSection('createUser', FIXTURE_GLOB);

      expect(result.target).toBe('markdown');
      const raw = readFileSync(result.markdownFilePath!, 'utf8');
      expect(result.sectionEndOffset).toBe(raw.length);
    });

    it('sectionContent for last heading equals the tail of the raw file', async () => {
      const result = await locateMarkdownSection('createUser', FIXTURE_GLOB);

      const raw = readFileSync(result.markdownFilePath!, 'utf8');
      expect(result.sectionContent).toBe(
        raw.slice(result.sectionStartOffset!, result.sectionEndOffset!),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Cross-file search — heading found in utils.md
  // -------------------------------------------------------------------------

  describe('cross-file search', () => {
    it('finds a heading in utils.md (second fixture file)', async () => {
      const result = await locateMarkdownSection('formatDate', FIXTURE_GLOB);

      expect(result.target).toBe('markdown');
      expect(result.markdownFilePath).toMatch(/utils\.md$/);
      expect(result.sectionContent).toMatch(/^## formatDate/);
    });

    it('sectionContent for formatDate ends before parseDate heading', async () => {
      const result = await locateMarkdownSection('formatDate', FIXTURE_GLOB);

      expect(result.sectionContent).not.toContain('## parseDate');
      expect(result.sectionContent).toContain('Formats a date');
    });
  });

  // -------------------------------------------------------------------------
  // Not-found case
  // -------------------------------------------------------------------------

  describe('when no heading matches', () => {
    it('returns target: not-found', async () => {
      const result = await locateMarkdownSection('nonExistentFunction', FIXTURE_GLOB);
      expect(result.target).toBe('not-found');
    });

    it('preserves the functionName in the not-found sentinel', async () => {
      const result = await locateMarkdownSection('nonExistentFunction', FIXTURE_GLOB);
      expect(result.functionName).toBe('nonExistentFunction');
    });

    it('returns empty sectionContent', async () => {
      const result = await locateMarkdownSection('nonExistentFunction', FIXTURE_GLOB);
      expect(result.sectionContent).toBe('');
    });

    it('does not set markdownFilePath', async () => {
      const result = await locateMarkdownSection('nonExistentFunction', FIXTURE_GLOB);
      expect(result.markdownFilePath).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Default glob — using real docs/ (just verifies the function runs cleanly)
  // -------------------------------------------------------------------------

  describe('default glob behaviour', () => {
    it('returns not-found without errors when using the default glob and name is absent', async () => {
      // This exercises the default docsGlob = 'docs/**/*.md' against the
      // real project docs directory. The function name is chosen to be
      // deliberately absent from all project docs.
      const result = await locateMarkdownSection('__noSuchFunctionT08Test__');
      expect(result.target).toBe('not-found');
      expect(result.sectionContent).toBe('');
    });
  });
});

// ---------------------------------------------------------------------------
// resolveScaffoldTarget
// ---------------------------------------------------------------------------

describe('resolveScaffoldTarget', () => {
  /**
   * Saved value of DOCS_DEFAULT_FILE so each test can restore it.
   * Using beforeEach / afterEach keeps tests hermetic.
   */
  let savedDefaultFile: string | undefined;

  beforeEach(() => {
    savedDefaultFile = process.env['DOCS_DEFAULT_FILE'];
  });

  afterEach(() => {
    if (savedDefaultFile === undefined) {
      delete process.env['DOCS_DEFAULT_FILE'];
    } else {
      process.env['DOCS_DEFAULT_FILE'] = savedDefaultFile;
    }
  });

  // -------------------------------------------------------------------------
  // Step 1 — docs/<base>.md match
  //
  // Uses src/foo/requirements.ts as the source path because docs/requirements.md
  // is a known-existing file in this project, letting us test the first
  // heuristic branch (docs/<base>.md) without creating extra fixture files.
  // -------------------------------------------------------------------------

  describe('step 1 — docs/<base>.md exists', () => {
    it('returns docs/<base>.md when docs/<basename>.md exists', () => {
      // docs/requirements.md exists in this project
      const result = resolveScaffoldTarget('src/foo/requirements.ts');
      expect(result).toBe('docs/requirements.md');
    });

    it('handles Windows-style backslash separators for the base-name lookup', () => {
      // Same heuristic, Windows path
      const result = resolveScaffoldTarget('src\\foo\\requirements.ts');
      expect(result).toBe('docs/requirements.md');
    });
  });

  // -------------------------------------------------------------------------
  // Step 2 — docs/<dir>.md match (docs/<base>.md is absent)
  //
  // src/architecture/index.ts:
  //   - docs/index.md does NOT exist in this project
  //   - docs/architecture.md DOES exist
  // -------------------------------------------------------------------------

  describe('step 2 — docs/<dir>.md exists (docs/<base>.md absent)', () => {
    it('falls back to docs/<dir>.md when docs/<base>.md is absent', () => {
      // docs/index.md does not exist; docs/architecture.md does
      const result = resolveScaffoldTarget('src/architecture/index.ts');
      expect(result).toBe('docs/architecture.md');
    });
  });

  // -------------------------------------------------------------------------
  // Step 3 — DOCS_DEFAULT_FILE fallback
  //
  // src/zzz/quux.ts maps to docs/quux.md (absent) and docs/zzz.md (absent),
  // so the function must reach the fallback branch.
  // -------------------------------------------------------------------------

  describe('step 3 — fallback when neither derived path exists', () => {
    it('returns the DOCS_DEFAULT_FILE env-var value when set', () => {
      process.env['DOCS_DEFAULT_FILE'] = 'docs/custom-api.md';

      const result = resolveScaffoldTarget('src/zzz/quux.ts');

      expect(result).toBe('docs/custom-api.md');
    });

    it("falls back to 'docs/api.md' when DOCS_DEFAULT_FILE is not set", () => {
      delete process.env['DOCS_DEFAULT_FILE'];

      const result = resolveScaffoldTarget('src/zzz/quux.ts');

      expect(result).toBe('docs/api.md');
    });
  });

  // -------------------------------------------------------------------------
  // Fixture-file path: purely synthetic, confirms the logic for any path
  // when neither docs/<base>.md nor docs/<dir>.md exists.
  // -------------------------------------------------------------------------

  describe('resolves correctly for arbitrary non-matching paths', () => {
    it('uses the fallback for a path with no matching docs file', () => {
      delete process.env['DOCS_DEFAULT_FILE'];

      // Neither docs/locator.md nor docs/doc-locator.md exists
      const result = resolveScaffoldTarget('src/doc-locator/locator.ts');
      expect(result).toBe('docs/api.md');
    });
  });
});
