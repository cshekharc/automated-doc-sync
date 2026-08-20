/**
 * E2E scenario: Rollback — Confluence API Failure
 *
 * When `ConfluencePublisher.writeDraft` fails after registering its undo
 * closure on the `RollbackManager`, the pipeline's catch block calls
 * `rollback()`. The rollback executes the registered undo, which calls
 * `revertToPublished` to discard the partial draft.
 *
 * This spec uses the **real** `RollbackManager` so that the registered undo
 * closure is genuinely executed. The `writeDraft` mock registers a spy undo
 * before throwing, making the revert assertion straightforward.
 *
 * AC-8 acceptance criterion verified.
 * MOCK_API_MODE=true — no real external API calls.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mock state
// NOTE: RollbackManager is NOT mocked — real implementation used.
// ---------------------------------------------------------------------------

const mockValidateTrigger = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    mergeSha: 'sha-rollback-cf-abcdef1234567890',
    baseSha: 'sha-rollback-cf-abcdef1234567890^1',
    changedFiles: ['src/drift-detector/index.ts'],
    owner: 'testowner',
    repo: 'testrepo',
  }),
);

const mockDetectDrift = vi.hoisted(() => vi.fn<[], Promise<unknown[]>>());

const mockLocateMarkdownSection = vi.hoisted(() => vi.fn());
const mockLocateConfluenceSection = vi.hoisted(() => vi.fn());

const mockCompareDrift = vi.hoisted(() => vi.fn<[unknown, { target: string }], string>());

// ConfluencePublisher: writeDraft registers a spy undo then throws.
// fetchPage returns successfully.
const mockConfluencePublisherInstance = vi.hoisted(() => ({
  fetchPage: vi.fn().mockResolvedValue({
    body: '<h2>detectDrift</h2><p>Old docs.</p>',
    version: 5,
    title: 'API Docs',
  }),
  writeDraft: vi.fn<[string, string, number, unknown], Promise<void>>(),
}));

const mockGitPublisherInstance = vi.hoisted(() => ({
  createSyncBranch: vi.fn<[string, unknown], Promise<void>>(),
  writeDocFile: vi.fn<[string, string, unknown], Promise<void>>().mockResolvedValue(undefined),
  createDefaultDocFile: vi.fn<[string, unknown], Promise<void>>().mockResolvedValue(undefined),
  commitAndPush: vi.fn<[string[], string], Promise<void>>().mockResolvedValue(undefined),
  createPR: vi
    .fn<[unknown], Promise<string>>()
    .mockResolvedValue('https://github.com/testowner/testrepo/pull/20'),
}));

const mockReadFile = vi.hoisted(() =>
  vi.fn<[string, string], Promise<string>>().mockResolvedValue(''),
);

// ---------------------------------------------------------------------------
// Module mocks
// RollbackManager is intentionally NOT mocked.
// ---------------------------------------------------------------------------

vi.mock('../../src/trigger-validator.js', () => ({
  validateTrigger: mockValidateTrigger,
}));

vi.mock('../../src/drift-detector/index.js', () => ({
  detectDrift: mockDetectDrift,
}));

vi.mock('../../src/doc-locator/index.js', () => ({
  locateMarkdownSection: mockLocateMarkdownSection,
  locateConfluenceSection: mockLocateConfluenceSection,
  resolveScaffoldTarget: vi.fn().mockReturnValue('docs/api.md'),
}));

vi.mock('../../src/drift-comparator.js', () => ({
  compareDrift: mockCompareDrift,
}));

vi.mock('../../src/regenerator/index.js', () => ({
  regenerateMarkdownSection: vi.fn().mockReturnValue('updated'),
  regenerateConfluenceSection: vi.fn().mockReturnValue(
    '<h2>detectDrift</h2><pre><code>updated</code></pre>',
  ),
  buildScaffoldSection: vi.fn().mockReturnValue('## fn\n'),
}));

vi.mock('../../src/confluence-publisher/index.js', () => ({
  ConfluencePublisher: vi.fn().mockImplementation(() => mockConfluencePublisherInstance),
}));

vi.mock('../../src/git-publisher/index.js', () => ({
  GitPublisher: vi.fn().mockImplementation(() => mockGitPublisherInstance),
}));

vi.mock('fs/promises', () => ({
  readFile: mockReadFile,
}));

// ---------------------------------------------------------------------------
// Import under test
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

const savedEnv: Partial<Record<string, string>> = {};

/** Spy on the Confluence revert undo registered by writeDraft. */
let revertSpy: ReturnType<typeof vi.fn>;

