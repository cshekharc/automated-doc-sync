/**
 * Unit tests for T-13 — TriggerValidator.
 *
 * All external dependencies are mocked:
 * - `fs`                                — `readFileSync` returns event JSON fixtures.
 * - `@octokit/rest`                     — `pulls.list`, `repos.getBranchProtection`,
 *                                         `repos.getCommit` are vi.fn() stubs.
 * - `../../src/confluence-publisher/index.js` — `ConfluencePublisher.fetchPage` stub.
 *
 * `process.exit` is intercepted via `vi.spyOn` and replaced with an
 * implementation that throws so tests can assert on the exit code without
 * actually terminating the process.
 *
 * Acceptance criteria verified:
 * - Non-merged PR event → structured error log `{ error: "NOT_A_MERGED_PR" }`,
 *   `process.exit(1)` called.
 * - Existing `docs/sync-*` PR with matching SHA → structured skip log
 *   `{ skipped: true, reason: "DUPLICATE_PR" }`, `process.exit(0)` called;
 *   no downstream API calls made.
 * - `CONFLUENCE_PAGE_ID` configured, non-empty page body with 0 headings →
 *   structured error log `{ error: "CONFLUENCE_PARSE_VALIDATION_FAILED" }`,
 *   `process.exit(1)` called.
 * - `CONFLUENCE_PAGE_ID` configured, page body has ≥1 heading → validation
 *   passes; returns `TriggerContext` with correct fields.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist mocks — must be declared before any module import is resolved.
// ---------------------------------------------------------------------------

/** Mock for fs.readFileSync — returns the event JSON string. */
const mockReadFileSync = vi.hoisted(() => vi.fn<[string, string], string>());

/** Mock for Octokit pulls.list */
const mockPullsList = vi.hoisted(() => vi.fn());

/** Mock for Octokit repos.getBranchProtection */
const mockGetBranchProtection = vi.hoisted(() => vi.fn());

/** Mock for Octokit repos.getCommit */
const mockGetCommit = vi.hoisted(() => vi.fn());

/** Mock for ConfluencePublisher.fetchPage */
const mockFetchPage = vi.hoisted(() => vi.fn());

// ---------------------------------------------------------------------------
// Module mocks (must appear before any import of the module under test)
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
      getCommit: mockGetCommit,
    },
  })),
}));

vi.mock('../../src/confluence-publisher/index.js', () => ({
  ConfluencePublisher: vi.fn().mockImplementation(() => ({
    fetchPage: mockFetchPage,
  })),
}));

// ---------------------------------------------------------------------------
// Imports under test (AFTER vi.mock declarations)
// ---------------------------------------------------------------------------

import { validateTrigger } from '../../src/trigger-validator.js';
import { RollbackManager } from '../../src/rollback-manager.js';

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

/** Builds a merged-PR event JSON string. */
function makeMergedEvent(): string {
  return JSON.stringify({ pull_request: { merged: true, number: 7 } });
}

/** Builds a non-merged PR event JSON string. */
function makeNonMergedEvent(): string {
  return JSON.stringify({ pull_request: { merged: false, number: 7 } });
}

/** Builds a non-PR event JSON string (e.g. a push). */
function makeNonPrEvent(): string {
  return JSON.stringify({ ref: 'refs/heads/main' });
}

/** Default commit response with configurable file list. */
function makeCommitResponse(filenames: string[] = []) {
  return {
    data: {
      files: filenames.map(f => ({ filename: f, status: 'modified' })),
    },
  };
}

/** Default pulls.list response — an empty page (no duplicate). */
function makeEmptyPrList() {
  return { data: [] };
}

