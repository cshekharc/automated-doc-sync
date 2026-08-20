/**
 * E2E scenario: Idempotency Guard
 *
 * When an open `docs/sync-*` PR already exists whose body contains a
 * `Triggered-by: <SHA>` line matching the current `GITHUB_SHA`, the pipeline
 * calls `process.exit(0)` without creating a second PR or making any mutations.
 *
 * This spec exercises the real `validateTrigger` idempotency check (step 2)
 * by mocking only its leaf-level dependencies (fs, Octokit).
 *
 * AC-6 acceptance criterion verified.
 * MOCK_API_MODE=true — no real external API calls.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mock state
// ---------------------------------------------------------------------------

/** fs.readFileSync — returns a merged-PR event JSON. */
const mockReadFileSync = vi.hoisted(() => vi.fn<[string, string], string>());

/** Octokit pulls.list — returns an existing docs/sync-* PR with the trigger SHA. */
const mockPullsList = vi.hoisted(() => vi.fn());

/** Octokit repos.getBranchProtection — not expected to be reached. */
const mockGetBranchProtection = vi.hoisted(() => vi.fn());

// ---------------------------------------------------------------------------
// Module mocks
// The real validateTrigger is NOT mocked — it must run so the idempotency
// check fires for real.
// ---------------------------------------------------------------------------

vi.mock('fs', () => ({
  readFileSync: mockReadFileSync,
  default: { readFileSync: mockReadFileSync },
}));

vi.mock('@octokit/rest', () => ({
  Octokit: vi.fn().mockImplementation(() => ({
    pulls: { list: mockPullsList },
    repos: {
      getBranchProtection: mockGetBranchProtection,
      getCommit: vi.fn(), // not reached — idempotency exits first
    },
  })),
}));

// ConfluencePublisher: CONFLUENCE_PAGE_ID is unset so the pre-flight check is
// skipped. Mocked as a safety net.
vi.mock('../../src/confluence-publisher/index.js', () => ({
  ConfluencePublisher: vi.fn().mockImplementation(() => ({
    fetchPage: vi.fn().mockResolvedValue({ body: '<h2>fn</h2>', version: 1, title: 'Docs' }),
  })),
}));

// Other pipeline sub-modules — never reached because process.exit(0) fires
// in the idempotency check (step 2 of validateTrigger, before step 3+).
vi.mock('../../src/drift-detector/index.js', () => ({
  detectDrift: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../src/doc-locator/index.js', () => ({
  locateMarkdownSection: vi.fn().mockResolvedValue({ target: 'not-found', sectionContent: '' }),
  locateConfluenceSection: vi.fn().mockResolvedValue({ target: 'not-found', sectionContent: '' }),
  resolveScaffoldTarget: vi.fn().mockReturnValue('docs/api.md'),
}));
vi.mock('../../src/drift-comparator.js', () => ({
  compareDrift: vi.fn().mockReturnValue('not-found'),
}));
vi.mock('../../src/regenerator/index.js', () => ({
  regenerateMarkdownSection: vi.fn().mockReturnValue('updated'),
  regenerateConfluenceSection: vi.fn().mockReturnValue('<h2>fn</h2>'),
  buildScaffoldSection: vi.fn().mockReturnValue('## fn\n'),
}));
vi.mock('../../src/git-publisher/index.js', () => ({
  GitPublisher: vi.fn().mockImplementation(() => ({
    createSyncBranch: vi.fn().mockResolvedValue(undefined),
    writeDocFile: vi.fn().mockResolvedValue(undefined),
    createDefaultDocFile: vi.fn().mockResolvedValue(undefined),
    commitAndPush: vi.fn().mockResolvedValue(undefined),
    createPR: vi.fn().mockResolvedValue('https://github.com/testowner/testrepo/pull/999'),
  })),
}));
vi.mock('fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue(''),
}));

// ---------------------------------------------------------------------------
// Import under test (AFTER vi.mock declarations)
// ---------------------------------------------------------------------------

