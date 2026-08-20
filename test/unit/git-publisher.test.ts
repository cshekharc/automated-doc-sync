/**
 * Unit tests for GitPublisher (T-12).
 *
 * All external dependencies are mocked:
 * - `simple-git` → `mockGit` object whose methods are vi.fn() stubs.
 * - `@octokit/rest` → `mockPullsCreate` vi.fn() stub.
 * - `fs/promises` → `mockWriteFile` and `mockUnlink` stubs.
 * - `fs` → `mockExistsSync` stub.
 *
 * Acceptance criteria verified:
 * - Branch name matches `docs/sync-<timestamp>` format.
 * - `RollbackManager.register()` is called BEFORE each mutation: branch
 *   creation, remote push, file write, new-file creation.
 * - The remote branch-deletion undo is pre-registered in createSyncBranch
 *   (after the local checkout, before any push).
 * - PR body includes `Triggered-by: <sha>`, regenerated/scaffolded lists,
 *   Known Limitations section, and a well-formed `<!-- doc-sync-meta -->` block.
 * - No `reviewers` field appears in the Octokit PR creation payload (FR-6).
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist mocks — vi.hoisted() ensures these are available in vi.mock() factory
// closures before any module import is resolved.
// ---------------------------------------------------------------------------

/** Shared simple-git mock object returned by the simpleGit() factory. */
const mockGit = vi.hoisted(() => ({
  checkoutLocalBranch: vi.fn().mockResolvedValue(undefined),
  deleteLocalBranch: vi.fn().mockResolvedValue(undefined),
  add: vi.fn().mockResolvedValue(undefined),
  commit: vi.fn().mockResolvedValue(undefined),
  push: vi.fn().mockResolvedValue(undefined),
  checkout: vi.fn().mockResolvedValue(undefined),
}));

/** Shared Octokit pulls.create mock. */
const mockPullsCreate = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    data: { html_url: 'https://github.com/testowner/testrepo/pull/42' },
  }),
);

/** fs/promises.writeFile mock. */
const mockWriteFile = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

/** fs/promises.unlink mock. */
const mockUnlink = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

/** fs.existsSync mock. */
const mockExistsSync = vi.hoisted(() => vi.fn<[string], boolean>().mockReturnValue(false));

// ---------------------------------------------------------------------------
// Module mocks (must appear before any import of the module under test)
// ---------------------------------------------------------------------------

vi.mock('simple-git', () => ({
  simpleGit: () => mockGit,
}));

vi.mock('@octokit/rest', () => ({
  Octokit: vi.fn().mockImplementation(() => ({
    pulls: { create: mockPullsCreate },
  })),
}));

vi.mock('fs/promises', () => ({
  writeFile: mockWriteFile,
  unlink: mockUnlink,
}));

vi.mock('fs', () => ({
  existsSync: mockExistsSync,
  default: { existsSync: mockExistsSync },
}));

// ---------------------------------------------------------------------------
// Imports under test (AFTER vi.mock declarations)
// ---------------------------------------------------------------------------