let exitSpy: ReturnType<typeof vi.spyOn>;
let consoleLogSpy: ReturnType<typeof vi.spyOn>;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  for (const key of MANAGED_ENV_VARS) {
    savedEnv[key] = process.env[key];
  }

  process.env['MOCK_API_MODE'] = 'true';
  delete process.env['CONFLUENCE_PAGE_ID'];
  process.env['GITHUB_SHA'] = 'sha-rollback-cf-abcdef1234567890';
  process.env['GITHUB_REPOSITORY'] = 'testowner/testrepo';

  revertSpy = vi.fn().mockResolvedValue(undefined);

  // Resets
  mockValidateTrigger.mockReset().mockResolvedValue({
    mergeSha: 'sha-rollback-cf-abcdef1234567890',
    baseSha: 'sha-rollback-cf-abcdef1234567890^1',
    changedFiles: ['src/drift-detector/index.ts'],
    owner: 'testowner',
    repo: 'testrepo',
  });

  // Modified function with a stale Confluence section
  mockDetectDrift.mockReset().mockResolvedValue([
    {
      name: 'detectDrift',
      signature: 'export async function detectDrift(changedFilePaths: string[], sha: string): Promise<ExportedFunction[]>',
      jsdoc: 'Detects drift in exported TypeScript functions.',
      sourceFilePath: 'src/drift-detector/index.ts',
      changeType: 'modified',
    },
  ]);

  // No markdown section; stale Confluence section
  mockLocateMarkdownSection.mockReset().mockResolvedValue({
    functionName: 'detectDrift',
    target: 'not-found',
    sectionContent: '',
  });

  mockLocateConfluenceSection.mockReset().mockResolvedValue({
    functionName: 'detectDrift',
    target: 'confluence',
    confluencePageId: '32833537',
    confluencePageTitle: 'API Docs',
    confluenceVersionNumber: 5,
    sectionContent: '<h2>detectDrift</h2><p>Old docs.</p>',
    sectionStartOffset: 0,
    sectionEndOffset: 42,
  });

  // not-found for markdown, stale for confluence
  mockCompareDrift.mockReset().mockImplementation((_fn, section: { target: string }) => {
    if (section.target === 'confluence') return 'stale';
    return 'not-found';
  });

  mockReadFile.mockReset().mockResolvedValue('');

  // createSyncBranch registers a dummy undo (branch will be rolled back too)
  const dummyBranchUndo = vi.fn().mockResolvedValue(undefined);
  mockGitPublisherInstance.createSyncBranch.mockReset().mockImplementation(
    async (
      _timestamp: string,
      rollbackMgr: { register: (entry: { description: string; undo: () => Promise<void> }) => void },
    ) => {
      rollbackMgr.register({ description: 'delete branch', undo: dummyBranchUndo });
    },
  );

  mockGitPublisherInstance.writeDocFile.mockReset().mockResolvedValue(undefined);
  mockGitPublisherInstance.createDefaultDocFile.mockReset().mockResolvedValue(undefined);
  mockGitPublisherInstance.commitAndPush.mockReset().mockResolvedValue(undefined);
  mockGitPublisherInstance.createPR
    .mockReset()
    .mockResolvedValue('https://github.com/testowner/testrepo/pull/20');

  mockConfluencePublisherInstance.fetchPage.mockReset().mockResolvedValue({
    body: '<h2>detectDrift</h2><p>Old docs.</p>',
    version: 5,
    title: 'API Docs',
  });

  // writeDraft: registers revertSpy as the undo closure, then throws to
  // simulate a failed Confluence PUT after the draft was started.
  mockConfluencePublisherInstance.writeDraft.mockReset().mockImplementation(
    async (
      _pageId: string,
      _html: string,
      _version: number,
      rollbackMgr: { register: (entry: { description: string; undo: () => Promise<void> }) => void },
    ) => {
      // Register-then-mutate invariant: undo is pushed BEFORE the PUT
      rollbackMgr.register({ description: 'revert Confluence draft', undo: revertSpy });
      // Simulate PUT failure
      throw new Error('Confluence API 503 Service Unavailable');
    },
  );

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
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }

  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('e2e: rollback-confluence — Confluence PUT failure triggers draft revert', () => {
  it('rejects with process.exit(1) when writeDraft throws', async () => {
    await expect(run()).rejects.toThrow('process.exit(1)');

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('calls the revert undo registered by writeDraft before it threw', async () => {
    // The undo closure (revertSpy) is registered BEFORE writeDraft throws,
    // so rollback() must execute it.
    await expect(run()).rejects.toThrow('process.exit(1)');

    expect(revertSpy).toHaveBeenCalledOnce();
  });

  it('does not open a PR when the Confluence draft write fails', async () => {
    await expect(run()).rejects.toThrow('process.exit(1)');

    // createPR was configured to succeed but should not be reached because
    // writeDraft threw before reaching commitAndPush / createPR.
    expect(mockGitPublisherInstance.createPR).not.toHaveBeenCalled();
  });

  it('logs a structured error to stderr', async () => {
    await expect(run()).rejects.toThrow('process.exit(1)');

    expect(consoleErrorSpy).toHaveBeenCalled();
  });
});
