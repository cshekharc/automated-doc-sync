/**
 * E2E scenario: Rollback — GitHub API Failure
 *
 * When `GitPublisher.createPR` fails mid-run (after the sync branch has been
 * created and files have been written), the pipeline's catch block calls
 * `RollbackManager.rollback()`, which executes all registered undo closures
 * in LIFO order. This verifies that the branch-deletion undo is actually
 * invoked, effectively "cleaning up" the branch that was created.
 *
 * This spec uses the **real** `RollbackManager` (not mocked) so that the
 * registered undo closures are genuinely called during rollback.
 *
 * AC-8 acceptance criterion verified.
 * MOCK_API_MODE=true — no real external API calls.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mock state
// NOTE: RollbackManager is NOT mocked in this file — the real implementation
// is used so that registered undo closures are actually executed.
// ---------------------------------------------------------------------------

const mockValidateTrigger = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    mergeSha: 'sha-rollback-gh-abcdef1234567890',
    baseSha: 'sha-rollback-gh-abcdef1234567890^1',
    changedFiles: ['src/utils.ts'],
    owner: 'testowner',
    repo: 'testrepo',
  }),
);

const mockDetectDrift = vi.hoisted(() => vi.fn<[], Promise<unknown[]>>());

const mockLocateMarkdownSection = vi.hoisted(() => vi.fn());
const mockLocateConfluenceSection = vi.hoisted(() => vi.fn());

const mockCompareDrift = vi.hoisted(() => vi.fn<[unknown, { target: string }], string>());

const mockRegenerateMarkdownSection = vi.hoisted(() =>
  vi.fn<[string, unknown, unknown], string>().mockReturnValue(
    '## testFn\n\n```typescript\nexport function testFn(): void\n```\n\nUpdated.\n',
  ),
);

// GitPublisher instance — createSyncBranch registers a spy undo; createPR throws.
const mockGitPublisherInstance = vi.hoisted(() => ({
  createSyncBranch: vi.fn<[string, unknown], Promise<void>>(),
  writeDocFile: vi.fn<[string, string, unknown], Promise<void>>(),
  createDefaultDocFile: vi.fn<[string, unknown], Promise<void>>().mockResolvedValue(undefined),
  commitAndPush: vi.fn<[string[], string], Promise<void>>().mockResolvedValue(undefined),
  createPR: vi.fn<[unknown], Promise<string>>(),
}));

const mockConfluencePublisherInstance = vi.hoisted(() => ({
  fetchPage: vi.fn().mockResolvedValue({ body: '', version: 1, title: 'Docs' }),
  writeDraft: vi.fn<[string, string, number, unknown], Promise<void>>().mockResolvedValue(undefined),
}));

const mockReadFile = vi.hoisted(() =>
  vi.fn<[string, string], Promise<string>>().mockResolvedValue(
    '## testFn\n\nOld docs.\n',
  ),
);

// ---------------------------------------------------------------------------
// Module mocks
// RollbackManager is intentionally NOT mocked — real implementation used.
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
  regenerateMarkdownSection: mockRegenerateMarkdownSection,
  regenerateConfluenceSection: vi.fn().mockReturnValue('<h2>fn</h2>'),
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
// Import under test (AFTER vi.mock declarations)
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

/** Spy on the branch-deletion undo registered by createSyncBranch. */
let deleteBranchSpy: ReturnType<typeof vi.fn>;
/** Spy on the file-restore undo registered by writeDocFile. */
let restoreFileSpy: ReturnType<typeof vi.fn>;