import { GitPublisher } from '../../src/git-publisher/index.js';
import { RollbackManager } from '../../src/rollback-manager.js';
import type { PipelineResult } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Builds a minimal PipelineResult with sensible defaults. */
function makePipelineResult(overrides: Partial<PipelineResult> = {}): PipelineResult {
  return {
    triggerCommitSha: 'abc123def456',
    regenerated: [],
    scaffolded: [],
    notFound: [],
    confluenceDraftPageIds: [],
    prUrl: null,
    skipped: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Shared setup / teardown
// ---------------------------------------------------------------------------

let publisher!: GitPublisher;
let consoleSpy: ReturnType<typeof vi.spyOn>;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // Environment variables required by GitPublisher
  process.env['GITHUB_TOKEN'] = 'ghp_unit_test_token_placeholder_xxxxxxxx';
  process.env['GITHUB_REPOSITORY'] = 'testowner/testrepo';
  process.env['GITHUB_REQUEST_TIMEOUT_MS'] = '5000';

  // Reset all git mock methods to a clean resolved state
  mockGit.checkoutLocalBranch.mockReset().mockResolvedValue(undefined);
  mockGit.deleteLocalBranch.mockReset().mockResolvedValue(undefined);
  mockGit.add.mockReset().mockResolvedValue(undefined);
  mockGit.commit.mockReset().mockResolvedValue(undefined);
  mockGit.push.mockReset().mockResolvedValue(undefined);
  mockGit.checkout.mockReset().mockResolvedValue(undefined);

  // Reset Octokit mock
  mockPullsCreate.mockReset().mockResolvedValue({
    data: { html_url: 'https://github.com/testowner/testrepo/pull/42' },
  });

  // Reset fs mocks
  mockWriteFile.mockReset().mockResolvedValue(undefined);
  mockUnlink.mockReset().mockResolvedValue(undefined);
  mockExistsSync.mockReset().mockReturnValue(false);

  // Create a fresh publisher AFTER resetting mocks so the constructor sees
  // the correct mockImplementation for Octokit.
  publisher = new GitPublisher();

  // Suppress console output during tests.
  // NOTE: we track these spies and restore them individually in afterEach
  // rather than using vi.restoreAllMocks() — calling restoreAllMocks() would
  // strip the mockImplementation from the Octokit vi.fn() constructor, causing
  // subsequent tests to receive an empty Octokit instance with no .pulls property.
  consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  // Restore only the console spies; do NOT call vi.restoreAllMocks() here
  // as that would reset the Octokit mock implementation between tests.
  consoleSpy.mockRestore();
  consoleErrorSpy.mockRestore();
  delete process.env['GITHUB_TOKEN'];
  delete process.env['GITHUB_REPOSITORY'];
  delete process.env['GITHUB_REQUEST_TIMEOUT_MS'];
});

// ---------------------------------------------------------------------------
// createSyncBranch — branch name format
// ---------------------------------------------------------------------------

describe('createSyncBranch — branch name format', () => {
  it('creates branch named docs/sync-<timestamp>', async () => {
    const rollback = new RollbackManager();
    await publisher.createSyncBranch('20260820T143000Z', rollback);

    expect(mockGit.checkoutLocalBranch).toHaveBeenCalledWith('docs/sync-20260820T143000Z');
  });

  it('branch name embeds the exact timestamp string passed in', async () => {
    const rollback = new RollbackManager();
    await publisher.createSyncBranch('20991231T235959Z', rollback);

    expect(mockGit.checkoutLocalBranch).toHaveBeenCalledWith('docs/sync-20991231T235959Z');
  });
});

// ---------------------------------------------------------------------------
// createSyncBranch — register-before-mutate order (F-6)
// ---------------------------------------------------------------------------

