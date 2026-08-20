/**
 * Unit tests for DriftDetector (T-07).
 *
 * All tests use in-memory TypeScript fixture strings — no real files are
 * read from disk during these tests. `simple-git` is mocked so that
 * `git.show()` returns controlled base content; `fs/promises.readFile` is
 * mocked to return controlled head content.
 *
 * Acceptance criteria verified:
 * - Function present only in head → `changeType: 'added'`
 * - Function present in both with differing signature or JSDoc → `changeType: 'modified'`
 * - Function identical in both → not returned
 * - Three overload declarations → one ExportedFunction with implementation signature
 * - `git.show()` called with `${sha}^1:${filePath}` (sha^1 prefix)
 * - Non-`.ts` paths are silently skipped
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist mocks so they are available in the vi.mock factory closures
// ---------------------------------------------------------------------------

const mockShow = vi.hoisted(() =>
  vi.fn<[string[]], Promise<string>>(),
);

vi.mock('simple-git', () => ({
  simpleGit: () => ({ show: mockShow }),
}));

const mockReadFile = vi.hoisted(() =>
  vi.fn<[string, string], Promise<string>>(),
);

vi.mock('fs/promises', () => ({
  readFile: mockReadFile,
}));

// Must be imported AFTER the vi.mock declarations
import { detectDrift } from '../../src/drift-detector/index.js';

// ---------------------------------------------------------------------------
// TypeScript fixture strings — in-memory content for base and head versions
// ---------------------------------------------------------------------------

/** Plain exported function with JSDoc. */
const FIXTURE_PLAIN_FUNCTION = `
/**
 * Greets a person by name.
 *
 * @param name - The name of the person to greet.
 * @returns A greeting string.
 */
export function greet(name: string): string {
  return \`Hello, \${name}!\`;
}
`;

/** Same plain function with a modified JSDoc (used as base in "modified" tests). */
const FIXTURE_PLAIN_FUNCTION_OLD_JSDOC = `
/**
 * Says hello.
 *
 * @param name - The name.
 * @returns A string.
 */
export function greet(name: string): string {
  return \`Hello, \${name}!\`;
}
`;

/** Same function with a changed parameter signature (used as base in "modified" tests). */
const FIXTURE_PLAIN_FUNCTION_OLD_SIGNATURE = `
/**
 * Greets a person by name.
 *
 * @param name - The name of the person to greet.
 * @returns A greeting string.
 */
export function greet(name: string, salutation?: string): string {
  return \`\${salutation ?? 'Hello'}, \${name}!\`;
}
`;

/** New function that exists only in head (never in base). */
const FIXTURE_NEW_FUNCTION = `
/**
 * Calculates the sum of two numbers.
 *
 * @param a - The first operand.
 * @param b - The second operand.
 * @returns The arithmetic sum of \`a\` and \`b\`.
 */
export function add(a: number, b: number): number {
  return a + b;
}
`;

/** Overloaded function: two overload signatures + one implementation signature. */
const FIXTURE_OVERLOADED_FUNCTION = `
/** Parses a string input into a number. */
export function parse(input: string): number;
/** Parses a Buffer input into a number. */
export function parse(input: Buffer): number;
/**
 * Parses a string or Buffer input into a number.
 *
 * @param input - The value to parse.
 * @returns The numeric result.
 */
export function parse(input: string | Buffer): number {
  if (typeof input === 'string') {
    return parseInt(input, 10);
  }
  return input.readInt32BE(0);
}
`;

/** Base version of the overloaded function (single overload + implementation, different). */
const FIXTURE_OVERLOADED_FUNCTION_BASE = `
/** Parses a string input into a number. */
export function parse(input: string): number;
/**
 * Parses a string input into a number.
 *
 * @param input - The string to parse.
 * @returns The numeric result.
 */
export function parse(input: string): number {
  return parseInt(input, 10);
}
`;

/** A TypeScript file that has no exported functions. */
const FIXTURE_EMPTY = `
// No exported functions here.
const internal = () => {};
`;

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

const FILE_PATH = 'src/utils.ts';
const SHA = 'abc123def456';

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockShow.mockReset();
  mockReadFile.mockReset();
});

// ---------------------------------------------------------------------------
// changeType: 'added' — function present only in head
// ---------------------------------------------------------------------------