let exitSpy: ReturnType<typeof vi.spyOn>;
let consoleLogSpy: ReturnType<typeof vi.spyOn>;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  for (const key of MANAGED_ENV_VARS) {
    savedEnv[key] = process.env[key];
  }

  process.env['MOCK_API_MODE'] = 'true';
  delete process.env['CONFLUENCE_PAGE_ID'];
  process.env['GITHUB_SHA'] = 'sha-rollback-gh-abcdef1234567890';
  process.env['GITHUB_REPOSITORY'] = 'testowner/testrepo';

  // Create fresh spy functions for the undo closures
  deleteBranchSpy = vi.fn().mockResolvedValue(undefined);
  restoreFileSpy = vi.fn().mockResolvedValue(undefined);

  // Resets
  mockValidateTrigger.mockReset().mockResolvedValue({
    mergeSha: 'sha-rollback-gh-abcdef1234567890',
    baseSha: 'sha-rollback-gh-abcdef1234567890^1',
    changedFiles: ['src/utils.ts'],
    owner: 'testowner',
    repo: 'testrepo',
  });

  // One modified function
  mockDetectDrift.mockReset().mockResolvedValue([
    {
      name: 'testFn',
      signature: 'export function testFn(): void',
      jsdoc: 'Test function.',
      sourceFilePath: 'src/utils.ts',
      changeType: 'modified',
    },
  ]);

  // Stale markdown section
  mockLocateMarkdownSection.mockReset().mockResolvedValue({
    functionName: 'testFn',
    target: 'markdown',
    markdownFilePath: 'docs/api.md',
    sectionContent: '## testFn\n\nOld docs.\n',
    sectionStartOffset: 0,
    sectionEndOffset: 20,
  });

  mockLocateConfluenceSection.mockReset().mockResolvedValue({
    functionName: 'testFn',
    target: 'not-found',
    sectionContent: '',
  });

  mockCompareDrift.mockReset().mockImplementation((_fn, section: { target: string }) => {
    if (section.target === 'markdown') return 'stale';
    return 'not-found';
  });

  mockRegenerateMarkdownSection.mockReset().mockReturnValue(
    '## testFn\n\n```typescript\nexport function testFn(): void\n```\n\nUpdated.\n',
  );

  mockReadFile.mockReset().mockResolvedValue('## testFn\n\nOld docs.\n');

  // createSyncBranch: registers TWO undo closures (local branch + remote branch)
  // using the real RollbackManager instance. We capture the spy so we can
  // assert it was called during rollback.
  mockGitPublisherInstance.createSyncBranch.mockReset().mockImplementation(
    async (
      _timestamp: string,
      rollbackMgr: { register: (entry: { description: string; undo: () => Promise<void> }) => void },
    ) => {
      rollbackMgr.register({ description: 'delete local branch', undo: deleteBranchSpy });
      rollbackMgr.register({ description: 'delete remote branch', undo: deleteBranchSpy });
    },
  );

  // writeDocFile: registers a file-restore undo
  mockGitPublisherInstance.writeDocFile.mockReset().mockImplementation(
    async (
      _path: string,
      _content: string,
      rollbackMgr: { register: (entry: { description: string; undo: () => Promise<void> }) => void },
    ) => {
      rollbackMgr.register({ description: 'restore file', undo: restoreFileSpy });
    },
  );

  mockGitPublisherInstance.createDefaultDocFile.mockReset().mockResolvedValue(undefined);
  mockGitPublisherInstance.commitAndPush.mockReset().mockResolvedValue(undefined);

  // createPR throws — this triggers the rollback chain
  mockGitPublisherInstance.createPR.mockReset().mockRejectedValue(
    new Error('GitHub API rate limit exceeded'),
  );

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

describe('e2e: rollback-github — GitHub PR creation failure triggers branch and file rollback', () => {
  it('rejects with process.exit(1) when createPR throws', async () => {
    await expect(run()).rejects.toThrow('process.exit(1)');

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('executes the branch-deletion undo registered by createSyncBranch', async () => {
    await expect(run()).rejects.toThrow('process.exit(1)');

    // deleteBranchSpy registered for both local and remote branch undos
    expect(deleteBranchSpy).toHaveBeenCalled();
  });

  it('executes the file-restore undo registered by writeDocFile', async () => {
    await expect(run()).rejects.toThrow('process.exit(1)');

    expect(restoreFileSpy).toHaveBeenCalledOnce();
  });

  it('executes rollback undos in LIFO order: file restore before branch deletion', async () => {
    const callOrder: string[] = [];
    deleteBranchSpy.mockImplementation(async () => {
      callOrder.push('branch-delete');
    });
    restoreFileSpy.mockImplementation(async () => {
      callOrder.push('file-restore');
    });

    await expect(run()).rejects.toThrow('process.exit(1)');

    // LIFO: writeDocFile undo (file-restore) was registered after createSyncBranch
    // undos, so it runs first during rollback
    const fileRestoreIndex = callOrder.indexOf('file-restore');
    const branchDeleteIndex = callOrder.indexOf('branch-delete');
    expect(fileRestoreIndex).toBeLessThan(branchDeleteIndex);
  });

  it('logs a structured error to stderr when the pipeline fails', async () => {
    await expect(run()).rejects.toThrow('process.exit(1)');

    // The pipeline logs an error to stderr before calling process.exit(1)
    expect(consoleErrorSpy).toHaveBeenCalled();
  });
});