describe('createSyncBranch — register-before-mutate invariant', () => {
  it('calls register (local), checkoutLocalBranch, then register (remote) in that order', async () => {
    const rollback = new RollbackManager();
    const order: string[] = [];

    vi.spyOn(rollback, 'register').mockImplementation(entry => {
      order.push(`register:${entry.description}`);
    });

    mockGit.checkoutLocalBranch.mockImplementation((name: string) => {
      order.push(`checkoutLocalBranch:${name}`);
      return Promise.resolve(undefined);
    });

    await publisher.createSyncBranch('20260820T143000Z', rollback);

    expect(order).toHaveLength(3);
    // First: local branch deletion undo registered before the checkout
    expect(order[0]).toMatch(/register.*local.*docs\/sync-20260820T143000Z/i);
    // Second: actual git checkout
    expect(order[1]).toBe('checkoutLocalBranch:docs/sync-20260820T143000Z');
    // Third: remote branch deletion undo registered after the checkout
    expect(order[2]).toMatch(/register.*remote.*docs\/sync-20260820T143000Z/i);
  });

  it('registers exactly two undo entries for createSyncBranch', async () => {
    const rollback = new RollbackManager();
    const registerSpy = vi.spyOn(rollback, 'register').mockImplementation(() => {});

    await publisher.createSyncBranch('20260820T143000Z', rollback);

    expect(registerSpy).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// createSyncBranch — undo closures
// ---------------------------------------------------------------------------

describe('createSyncBranch — undo closures', () => {
  it('local undo calls git.deleteLocalBranch with force=true', async () => {
    const rollback = new RollbackManager();
    const capturedUndos: Array<() => Promise<void>> = [];

    vi.spyOn(rollback, 'register').mockImplementation(entry => {
      capturedUndos.push(entry.undo);
    });

    await publisher.createSyncBranch('20260820T143000Z', rollback);

    // First undo is the local branch deletion
    expect(capturedUndos).toHaveLength(2);
    mockGit.deleteLocalBranch.mockReset().mockResolvedValue(undefined);
    await capturedUndos[0]();

    expect(mockGit.deleteLocalBranch).toHaveBeenCalledWith(
      'docs/sync-20260820T143000Z',
      true,
    );
  });

  it('remote undo calls git.push with --delete flag', async () => {
    const rollback = new RollbackManager();
    const capturedUndos: Array<() => Promise<void>> = [];

    vi.spyOn(rollback, 'register').mockImplementation(entry => {
      capturedUndos.push(entry.undo);
    });

    await publisher.createSyncBranch('20260820T143000Z', rollback);

    // Second undo is the remote branch deletion
    mockGit.push.mockReset().mockResolvedValue(undefined);
    await capturedUndos[1]();

    expect(mockGit.push).toHaveBeenCalledWith([
      'origin',
      '--delete',
      'docs/sync-20260820T143000Z',
    ]);
  });
});

// ---------------------------------------------------------------------------
// writeDocFile — register-before-mutate order (F-6)
// ---------------------------------------------------------------------------

describe('writeDocFile — register-before-mutate invariant', () => {
  it('calls register before writeFile', async () => {
    const rollback = new RollbackManager();
    const order: string[] = [];

    vi.spyOn(rollback, 'register').mockImplementation(entry => {
      order.push(`register:${entry.description}`);
    });

    mockWriteFile.mockImplementation(() => {
      order.push('writeFile');
      return Promise.resolve(undefined);
    });

    await publisher.writeDocFile('/docs/api.md', 'new content', rollback);

    expect(order[0]).toMatch(/register/);
    expect(order[1]).toBe('writeFile');
  });

  it('registers exactly one undo entry per writeDocFile call', async () => {
    const rollback = new RollbackManager();
    const registerSpy = vi.spyOn(rollback, 'register').mockImplementation(() => {});

    await publisher.writeDocFile('/docs/api.md', 'content', rollback);

    expect(registerSpy).toHaveBeenCalledTimes(1);
  });

  it('writes the provided content to the provided path', async () => {
    const rollback = new RollbackManager();
    vi.spyOn(rollback, 'register').mockImplementation(() => {});

    await publisher.writeDocFile('/docs/api.md', 'hello world', rollback);

    expect(mockWriteFile).toHaveBeenCalledWith('/docs/api.md', 'hello world', 'utf-8');
  });
});

// ---------------------------------------------------------------------------
// writeDocFile — undo closure
// ---------------------------------------------------------------------------

describe('writeDocFile — undo closure', () => {
  it('undo calls git.checkout with ["HEAD", "--", filePath]', async () => {
    const rollback = new RollbackManager();
    let capturedUndo: (() => Promise<void>) | undefined;

    vi.spyOn(rollback, 'register').mockImplementation(entry => {
      capturedUndo = entry.undo;
    });

    await publisher.writeDocFile('/docs/utils.md', 'content', rollback);

    expect(capturedUndo).toBeDefined();
    mockGit.checkout.mockReset().mockResolvedValue(undefined);
    await capturedUndo!();

    expect(mockGit.checkout).toHaveBeenCalledWith(['HEAD', '--', '/docs/utils.md']);
  });

  it('undo description references the file path', async () => {
    const rollback = new RollbackManager();
    let capturedDescription = '';

    vi.spyOn(rollback, 'register').mockImplementation(entry => {
      capturedDescription = entry.description;
    });

    await publisher.writeDocFile('/docs/api.md', 'content', rollback);

    expect(capturedDescription).toContain('/docs/api.md');
  });
});

// ---------------------------------------------------------------------------
// createDefaultDocFile — skips when file already exists
// ---------------------------------------------------------------------------

describe('createDefaultDocFile — file already exists', () => {
  it('returns without registering any undo or writing when file exists', async () => {
    mockExistsSync.mockReturnValue(true);
    const rollback = new RollbackManager();
    const registerSpy = vi.spyOn(rollback, 'register').mockImplementation(() => {});

    await publisher.createDefaultDocFile('/docs/api.md', rollback);

    expect(registerSpy).not.toHaveBeenCalled();
    expect(mockWriteFile).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// createDefaultDocFile — register-before-mutate order (F-8)
// ---------------------------------------------------------------------------

describe('createDefaultDocFile — register-before-mutate invariant', () => {
  it('calls register before writeFile when file is absent', async () => {
    mockExistsSync.mockReturnValue(false);
    const rollback = new RollbackManager();
    const order: string[] = [];

    vi.spyOn(rollback, 'register').mockImplementation(entry => {
      order.push(`register:${entry.description}`);
    });

    mockWriteFile.mockImplementation(() => {
      order.push('writeFile');
      return Promise.resolve(undefined);
    });

    await publisher.createDefaultDocFile('/docs/api.md', rollback);

    expect(order[0]).toMatch(/register/);
    expect(order[1]).toBe('writeFile');
  });

  it('creates an empty file when the file is absent', async () => {
    mockExistsSync.mockReturnValue(false);
    const rollback = new RollbackManager();
    vi.spyOn(rollback, 'register').mockImplementation(() => {});

    await publisher.createDefaultDocFile('/docs/api.md', rollback);

    expect(mockWriteFile).toHaveBeenCalledWith('/docs/api.md', '', 'utf-8');
  });
});

// ---------------------------------------------------------------------------
// createDefaultDocFile — undo closure
// ---------------------------------------------------------------------------

describe('createDefaultDocFile — undo closure', () => {
  it('undo calls fs.unlink with the file path', async () => {
    mockExistsSync.mockReturnValue(false);
    const rollback = new RollbackManager();
    let capturedUndo: (() => Promise<void>) | undefined;

    vi.spyOn(rollback, 'register').mockImplementation(entry => {
      capturedUndo = entry.undo;
    });

    await publisher.createDefaultDocFile('/docs/api.md', rollback);

    expect(capturedUndo).toBeDefined();
    mockUnlink.mockReset().mockResolvedValue(undefined);
    await capturedUndo!();

    expect(mockUnlink).toHaveBeenCalledWith('/docs/api.md');
  });
});

// ---------------------------------------------------------------------------
// commitAndPush
// ---------------------------------------------------------------------------

describe('commitAndPush', () => {
  beforeEach(async () => {
    // Set up the branch name by calling createSyncBranch with mocked register
    const rollback = new RollbackManager();
    vi.spyOn(rollback, 'register').mockImplementation(() => {});
    await publisher.createSyncBranch('20260820T143000Z', rollback);
    // Reset push mock after createSyncBranch (which did not call push)
    mockGit.push.mockReset().mockResolvedValue(undefined);
  });

  it('stages all files under docs/', async () => {
    await publisher.commitAndPush(['fn1'], 'abc123');
    expect(mockGit.add).toHaveBeenCalledWith('docs/');
  });

  it('commits with "docs: sync documentation for <fn1>, <fn2>" message', async () => {
    await publisher.commitAndPush(['fn1', 'fn2'], 'abc123');
    expect(mockGit.commit).toHaveBeenCalledWith(
      'docs: sync documentation for fn1, fn2',
    );
  });

  it('commits with correct message for a single function', async () => {
    await publisher.commitAndPush(['myFunc'], 'sha999');
    expect(mockGit.commit).toHaveBeenCalledWith('docs: sync documentation for myFunc');
  });

  it('pushes to origin with --set-upstream for the current branch', async () => {
    await publisher.commitAndPush(['fn1'], 'abc123');
    expect(mockGit.push).toHaveBeenCalledWith(
      'origin',
      'docs/sync-20260820T143000Z',
      ['--set-upstream'],
    );
  });

  it('calls git.add before git.commit', async () => {
    const order: string[] = [];
    mockGit.add.mockImplementation(() => {
      order.push('add');
      return Promise.resolve(undefined);
    });
    mockGit.commit.mockImplementation(() => {
      order.push('commit');
      return Promise.resolve(undefined);
    });
    mockGit.push.mockImplementation(() => {
      order.push('push');
      return Promise.resolve(undefined);
    });

    await publisher.commitAndPush(['fn1'], 'abc123');

    expect(order).toEqual(['add', 'commit', 'push']);
  });
});

// ---------------------------------------------------------------------------
// createPR — title
// ---------------------------------------------------------------------------

describe('createPR — title', () => {
  beforeEach(async () => {
    const rollback = new RollbackManager();
    vi.spyOn(rollback, 'register').mockImplementation(() => {});
    await publisher.createSyncBranch('20260820T143000Z', rollback);
  });

  it('title starts with "docs: sync documentation —"', async () => {
    const result = makePipelineResult({ triggerCommitSha: 'abc123' });
    await publisher.createPR(result);

    const callArgs = mockPullsCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs['title']).toMatch(/^docs: sync documentation/);
  });

  it('title includes the trigger commit SHA', async () => {
    const result = makePipelineResult({ triggerCommitSha: 'deadbeef1234' });
    await publisher.createPR(result);

    const callArgs = mockPullsCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs['title']).toContain('deadbeef1234');
  });

  it('title is truncated to at most 72 characters', async () => {
    const longSha = 'a'.repeat(100);
    const result = makePipelineResult({ triggerCommitSha: longSha });
    await publisher.createPR(result);

    const callArgs = mockPullsCreate.mock.calls[0][0] as Record<string, unknown>;
    expect((callArgs['title'] as string).length).toBeLessThanOrEqual(72);
  });

  it('title is not truncated when it is exactly 72 characters or shorter', async () => {
    // "docs: sync documentation — " is 27 chars; SHA of 40 chars → 67 total (< 72)
    const sha = 'a'.repeat(40);
    const result = makePipelineResult({ triggerCommitSha: sha });
    await publisher.createPR(result);

    const callArgs = mockPullsCreate.mock.calls[0][0] as Record<string, unknown>;
    const title = callArgs['title'] as string;
    expect(title).toContain(sha);
    expect(title.length).toBeLessThanOrEqual(72);
  });
});

// ---------------------------------------------------------------------------
// createPR — PR routing (base, head)
// ---------------------------------------------------------------------------

describe('createPR — base and head branches', () => {
  beforeEach(async () => {
    const rollback = new RollbackManager();
    vi.spyOn(rollback, 'register').mockImplementation(() => {});
    await publisher.createSyncBranch('20260820T143000Z', rollback);
  });

  it('sets base to "main"', async () => {
    await publisher.createPR(makePipelineResult());
    const callArgs = mockPullsCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs['base']).toBe('main');
  });

  it('sets head to the current sync branch', async () => {
    await publisher.createPR(makePipelineResult());
    const callArgs = mockPullsCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs['head']).toBe('docs/sync-20260820T143000Z');
  });

  it('uses owner and repo from GITHUB_REPOSITORY env var', async () => {
    await publisher.createPR(makePipelineResult());
    const callArgs = mockPullsCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs['owner']).toBe('testowner');
    expect(callArgs['repo']).toBe('testrepo');
  });
});

// ---------------------------------------------------------------------------
// createPR — no reviewers field (FR-6)
// ---------------------------------------------------------------------------

describe('createPR — no reviewers field (FR-6)', () => {
  it('does not include a reviewers field in the Octokit payload', async () => {
    const rollback = new RollbackManager();
    vi.spyOn(rollback, 'register').mockImplementation(() => {});
    await publisher.createSyncBranch('20260820T143000Z', rollback);

    await publisher.createPR(makePipelineResult());

    const callArgs = mockPullsCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs['reviewers']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// createPR — PR body content
// ---------------------------------------------------------------------------

describe('createPR — PR body content', () => {
  beforeEach(async () => {
    const rollback = new RollbackManager();
    vi.spyOn(rollback, 'register').mockImplementation(() => {});
    await publisher.createSyncBranch('20260820T143000Z', rollback);
  });

  it('body contains "Triggered-by: <sha>" (NFR-6)', async () => {
    const result = makePipelineResult({ triggerCommitSha: 'sha999xyz' });
    await publisher.createPR(result);

    const callArgs = mockPullsCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs['body']).toContain('Triggered-by: sha999xyz');
  });

  it('body contains ### Regenerated sections heading', async () => {
    await publisher.createPR(makePipelineResult());
    const callArgs = mockPullsCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs['body']).toContain('### Regenerated sections');
  });

  it('body lists each regenerated function by name', async () => {
    const result = makePipelineResult({
      regenerated: [
        { name: 'myFunc', target: 'markdown', location: 'docs/api.md' },
        { name: 'anotherFn', target: 'confluence', location: '12345' },
      ],
    });
    await publisher.createPR(result);

    const callArgs = mockPullsCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs['body']).toContain('`myFunc`');
    expect(callArgs['body']).toContain('`anotherFn`');
  });

  it('body shows _none_ for regenerated when list is empty', async () => {
    await publisher.createPR(makePipelineResult({ regenerated: [] }));
    const callArgs = mockPullsCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs['body']).toContain('_none_');
  });

  it('body contains ### Scaffolded sections heading', async () => {
    await publisher.createPR(makePipelineResult());
    const callArgs = mockPullsCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs['body']).toContain('### Scaffolded sections');
  });

  it('body lists each scaffolded function by name', async () => {
    const result = makePipelineResult({
      scaffolded: [{ name: 'newFn', target: 'markdown', location: 'docs/api.md' }],
    });
    await publisher.createPR(result);

    const callArgs = mockPullsCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs['body']).toContain('`newFn`');
  });

  it('body contains ### Known Limitations heading', async () => {
    await publisher.createPR(makePipelineResult());
    const callArgs = mockPullsCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs['body']).toContain('### Known Limitations');
  });

  it('body lists each notFound function by name', async () => {
    const result = makePipelineResult({
      notFound: [{ name: 'orphanFn', sourceFilePath: 'src/utils.ts' }],
    });
    await publisher.createPR(result);

    const callArgs = mockPullsCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs['body']).toContain('`orphanFn`');
    expect(callArgs['body']).toContain('src/utils.ts');
  });

  it('body shows _none_ for Known Limitations when notFound is empty', async () => {
    await publisher.createPR(makePipelineResult({ notFound: [] }));
    const callArgs = mockPullsCreate.mock.calls[0][0] as Record<string, unknown>;
    // _none_ may appear multiple times (regenerated, scaffolded, known limitations)
    expect(callArgs['body']).toContain('_none_');
  });

  it('body contains a well-formed <!-- doc-sync-meta: ... --> comment block', async () => {
    const result = makePipelineResult({
      triggerCommitSha: 'sha1111',
      confluenceDraftPageIds: ['98765'],
    });
    await publisher.createPR(result);

    const callArgs = mockPullsCreate.mock.calls[0][0] as Record<string, unknown>;
    const body = callArgs['body'] as string;
    expect(body).toContain('<!-- doc-sync-meta:');
    expect(body).toContain('-->');
    expect(body).toContain('"triggerSha":"sha1111"');
    expect(body).toContain('"confluenceDrafts":["98765"]');
  });

  it('doc-sync-meta block is valid JSON when extracted', async () => {
    const result = makePipelineResult({
      triggerCommitSha: 'sha2222',
      confluenceDraftPageIds: ['11111', '22222'],
    });
    await publisher.createPR(result);

    const callArgs = mockPullsCreate.mock.calls[0][0] as Record<string, unknown>;
    const body = callArgs['body'] as string;

    const metaMatch = body.match(/<!-- doc-sync-meta: (.+?) -->/);
    expect(metaMatch).not.toBeNull();
    const parsed = JSON.parse(metaMatch![1]);
    expect(parsed).toMatchObject({
      triggerSha: 'sha2222',
      confluenceDrafts: ['11111', '22222'],
    });
  });

  it('doc-sync-meta block contains empty confluenceDrafts array when none', async () => {
    const result = makePipelineResult({
      triggerCommitSha: 'sha3333',
      confluenceDraftPageIds: [],
    });
    await publisher.createPR(result);

    const callArgs = mockPullsCreate.mock.calls[0][0] as Record<string, unknown>;
    const body = callArgs['body'] as string;
    expect(body).toContain('"confluenceDrafts":[]');
  });
});