import { run } from '../../src/pipeline.js';

// ---------------------------------------------------------------------------
// Environment and spy management
// ---------------------------------------------------------------------------

const TRIGGER_SHA = 'sha-idempotency-test-abc123456789';

const MANAGED_ENV_VARS = [
  'MOCK_API_MODE',
  'GITHUB_EVENT_PATH',
  'GITHUB_SHA',
  'GITHUB_REPOSITORY',
  'GITHUB_TOKEN',
  'CONFLUENCE_PAGE_ID',
] as const;

const savedEnv: Partial<Record<string, string>> = {};

let exitSpy: ReturnType<typeof vi.spyOn>;
let consoleLogSpy: ReturnType<typeof vi.spyOn>;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  for (const key of MANAGED_ENV_VARS) {
    savedEnv[key] = process.env[key];
  }

  process.env['MOCK_API_MODE'] = 'true';
  process.env['GITHUB_EVENT_PATH'] = '/tmp/mock-event.json';
  process.env['GITHUB_SHA'] = TRIGGER_SHA;
  process.env['GITHUB_REPOSITORY'] = 'testowner/testrepo';
  process.env['GITHUB_TOKEN'] = 'mock-github-token';
  // No CONFLUENCE_PAGE_ID → Confluence pre-flight check is skipped
  delete process.env['CONFLUENCE_PAGE_ID'];

  // Resets
  mockReadFileSync.mockReset();
  mockPullsList.mockReset();
  mockGetBranchProtection.mockReset();

  // fs.readFileSync returns a merged-PR event
  mockReadFileSync.mockReturnValue(
    JSON.stringify({ pull_request: { merged: true, number: 50 } }),
  );

  // Octokit.pulls.list returns one existing docs/sync-* PR whose body contains
  // the current GITHUB_SHA after "Triggered-by:" — triggers idempotency exit.
  mockPullsList.mockResolvedValue({
    data: [
      {
        head: { ref: 'docs/sync-20260820T000000Z' },
        body: `Triggered-by: ${TRIGGER_SHA}\n\n<!-- doc-sync-meta: {} -->`,
        html_url: 'https://github.com/testowner/testrepo/pull/42',
        number: 42,
      },
    ],
  });

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

describe('e2e: idempotency — duplicate run for the same SHA exits 0 without opening a second PR', () => {
  it('resolves normally (does not throw) when an existing matching PR is found', async () => {
    // run() should return without throwing because the catch block returns
    // early when it detects the 'process.exit(0)' error message.
    await run();

    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('logs a DUPLICATE_PR skip message before calling process.exit(0)', async () => {
    await run();

    const logCalls = consoleLogSpy.mock.calls.map((args) => args[0] as string);
    const hasDuplicateLog = logCalls.some((msg) => msg.includes('DUPLICATE_PR'));
    expect(hasDuplicateLog).toBe(true);
  });

  it('does not call process.exit(1) — the pipeline exits cleanly', async () => {
    await run();

    const exitCodes = exitSpy.mock.calls.map((args) => args[0]);
    expect(exitCodes).not.toContain(1);
  });

  it('proceeds normally when no matching docs/sync-* PR exists', async () => {
    // Override: no existing PRs → idempotency check passes and validateTrigger
    // continues to step 5 (getCommit), so we must mock that too.
    const { Octokit } = await import('@octokit/rest');
    (Octokit as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      pulls: {
        list: vi.fn().mockResolvedValue({ data: [] }),
      },
      repos: {
        getBranchProtection: vi.fn().mockRejectedValue(new Error('404')),
        getCommit: vi.fn().mockResolvedValue({ data: { files: [] } }),
      },
    }));

    // run() should complete normally (no process.exit called)
    await run();

    // If called at all, it should NOT be called with 0 (from idempotency)
    const idempotencyCall = exitSpy.mock.calls.find((args) => args[0] === 0);
    expect(idempotencyCall).toBeUndefined();
  });
});
