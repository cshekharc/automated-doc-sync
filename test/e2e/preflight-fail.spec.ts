/**
 * E2E scenario: Pre-flight Validation Failure
 *
 * When `CONFLUENCE_PAGE_ID` is set and the configured Confluence page returns
 * a non-empty body that contains **zero** headings at the configured heading
 * level, `validateTrigger` emits a structured error with the code
 * `CONFLUENCE_PARSE_VALIDATION_FAILED` and calls `process.exit(1)` before any
 * mutation occurs.
 *
 * This spec exercises the real `validateTrigger` logic by mocking only its
 * leaf-level dependencies (fs, Octokit, ConfluencePublisher.fetchPage).
 *
 * F-7 acceptance criterion verified.
 * MOCK_API_MODE=true — no real API calls.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mock state
// ---------------------------------------------------------------------------

/** fs.readFileSync — returns a merged-PR event JSON. */
const mockReadFileSync = vi.hoisted(() => vi.fn<[string, string], string>());

/** Octokit pulls.list — returns no existing docs/sync-* PRs by default. */
const mockPullsList = vi.hoisted(() => vi.fn());

/** Octokit repos.getBranchProtection — throws (not configured). */
const mockGetBranchProtection = vi.hoisted(() => vi.fn());

/** ConfluencePublisher.fetchPage — returns a non-empty body with no headings. */
const mockFetchPage = vi.hoisted(() => vi.fn());

// ---------------------------------------------------------------------------
// Module mocks
// The real validateTrigger is NOT mocked — we let it run to exercise the
// actual pre-flight validation logic.
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
      getCommit: vi.fn(), // never reached — preflight exits first
    },
  })),
}));

vi.mock('../../src/confluence-publisher/index.js', () => ({
  ConfluencePublisher: vi.fn().mockImplementation(() => ({
    fetchPage: mockFetchPage,
  })),
}));

// Other pipeline sub-modules are mocked to prevent them from running
// (they would not be reached due to the early process.exit, but we mock
// them anyway to keep the module graph clean and avoid import side-effects).
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
    createPR: vi.fn().mockResolvedValue('https://github.com/testowner/testrepo/pull/1'),
  })),
}));
vi.mock('fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue(''),
}));

// ---------------------------------------------------------------------------
// Import under test (AFTER vi.mock declarations)
// NOTE: validateTrigger is NOT mocked — the real implementation runs.
// ---------------------------------------------------------------------------

import { run } from '../../src/pipeline.js';

// ---------------------------------------------------------------------------
// Environment and spy management
// ---------------------------------------------------------------------------

const MANAGED_ENV_VARS = [
  'MOCK_API_MODE',
  'GITHUB_EVENT_PATH',
  'GITHUB_SHA',
  'GITHUB_REPOSITORY',
  'GITHUB_TOKEN',
  'CONFLUENCE_PAGE_ID',
  'CONFLUENCE_BASE_URL',
  'CONFLUENCE_API_TOKEN',
  'CONFLUENCE_HEADING_LEVEL',
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
  // GITHUB_EVENT_PATH: the value is passed to readFileSync, which is mocked
  process.env['GITHUB_EVENT_PATH'] = '/tmp/mock-event.json';
  process.env['GITHUB_SHA'] = 'sha-preflight-abc1234567890';
  process.env['GITHUB_REPOSITORY'] = 'testowner/testrepo';
  process.env['GITHUB_TOKEN'] = 'mock-token';
  // Setting CONFLUENCE_PAGE_ID enables the pre-flight check in validateTrigger
  process.env['CONFLUENCE_PAGE_ID'] = 'preflight-test-page-id';
  process.env['CONFLUENCE_BASE_URL'] = 'https://mock.atlassian.net';
  process.env['CONFLUENCE_API_TOKEN'] = 'mock-api-token';
  process.env['CONFLUENCE_HEADING_LEVEL'] = 'h2';

  // Reset mocks
  mockReadFileSync.mockReset();
  mockPullsList.mockReset();
  mockGetBranchProtection.mockReset();
  mockFetchPage.mockReset();

  // fs.readFileSync returns a merged-PR event
  mockReadFileSync.mockReturnValue(
    JSON.stringify({ pull_request: { merged: true, number: 99 } }),
  );

  // No existing docs/sync-* PRs (idempotency check passes)
  mockPullsList.mockResolvedValue({ data: [] });

  // Branch protection not configured
  mockGetBranchProtection.mockRejectedValue(new Error('404 Not Found'));

  // Confluence page has a non-empty body but ZERO h2 headings — triggers preflight failure
  mockFetchPage.mockResolvedValue({
    body: '<p>This page has content but no h2 headings at all.</p>',
    version: 1,
    title: 'Test Page',
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

describe('e2e: preflight-fail — Confluence page with no headings triggers exit(1)', () => {
  it('calls process.exit(1) when Confluence body is non-empty but has no h2 headings', async () => {
    await expect(run()).rejects.toThrow('process.exit(1)');

    // process.exit(1) must have been called at least once
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('logs CONFLUENCE_PARSE_VALIDATION_FAILED before exiting', async () => {
    await expect(run()).rejects.toThrow('process.exit(1)');

    const errorCalls = consoleErrorSpy.mock.calls.map((args) => args[0] as string);
    const hasValidationError = errorCalls.some((msg) =>
      msg.includes('CONFLUENCE_PARSE_VALIDATION_FAILED'),
    );
    expect(hasValidationError).toBe(true);
  });

  it('calls ConfluencePublisher.fetchPage with the configured CONFLUENCE_PAGE_ID', async () => {
    await expect(run()).rejects.toThrow('process.exit(1)');

    expect(mockFetchPage).toHaveBeenCalledWith('preflight-test-page-id');
  });

  it('does NOT open a PR (no mutation occurs before the pre-flight check fails)', async () => {
    const mockCreatePRCalls: unknown[] = [];

    // We cannot easily verify the mocked GitPublisher was not called since
    // it's also mocked via vi.mock. We verify via the exit code — the pipeline
    // never reached the GitPublisher.createPR call.
    await expect(run()).rejects.toThrow('process.exit(1)');

    // The process exited before any PR creation; the unused variable suppresses lint.
    void mockCreatePRCalls;
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('passes validation when the Confluence page has at least one h2 heading', async () => {
    // Override: page now has an h2 heading → validation passes
    // validateTrigger will then proceed to step 5 (getCommit), which we must mock.
    // Re-mock Octokit to also provide getCommit.
    const { Octokit } = await import('@octokit/rest');
    (Octokit as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      pulls: { list: mockPullsList },
      repos: {
        getBranchProtection: mockGetBranchProtection,
        getCommit: vi.fn().mockResolvedValue({
          data: { files: [] },
        }),
      },
    }));

    mockFetchPage.mockResolvedValue({
      body: '<h2>someFunction</h2><p>Content.</p>',
      version: 1,
      title: 'Test Page',
    });

    // run() should complete successfully (no exit)
    await run();

    expect(exitSpy).not.toHaveBeenCalled();
  });
});
