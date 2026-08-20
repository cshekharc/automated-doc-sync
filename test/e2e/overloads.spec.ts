/**
 * E2E scenario: TypeScript Function Overloads Deduplication (F-9)
 *
 * When the DriftDetector processes a TypeScript file that contains three
 * declarations for the same function name (two overload signatures + one
 * implementation), it must collapse them into a **single** `ExportedFunction`
 * entry whose `signature` field holds only the implementation signature (last
 * declaration). Overload-only declarations are discarded.
 *
 * This spec exercises the real `detectDrift` implementation (not mocked) by
 * letting the full pipeline flow with a controlled fixture as the HEAD file
 * content. The `simple-git` mock returns an empty base (simulating a new file)
 * so all functions are classified as `'added'`.
 *
 * F-9 acceptance criterion verified.
 * MOCK_API_MODE=true — no real git or filesystem calls.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// ---------------------------------------------------------------------------
// Read the overloaded-function fixture at module level (before vi.mock hoisting)
// We read it synchronously now so that the fs/promises mock below can return it.
// ---------------------------------------------------------------------------

const OVERLOADED_FIXTURE_PATH = join(
  process.cwd(),
  'test',
  'fixtures',
  'typescript',
  'overloaded-function.ts',
);
const OVERLOADED_FIXTURE_CONTENT = readFileSync(OVERLOADED_FIXTURE_PATH, 'utf-8');

// ---------------------------------------------------------------------------
// Hoisted mock state
// ---------------------------------------------------------------------------

const mockRollbackInstance = vi.hoisted(() => ({
  register: vi.fn(),
  rollback: vi.fn<[], Promise<void>>().mockResolvedValue(undefined),
}));

const mockValidateTrigger = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    mergeSha: 'sha-overloads-test-abcdef123456',
    baseSha: 'sha-overloads-test-abcdef123456^1',
    changedFiles: ['src/overloaded.ts'],
    owner: 'testowner',
    repo: 'testrepo',
  }),
);

/** simple-git mock — show() returns '' so all head functions are 'added'. */
const mockGitShow = vi.hoisted(() =>
  vi.fn<[string[]], Promise<string>>().mockResolvedValue(''),
);

/** fs/promises.readFile mock — returns the overloaded fixture for any path. */
const mockReadFile = vi.hoisted(() =>
  vi.fn<[string, string], Promise<string>>(),
);

const mockLocateMarkdownSection = vi.hoisted(() => vi.fn());
const mockLocateConfluenceSection = vi.hoisted(() => vi.fn());

const mockGitPublisherInstance = vi.hoisted(() => ({
  createSyncBranch: vi.fn<[string, unknown], Promise<void>>().mockResolvedValue(undefined),
  writeDocFile: vi.fn<[string, string, unknown], Promise<void>>().mockResolvedValue(undefined),
  createDefaultDocFile: vi.fn<[string, unknown], Promise<void>>().mockResolvedValue(undefined),
  commitAndPush: vi.fn<[string[], string], Promise<void>>().mockResolvedValue(undefined),
  createPR: vi
    .fn<[unknown], Promise<string>>()
    .mockResolvedValue('https://github.com/testowner/testrepo/pull/30'),
}));