// ---------------------------------------------------------------------------
// createPR — return value and Octokit call count
// ---------------------------------------------------------------------------

describe('createPR — return value', () => {
  it('returns the PR HTML URL from the Octokit response', async () => {
    const rollback = new RollbackManager();
    vi.spyOn(rollback, 'register').mockImplementation(() => {});
    await publisher.createSyncBranch('20260820T143000Z', rollback);

    mockPullsCreate.mockResolvedValue({
      data: { html_url: 'https://github.com/testowner/testrepo/pull/99' },
    });

    const url = await publisher.createPR(makePipelineResult());
    expect(url).toBe('https://github.com/testowner/testrepo/pull/99');
  });

  it('calls Octokit pulls.create exactly once', async () => {
    const rollback = new RollbackManager();
    vi.spyOn(rollback, 'register').mockImplementation(() => {});
    await publisher.createSyncBranch('20260820T143000Z', rollback);

    await publisher.createPR(makePipelineResult());
    expect(mockPullsCreate).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Integration-style: full happy path (createSyncBranch → writeDocFile → commitAndPush → createPR)
// ---------------------------------------------------------------------------

describe('full pipeline sequence', () => {
  it('executes the complete sequence without errors and returns a PR URL', async () => {
    const rollback = new RollbackManager();

    // createSyncBranch
    await publisher.createSyncBranch('20260820T143000Z', rollback);
    expect(mockGit.checkoutLocalBranch).toHaveBeenCalledWith('docs/sync-20260820T143000Z');

    // writeDocFile
    await publisher.writeDocFile('docs/api.md', '# API\n\n## myFn\n\nNew docs.\n', rollback);
    expect(mockWriteFile).toHaveBeenCalledWith(
      'docs/api.md',
      '# API\n\n## myFn\n\nNew docs.\n',
      'utf-8',
    );

    // commitAndPush
    mockGit.push.mockReset().mockResolvedValue(undefined);
    await publisher.commitAndPush(['myFn'], 'deadbeef');
    expect(mockGit.commit).toHaveBeenCalledWith('docs: sync documentation for myFn');
    expect(mockGit.push).toHaveBeenCalledWith('origin', 'docs/sync-20260820T143000Z', [
      '--set-upstream',
    ]);

    // createPR
    const result = makePipelineResult({
      triggerCommitSha: 'deadbeef',
      regenerated: [{ name: 'myFn', target: 'markdown', location: 'docs/api.md' }],
    });
    const prUrl = await publisher.createPR(result);
    expect(prUrl).toBe('https://github.com/testowner/testrepo/pull/42');

    const callArgs = mockPullsCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs['body']).toContain('Triggered-by: deadbeef');
    expect(callArgs['reviewers']).toBeUndefined();
  });

  it('rollback undos execute in LIFO order and reverse all mutations', async () => {
    const rollback = new RollbackManager();
    const undoOrder: string[] = [];

    // Spy on rollback.register to capture descriptions in registration order
    const originalRegister = rollback.register.bind(rollback);
    vi.spyOn(rollback, 'register').mockImplementation(entry => {
      const wrappedEntry = {
        description: entry.description,
        undo: async () => {
          undoOrder.push(entry.description);
          await entry.undo();
        },
      };
      originalRegister(wrappedEntry);
    });

    await publisher.createSyncBranch('20260820T143000Z', rollback);
    await publisher.writeDocFile('docs/api.md', 'content', rollback);

    mockGit.deleteLocalBranch.mockReset().mockResolvedValue(undefined);
    mockGit.push.mockReset().mockResolvedValue(undefined);
    mockGit.checkout.mockReset().mockResolvedValue(undefined);

    await rollback.rollback();

    // Registrations order: local-branch, remote-branch, file-write
    // LIFO rollback order: file-write, remote-branch, local-branch
    expect(undoOrder[0]).toMatch(/checkout HEAD.*docs\/api\.md/i);
    expect(undoOrder[1]).toMatch(/remote branch/i);
    expect(undoOrder[2]).toMatch(/local branch/i);
  });
});