describe('detectDrift — added functions', () => {
  it('classifies a new function as added when base is empty', async () => {
    mockShow.mockResolvedValue('');
    mockReadFile.mockResolvedValue(FIXTURE_NEW_FUNCTION);

    const results = await detectDrift([FILE_PATH], SHA);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      name: 'add',
      changeType: 'added',
      sourceFilePath: FILE_PATH,
    });
  });

  it('classifies a new function as added when base file throws (new file)', async () => {
    mockShow.mockRejectedValue(new Error('fatal: Path not found'));
    mockReadFile.mockResolvedValue(FIXTURE_NEW_FUNCTION);

    const results = await detectDrift([FILE_PATH], SHA);

    expect(results).toHaveLength(1);
    expect(results[0].changeType).toBe('added');
    expect(results[0].name).toBe('add');
  });

  it('populates signature and jsdoc for an added function', async () => {
    mockShow.mockResolvedValue('');
    mockReadFile.mockResolvedValue(FIXTURE_NEW_FUNCTION);

    const results = await detectDrift([FILE_PATH], SHA);

    const fn = results[0];
    expect(fn.signature).toContain('export function add');
    expect(fn.signature).not.toContain('return a + b'); // no body in signature
    expect(fn.jsdoc).toContain('Calculates the sum of two numbers');
  });
});

// ---------------------------------------------------------------------------
// changeType: 'modified' — function present in both but changed
// ---------------------------------------------------------------------------

describe('detectDrift — modified functions', () => {
  it('classifies a function as modified when JSDoc changes', async () => {
    mockShow.mockResolvedValue(FIXTURE_PLAIN_FUNCTION_OLD_JSDOC);
    mockReadFile.mockResolvedValue(FIXTURE_PLAIN_FUNCTION);

    const results = await detectDrift([FILE_PATH], SHA);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      name: 'greet',
      changeType: 'modified',
      sourceFilePath: FILE_PATH,
    });
  });

  it('classifies a function as modified when signature changes', async () => {
    mockShow.mockResolvedValue(FIXTURE_PLAIN_FUNCTION_OLD_SIGNATURE);
    mockReadFile.mockResolvedValue(FIXTURE_PLAIN_FUNCTION);

    const results = await detectDrift([FILE_PATH], SHA);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      name: 'greet',
      changeType: 'modified',
    });
    // Head signature should not contain the old `salutation` parameter
    expect(results[0].signature).not.toContain('salutation');
  });

  it('returns the head signature and jsdoc (not base) for a modified function', async () => {
    mockShow.mockResolvedValue(FIXTURE_PLAIN_FUNCTION_OLD_JSDOC);
    mockReadFile.mockResolvedValue(FIXTURE_PLAIN_FUNCTION);

    const results = await detectDrift([FILE_PATH], SHA);

    expect(results[0].jsdoc).toContain('Greets a person by name');
    expect(results[0].jsdoc).not.toContain('Says hello');
  });
});

// ---------------------------------------------------------------------------
// Identical functions — must NOT be returned
// ---------------------------------------------------------------------------