const mockConfluencePublisherInstance = vi.hoisted(() => ({
  fetchPage: vi.fn().mockResolvedValue({ body: '', version: 1, title: 'Docs' }),
  writeDraft: vi.fn<[string, string, number, unknown], Promise<void>>().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Module mocks
// detectDrift is NOT mocked — the real implementation runs to test F-9.
// ---------------------------------------------------------------------------

vi.mock('../../src/rollback-manager.js', () => ({
  RollbackManager: vi.fn().mockImplementation(() => mockRollbackInstance),
}));

vi.mock('../../src/trigger-validator.js', () => ({
  validateTrigger: mockValidateTrigger,
}));

// simple-git: show() returns empty string → new file → all functions 'added'
vi.mock('simple-git', () => ({
  simpleGit: () => ({ show: mockGitShow }),
}));

// fs/promises: readFile returns the overloaded fixture content for the source file
vi.mock('fs/promises', () => ({
  readFile: mockReadFile,
}));

// DocLocator: both return not-found (overloads are new functions being scaffolded)
vi.mock('../../src/doc-locator/index.js', () => ({
  locateMarkdownSection: mockLocateMarkdownSection,
  locateConfluenceSection: mockLocateConfluenceSection,
  resolveScaffoldTarget: vi.fn().mockReturnValue('docs/api.md'),
}));

vi.mock('../../src/drift-comparator.js', () => ({
  // The real compareDrift would return 'not-found' for a not-found section.
  // Mock it to return 'not-found' directly for simplicity.
  compareDrift: vi.fn().mockReturnValue('not-found'),
}));

vi.mock('../../src/regenerator/index.js', () => ({
  regenerateMarkdownSection: vi.fn().mockReturnValue('updated'),
  regenerateConfluenceSection: vi.fn().mockReturnValue('<h2>fn</h2>'),
  buildScaffoldSection: vi.fn().mockReturnValue('## parse\n\nnew fn.\n'),
}));

vi.mock('../../src/confluence-publisher/index.js', () => ({
  ConfluencePublisher: vi.fn().mockImplementation(() => mockConfluencePublisherInstance),
}));

vi.mock('../../src/git-publisher/index.js', () => ({
  GitPublisher: vi.fn().mockImplementation(() => mockGitPublisherInstance),
}));

// ---------------------------------------------------------------------------
// Import under test (AFTER vi.mock declarations)
// detectDrift is imported via pipeline.ts → drift-detector/index.ts
// ---------------------------------------------------------------------------

import { run } from '../../src/pipeline.js';

// ---------------------------------------------------------------------------
// Environment and spy management
// ---------------------------------------------------------------------------

const MANAGED_ENV_VARS = [
  'MOCK_API_MODE',
  'CONFLUENCE_PAGE_ID',
  'GITHUB_SHA',
  'GITHUB_REPOSITORY',
] as const;

const savedEnv: Partial<typeof MANAGED_ENV_VARS[number] extends string ? Record<string, string> : never> = {};

let exitSpy: ReturnType<typeof vi.spyOn>;
let consoleLogSpy: ReturnType<typeof vi.spyOn>;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  for (const key of MANAGED_ENV_VARS) {
    (savedEnv as Record<string, string | undefined>)[key] = process.env[key];
  }

  process.env['MOCK_API_MODE'] = 'true';
  delete process.env['CONFLUENCE_PAGE_ID'];
  process.env['GITHUB_SHA'] = 'sha-overloads-test-abcdef123456';
  process.env['GITHUB_REPOSITORY'] = 'testowner/testrepo';

  // Resets
  mockRollbackInstance.register.mockReset();
  mockRollbackInstance.rollback.mockReset().mockResolvedValue(undefined);

  mockValidateTrigger.mockReset().mockResolvedValue({
    mergeSha: 'sha-overloads-test-abcdef123456',
    baseSha: 'sha-overloads-test-abcdef123456^1',
    changedFiles: ['src/overloaded.ts'],
    owner: 'testowner',
    repo: 'testrepo',
  });

  // git.show returns '' → file is new, all functions are 'added'
  mockGitShow.mockReset().mockResolvedValue('');

  // readFile returns the overloaded fixture when reading the source file;
  // returns '' for other paths (e.g., docs files)
  mockReadFile.mockReset().mockImplementation(async (filePath: string) => {
    if (filePath === 'src/overloaded.ts') {
      return OVERLOADED_FIXTURE_CONTENT;
    }
    return '';
  });

  // Both locators return not-found (the 'parse' function is new)
  mockLocateMarkdownSection.mockReset().mockResolvedValue({
    functionName: 'parse',
    target: 'not-found',
    sectionContent: '',
  });
  mockLocateConfluenceSection.mockReset().mockResolvedValue({
    functionName: 'parse',
    target: 'not-found',
    sectionContent: '',
  });

  mockGitPublisherInstance.createSyncBranch.mockReset().mockResolvedValue(undefined);
  mockGitPublisherInstance.writeDocFile.mockReset().mockResolvedValue(undefined);
  mockGitPublisherInstance.createDefaultDocFile.mockReset().mockResolvedValue(undefined);
  mockGitPublisherInstance.commitAndPush.mockReset().mockResolvedValue(undefined);
  mockGitPublisherInstance.createPR
    .mockReset()
    .mockResolvedValue('https://github.com/testowner/testrepo/pull/30');

  mockConfluencePublisherInstance.fetchPage.mockReset().mockResolvedValue({
    body: '',
    version: 1,
    title: 'Docs',
  });
  mockConfluencePublisherInstance.writeDraft.mockReset().mockResolvedValue(undefined);

  exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: number) => {
    throw new Error(`process.exit(${code ?? 0})`);
  }) as ReturnType<typeof vi.spyOn>;

  consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  exitSpy.mockRestore();
  consoleLogSpy.mockRestore();
  consoleErrorSpy.mockRestore();

  for (const key of MANAGED_ENV_VARS) {
    const saved = (savedEnv as Record<string, string | undefined>)[key];
    if (saved === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved;
    }
  }

  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('e2e: overloads — 3 overload declarations collapse to 1 ExportedFunction (F-9)', () => {
  it('processes exactly one ExportedFunction for the overloaded "parse" function', async () => {
    await run();

    // locateMarkdownSection is called once per ExportedFunction detected by
    // detectDrift. If overload deduplication works, it should be called exactly
    // once (for 'parse'), not three times (once per overload declaration).
    expect(mockLocateMarkdownSection).toHaveBeenCalledOnce();
  });

  it('passes only the function name "parse" to locateMarkdownSection', async () => {
    await run();

    const [functionName] = mockLocateMarkdownSection.mock.calls[0] as [string];
    expect(functionName).toBe('parse');
  });

  it('scaffolds a single section for "parse" (not three sections for each overload)', async () => {
    await run();

    const resultCall = consoleLogSpy.mock.calls.find(
      (args) => typeof args[0] === 'string' && (args[0] as string).includes('triggerCommitSha'),
    );
    expect(resultCall).toBeDefined();
    const parsed = JSON.parse(resultCall![0] as string) as Record<string, unknown>;

    // Exactly one scaffolded entry for 'parse'
    const scaffolded = parsed['scaffolded'] as Array<{ name: string }>;
    expect(scaffolded).toHaveLength(1);
    expect(scaffolded[0].name).toBe('parse');
  });

  it('emits the implementation signature (contains "string | Buffer"), not an overload-only signature', async () => {
    await run();

    // locateMarkdownSection was called with 'parse' (the deduplicated function name).
    // The detectDrift output should have had the implementation signature.
    // We verify via git.show being called with the sha^1 argument (detectDrift ran).
    expect(mockGitShow).toHaveBeenCalledWith(
      expect.arrayContaining([expect.stringContaining('sha-overloads-test-abcdef123456^1')]),
    );

    // The function passed to buildScaffoldSection should have the implementation signature
    const { buildScaffoldSection } = await import('../../src/regenerator/index.js');
    const buildCalls = (buildScaffoldSection as ReturnType<typeof vi.fn>).mock.calls as Array<
      [{ name: string; signature: string; changeType: string }]
    >;
    expect(buildCalls).toHaveLength(1);
    const fn = buildCalls[0][0];
    expect(fn.name).toBe('parse');
    // Implementation signature contains 'string | Buffer', overload-only signatures do not
    expect(fn.signature).toContain('string | Buffer');
  });
});