/** Builds a PR list response with one docs/sync-* PR that has the given body. */
function makeSyncPrList(headRef: string, body: string, htmlUrl: string) {
  return {
    data: [
      {
        head: { ref: headRef },
        body,
        html_url: htmlUrl,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Managed environment variables
// ---------------------------------------------------------------------------

const MANAGED_ENV_VARS = [
  'GITHUB_EVENT_PATH',
  'GITHUB_SHA',
  'GITHUB_REPOSITORY',
  'GITHUB_TOKEN',
  'CONFLUENCE_PAGE_ID',
  'CONFLUENCE_HEADING_LEVEL',
] as const;

const savedEnv: Partial<Record<string, string>> = {};

// ---------------------------------------------------------------------------
// Shared setup / teardown
// ---------------------------------------------------------------------------

let rollback: RollbackManager;
let exitSpy: ReturnType<typeof vi.spyOn>;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
let consoleLogSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // Save and clear managed env vars before each test.
  for (const key of MANAGED_ENV_VARS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }

  // Baseline env vars for most tests.
  process.env['GITHUB_EVENT_PATH'] = '/tmp/github-event.json';
  process.env['GITHUB_SHA'] = 'deadbeef1234567890abcdef1234567890abcdef';
  process.env['GITHUB_REPOSITORY'] = 'testowner/testrepo';
  process.env['GITHUB_TOKEN'] = 'ghp_test_token_placeholder_xxxxxxxxxxxxxxx';

  // Reset all mocks to clean state.
  mockReadFileSync.mockReset().mockReturnValue(makeMergedEvent());
  mockPullsList.mockReset().mockResolvedValue(makeEmptyPrList());
  mockGetBranchProtection.mockReset().mockRejectedValue(
    Object.assign(new Error('Branch protection not configured'), { status: 404 }),
  );
  mockGetCommit
    .mockReset()
    .mockResolvedValue(makeCommitResponse(['src/utils.ts', 'src/index.ts', 'docs/api.md']));
  mockFetchPage.mockReset().mockResolvedValue({ body: '<h2>myFn</h2><p>Body.</p>', version: 1 });

  // Create a fresh RollbackManager for each test.
  rollback = new RollbackManager();

  // Mock process.exit to throw so tests can intercept the call.
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: number) => {
    throw new Error(`process.exit(${code ?? 0})`);
  }) as ReturnType<typeof vi.spyOn>;

  // Suppress console output; captured via spies where assertions need it.
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  // Restore managed env vars.
  for (const key of MANAGED_ENV_VARS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }

  // Restore spies.
  exitSpy.mockRestore();
  consoleErrorSpy.mockRestore();
  consoleLogSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// Step 1 — Merge event validation
// ---------------------------------------------------------------------------

describe('Step 1 — merge event validation', () => {
  it('calls process.exit(1) and logs NOT_A_MERGED_PR when pull_request.merged is false', async () => {
    mockReadFileSync.mockReturnValue(makeNonMergedEvent());

    await expect(validateTrigger(rollback)).rejects.toThrow('process.exit(1)');

    expect(exitSpy).toHaveBeenCalledWith(1);

    const errorArg = consoleErrorSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(errorArg) as Record<string, unknown>;
    expect(parsed['error']).toBe('NOT_A_MERGED_PR');
  });

  it('calls process.exit(1) when the event has no pull_request field at all', async () => {
    mockReadFileSync.mockReturnValue(makeNonPrEvent());

    await expect(validateTrigger(rollback)).rejects.toThrow('process.exit(1)');

    expect(exitSpy).toHaveBeenCalledWith(1);

    const errorArg = consoleErrorSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(errorArg) as Record<string, unknown>;
    expect(parsed['error']).toBe('NOT_A_MERGED_PR');
  });

  it('does NOT call process.exit when pull_request.merged is true', async () => {
    mockReadFileSync.mockReturnValue(makeMergedEvent());

    // Should not throw (process.exit is mocked to throw).
    await expect(validateTrigger(rollback)).resolves.toBeDefined();

    expect(exitSpy).not.toHaveBeenCalledWith(1);
  });

  it('does not make any Octokit calls when the event fails validation', async () => {
    mockReadFileSync.mockReturnValue(makeNonMergedEvent());

    await expect(validateTrigger(rollback)).rejects.toThrow('process.exit(1)');

    expect(mockPullsList).not.toHaveBeenCalled();
    expect(mockGetBranchProtection).not.toHaveBeenCalled();
    expect(mockGetCommit).not.toHaveBeenCalled();
    expect(mockFetchPage).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Step 2 — Idempotency check
// ---------------------------------------------------------------------------

describe('Step 2 — idempotency check', () => {
  it('calls process.exit(0) and logs DUPLICATE_PR when a docs/sync-* PR with matching SHA is found', async () => {
    const sha = process.env['GITHUB_SHA']!;
    mockPullsList.mockResolvedValue(
      makeSyncPrList(
        'docs/sync-20260820T143000Z',
        `Triggered-by: ${sha}\n\nMore content.`,
        'https://github.com/testowner/testrepo/pull/99',
      ),
    );

    await expect(validateTrigger(rollback)).rejects.toThrow('process.exit(0)');

    expect(exitSpy).toHaveBeenCalledWith(0);

    const logArg = consoleLogSpy.mock.calls.find(call => {
      try {
        const parsed = JSON.parse(call[0] as string) as Record<string, unknown>;
        return parsed['reason'] === 'DUPLICATE_PR';
      } catch {
        return false;
      }
    });
    expect(logArg).toBeDefined();

    const parsed = JSON.parse(logArg![0] as string) as Record<string, unknown>;
    expect(parsed['skipped']).toBe(true);
    expect(parsed['reason']).toBe('DUPLICATE_PR');
    expect(parsed['existingPrUrl']).toBe('https://github.com/testowner/testrepo/pull/99');
  });

  it('does not call getBranchProtection, getCommit, or fetchPage when a duplicate is found', async () => {
    const sha = process.env['GITHUB_SHA']!;
    mockPullsList.mockResolvedValue(
      makeSyncPrList(
        'docs/sync-test',
        `Triggered-by: ${sha}`,
        'https://github.com/testowner/testrepo/pull/55',
      ),
    );

    await expect(validateTrigger(rollback)).rejects.toThrow('process.exit(0)');

    expect(mockGetBranchProtection).not.toHaveBeenCalled();
    expect(mockGetCommit).not.toHaveBeenCalled();
    expect(mockFetchPage).not.toHaveBeenCalled();
  });

  it('does NOT exit when a docs/sync-* PR exists but body has a different SHA', async () => {
    mockPullsList.mockResolvedValue(
      makeSyncPrList(
        'docs/sync-old',
        'Triggered-by: differentsha000000000000000000000000000',
        'https://github.com/testowner/testrepo/pull/10',
      ),
    );

    await expect(validateTrigger(rollback)).resolves.toBeDefined();

    expect(exitSpy).not.toHaveBeenCalledWith(0);
  });

  it('does NOT exit when an open PR head.ref does not start with docs/sync-', async () => {
    const sha = process.env['GITHUB_SHA']!;
    mockPullsList.mockResolvedValue({
      data: [
        {
          head: { ref: 'feat/some-feature' },
          body: `Triggered-by: ${sha}`,
          html_url: 'https://github.com/testowner/testrepo/pull/20',
        },
      ],
    });

    await expect(validateTrigger(rollback)).resolves.toBeDefined();

    expect(exitSpy).not.toHaveBeenCalledWith(0);
  });

  it('paginates to the second page when the first page returns 100 PRs', async () => {
    const sha = process.env['GITHUB_SHA']!;

    // First call: 100 PRs, none matching
    const firstPage = Array.from({ length: 100 }, (_, i) => ({
      head: { ref: `feat/feature-${i}` },
      body: 'No trigger here',
      html_url: `https://github.com/testowner/testrepo/pull/${i + 1}`,
    }));

    // Second call: one matching docs/sync-* PR
    const secondPage = [
      {
        head: { ref: 'docs/sync-20260820T000000Z' },
        body: `Triggered-by: ${sha}`,
        html_url: 'https://github.com/testowner/testrepo/pull/200',
      },
    ];

    mockPullsList
      .mockResolvedValueOnce({ data: firstPage })
      .mockResolvedValueOnce({ data: secondPage });

    await expect(validateTrigger(rollback)).rejects.toThrow('process.exit(0)');

    expect(mockPullsList).toHaveBeenCalledTimes(2);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('stops paginating after a page with fewer than 100 PRs', async () => {
    // Only 3 PRs, none matching → stop after one page
    mockPullsList.mockResolvedValue({
      data: Array.from({ length: 3 }, (_, i) => ({
        head: { ref: `feat/feature-${i}` },
        body: 'No match',
        html_url: `https://github.com/testowner/testrepo/pull/${i + 1}`,
      })),
    });

    await expect(validateTrigger(rollback)).resolves.toBeDefined();

    expect(mockPullsList).toHaveBeenCalledTimes(1);
    expect(exitSpy).not.toHaveBeenCalledWith(0);
  });
});

// ---------------------------------------------------------------------------
// Step 3 — Branch protection pre-check
// ---------------------------------------------------------------------------

describe('Step 3 — branch protection pre-check', () => {
  it('logs a warning when the protection response contains a restrictions field', async () => {
    mockGetBranchProtection.mockResolvedValue({
      data: { restrictions: { users: [], teams: [] } },
    });

    await expect(validateTrigger(rollback)).resolves.toBeDefined();

    const warningCall = consoleLogSpy.mock.calls.find(call => {
      try {
        const parsed = JSON.parse(call[0] as string) as Record<string, unknown>;
        return parsed['warning'] === 'BRANCH_PROTECTION_RESTRICTIONS';
      } catch {
        return false;
      }
    });
    expect(warningCall).toBeDefined();
  });

  it('logs a skip warning and continues when getBranchProtection throws 404', async () => {
    mockGetBranchProtection.mockRejectedValue(
      Object.assign(new Error('Not Found'), { status: 404 }),
    );

    // Should NOT exit; continues and resolves with TriggerContext
    await expect(validateTrigger(rollback)).resolves.toBeDefined();

    const skipCall = consoleLogSpy.mock.calls.find(call => {
      try {
        const parsed = JSON.parse(call[0] as string) as Record<string, unknown>;
        return parsed['warning'] === 'BRANCH_PROTECTION_CHECK_SKIPPED';
      } catch {
        return false;
      }
    });
    expect(skipCall).toBeDefined();
  });

  it('does not call process.exit for any branch protection result', async () => {
    // With restrictions
    mockGetBranchProtection.mockResolvedValue({
      data: { restrictions: { users: [], teams: [] } },
    });

    await expect(validateTrigger(rollback)).resolves.toBeDefined();

    // exit(1) should NOT have been called due to branch protection
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Step 4 — Confluence pre-flight validation
// ---------------------------------------------------------------------------

describe('Step 4 — Confluence pre-flight validation', () => {
  beforeEach(() => {
    process.env['CONFLUENCE_PAGE_ID'] = 'test-page-32833537';
  });

  it('calls process.exit(1) and logs CONFLUENCE_PARSE_VALIDATION_FAILED when body is non-empty with 0 headings', async () => {
    mockFetchPage.mockResolvedValue({ body: '<p>No headings in this body.</p>', version: 1 });

    await expect(validateTrigger(rollback)).rejects.toThrow('process.exit(1)');

    expect(exitSpy).toHaveBeenCalledWith(1);

    const errorArg = consoleErrorSpy.mock.calls.find(call => {
      try {
        const parsed = JSON.parse(call[0] as string) as Record<string, unknown>;
        return parsed['error'] === 'CONFLUENCE_PARSE_VALIDATION_FAILED';
      } catch {
        return false;
      }
    });
    expect(errorArg).toBeDefined();
  });

  it('does not call getCommit or make mutations when Confluence validation fails', async () => {
    mockFetchPage.mockResolvedValue({ body: '<p>No headings.</p>', version: 1 });

    await expect(validateTrigger(rollback)).rejects.toThrow('process.exit(1)');

    expect(mockGetCommit).not.toHaveBeenCalled();
  });

  it('does NOT exit when the Confluence page has at least one h2 heading', async () => {
    mockFetchPage.mockResolvedValue({
      body: '<h2>myFunction</h2><p>Description.</p>',
      version: 3,
    });

    const ctx = await validateTrigger(rollback);

    expect(exitSpy).not.toHaveBeenCalledWith(1);
    expect(ctx).toBeDefined();
  });

  it('does NOT exit when the Confluence page body is empty (zero-length body)', async () => {
    // Empty body: non-empty check fails → no error
    mockFetchPage.mockResolvedValue({ body: '', version: 1 });

    await expect(validateTrigger(rollback)).resolves.toBeDefined();

    expect(exitSpy).not.toHaveBeenCalledWith(1);
  });

  it('passes validation when page has multiple h2 headings', async () => {
    mockFetchPage.mockResolvedValue({
      body: '<h2>fn1</h2><p>Doc.</p><h2>fn2</h2><p>Doc2.</p>',
      version: 2,
    });

    const ctx = await validateTrigger(rollback);

    expect(ctx).toBeDefined();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('respects CONFLUENCE_HEADING_LEVEL=h3 when counting headings', async () => {
    process.env['CONFLUENCE_HEADING_LEVEL'] = 'h3';

    // Body has h3 headings but no h2 — should NOT fail when level is h3
    mockFetchPage.mockResolvedValue({
      body: '<h3>myFunction</h3><p>Body.</p>',
      version: 1,
    });

    await expect(validateTrigger(rollback)).resolves.toBeDefined();

    expect(exitSpy).not.toHaveBeenCalledWith(1);
  });

  it('fails validation when body has h2 headings but level is set to h3', async () => {
    process.env['CONFLUENCE_HEADING_LEVEL'] = 'h3';

    // Body only has h2; with level=h3, count=0 → should fail
    mockFetchPage.mockResolvedValue({
      body: '<h2>myFunction</h2><p>Body.</p>',
      version: 1,
    });

    await expect(validateTrigger(rollback)).rejects.toThrow('process.exit(1)');

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('skips Confluence validation and logs a warning when CONFLUENCE_PAGE_ID is not set', async () => {
    delete process.env['CONFLUENCE_PAGE_ID'];

    await expect(validateTrigger(rollback)).resolves.toBeDefined();

    expect(mockFetchPage).not.toHaveBeenCalled();

    const warnCall = consoleLogSpy.mock.calls.find(call => {
      try {
        const parsed = JSON.parse(call[0] as string) as Record<string, unknown>;
        return parsed['warning'] === 'CONFLUENCE_PAGE_ID_NOT_SET';
      } catch {
        return false;
      }
    });
    expect(warnCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Step 5 — Changed files and returned TriggerContext
// ---------------------------------------------------------------------------

describe('Step 5 — changed files and TriggerContext', () => {
  it('returns a TriggerContext with the correct mergeSha, baseSha, owner, and repo', async () => {
    const sha = process.env['GITHUB_SHA']!;

    const ctx = await validateTrigger(rollback);

    expect(ctx.mergeSha).toBe(sha);
    expect(ctx.baseSha).toBe(`${sha}^1`);
    expect(ctx.owner).toBe('testowner');
    expect(ctx.repo).toBe('testrepo');
  });

  it('filters changed files to .ts files under src/', async () => {
    mockGetCommit.mockResolvedValue(
      makeCommitResponse([
        'src/utils.ts',
        'src/index.ts',
        'docs/api.md',
        'src/helper.js',
        'test/unit/foo.test.ts',
        'src/sub/module.ts',
      ]),
    );

    const ctx = await validateTrigger(rollback);

    expect(ctx.changedFiles).toEqual(['src/utils.ts', 'src/index.ts', 'src/sub/module.ts']);
  });

  it('returns an empty changedFiles array when no .ts files under src/ changed', async () => {
    mockGetCommit.mockResolvedValue(makeCommitResponse(['docs/api.md', 'README.md']));

    const ctx = await validateTrigger(rollback);

    expect(ctx.changedFiles).toEqual([]);
  });

  it('calls getCommit with the correct owner, repo, and ref (GITHUB_SHA)', async () => {
    await validateTrigger(rollback);

    expect(mockGetCommit).toHaveBeenCalledOnce();
    const [args] = mockGetCommit.mock.calls[0] as [
      { owner: string; repo: string; ref: string },
    ];
    expect(args.owner).toBe('testowner');
    expect(args.repo).toBe('testrepo');
    expect(args.ref).toBe(process.env['GITHUB_SHA']);
  });

  it('handles missing files array in commit response gracefully', async () => {
    mockGetCommit.mockResolvedValue({ data: {} });

    const ctx = await validateTrigger(rollback);

    expect(ctx.changedFiles).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Secrets redaction in output
// ---------------------------------------------------------------------------

describe('secrets redaction in console output', () => {
  it('does not expose GITHUB_TOKEN in any console output', async () => {
    const token = 'ghp_UnitTestTokenThatShouldBeRedactedXXXXXXXX';
    process.env['GITHUB_TOKEN'] = token;

    const capturedLogs: string[] = [];
    const capturedErrors: string[] = [];

    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    vi.spyOn(console, 'log').mockImplementation((...args) => {
      capturedLogs.push(args.map(String).join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation((...args) => {
      capturedErrors.push(args.map(String).join(' '));
    });

    await validateTrigger(rollback);

    const allOutput = [...capturedLogs, ...capturedErrors].join('\n');
    expect(allOutput).not.toContain(token);
  });
});