describe('detectDrift — identical functions (not returned)', () => {
  it('does not return a function whose signature and JSDoc are unchanged', async () => {
    mockShow.mockResolvedValue(FIXTURE_PLAIN_FUNCTION);
    mockReadFile.mockResolvedValue(FIXTURE_PLAIN_FUNCTION);

    const results = await detectDrift([FILE_PATH], SHA);

    expect(results).toHaveLength(0);
  });

  it('returns no results when both base and head have no exported functions', async () => {
    mockShow.mockResolvedValue(FIXTURE_EMPTY);
    mockReadFile.mockResolvedValue(FIXTURE_EMPTY);

    const results = await detectDrift([FILE_PATH], SHA);

    expect(results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Overload deduplication (F-9)
// ---------------------------------------------------------------------------

describe('detectDrift — overload deduplication (F-9)', () => {
  it('collapses three declarations to one ExportedFunction entry', async () => {
    mockShow.mockResolvedValue('');
    mockReadFile.mockResolvedValue(FIXTURE_OVERLOADED_FUNCTION);

    const results = await detectDrift([FILE_PATH], SHA);

    // Must produce exactly one entry for "parse"
    const parseEntries = results.filter((r) => r.name === 'parse');
    expect(parseEntries).toHaveLength(1);
  });

  it('uses the implementation signature (last declaration) for an overloaded function', async () => {
    mockShow.mockResolvedValue('');
    mockReadFile.mockResolvedValue(FIXTURE_OVERLOADED_FUNCTION);

    const results = await detectDrift([FILE_PATH], SHA);

    const fn = results.find((r) => r.name === 'parse');
    expect(fn).toBeDefined();
    // Implementation signature takes string | Buffer, not just string or Buffer
    expect(fn!.signature).toContain('string | Buffer');
    // Must NOT contain the body
    expect(fn!.signature).not.toContain('parseInt');
  });

  it('uses JSDoc from the implementation declaration for an overloaded function', async () => {
    mockShow.mockResolvedValue('');
    mockReadFile.mockResolvedValue(FIXTURE_OVERLOADED_FUNCTION);

    const results = await detectDrift([FILE_PATH], SHA);

    const fn = results.find((r) => r.name === 'parse');
    expect(fn!.jsdoc).toContain('Parses a string or Buffer input');
  });

  it('treats an overloaded function as modified when implementation signature changes', async () => {
    mockShow.mockResolvedValue(FIXTURE_OVERLOADED_FUNCTION_BASE);
    mockReadFile.mockResolvedValue(FIXTURE_OVERLOADED_FUNCTION);

    const results = await detectDrift([FILE_PATH], SHA);

    const fn = results.find((r) => r.name === 'parse');
    expect(fn).toBeDefined();
    expect(fn!.changeType).toBe('modified');
    expect(fn!.signature).toContain('string | Buffer');
  });
});

// ---------------------------------------------------------------------------
// git.show() uses sha^1:<filePath> prefix (F-4)
// ---------------------------------------------------------------------------

describe('detectDrift — git show sha^1 prefix (F-4)', () => {
  it('calls git.show with sha^1:<filePath> format', async () => {
    mockShow.mockResolvedValue('');
    mockReadFile.mockResolvedValue(FIXTURE_PLAIN_FUNCTION);

    await detectDrift([FILE_PATH], SHA);

    expect(mockShow).toHaveBeenCalledOnce();
    expect(mockShow).toHaveBeenCalledWith([`${SHA}^1:${FILE_PATH}`]);
  });

  it('calls git.show once per changed .ts file', async () => {
    mockShow.mockResolvedValue('');
    mockReadFile.mockResolvedValue(FIXTURE_PLAIN_FUNCTION);

    const paths = ['src/a.ts', 'src/b.ts'];
    await detectDrift(paths, SHA);

    expect(mockShow).toHaveBeenCalledTimes(2);
    expect(mockShow).toHaveBeenCalledWith([`${SHA}^1:src/a.ts`]);
    expect(mockShow).toHaveBeenCalledWith([`${SHA}^1:src/b.ts`]);
  });
});

// ---------------------------------------------------------------------------
// Non-.ts paths are silently skipped
// ---------------------------------------------------------------------------

describe('detectDrift — file path filtering', () => {
  it('skips non-.ts files without calling git or readFile', async () => {
    const results = await detectDrift(['src/styles.css', 'docs/README.md'], SHA);

    expect(results).toHaveLength(0);
    expect(mockShow).not.toHaveBeenCalled();
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  it('processes .ts files but skips non-.ts files in a mixed list', async () => {
    mockShow.mockResolvedValue('');
    mockReadFile.mockResolvedValue(FIXTURE_PLAIN_FUNCTION);

    await detectDrift(['src/utils.ts', 'src/styles.css'], SHA);

    // git.show should only be called for the .ts file
    expect(mockShow).toHaveBeenCalledOnce();
    expect(mockShow).toHaveBeenCalledWith([`${SHA}^1:src/utils.ts`]);
  });
});

// ---------------------------------------------------------------------------
// Signature and JSDoc extraction edge cases
// ---------------------------------------------------------------------------

describe('detectDrift — signature extraction', () => {
  it('does not include the function body in the signature', async () => {
    mockShow.mockResolvedValue('');
    mockReadFile.mockResolvedValue(FIXTURE_PLAIN_FUNCTION);

    const results = await detectDrift([FILE_PATH], SHA);

    expect(results[0].signature).not.toContain('Hello');      // no body content
    expect(results[0].signature).not.toContain('{');          // no opening brace
    expect(results[0].signature).not.toContain('}');          // no closing brace
  });

  it('extracts empty jsdoc string when function has no JSDoc comment', async () => {
    const noJsDoc = `
export function bare(x: number): void {
  console.log(x);
}
`;
    mockShow.mockResolvedValue('');
    mockReadFile.mockResolvedValue(noJsDoc);

    const results = await detectDrift([FILE_PATH], SHA);

    expect(results).toHaveLength(1);
    expect(results[0].jsdoc).toBe('');
  });
});
