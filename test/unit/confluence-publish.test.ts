/**
 * Unit tests for ConfluencePublish (T-14) — Workflow 2 entry point.
 *
 * All external dependencies are mocked:
 * - `@octokit/rest` → `mockPullsGet` stub that returns a PR with a
 *   configurable body.
 * - `axios` → `mockAxiosGet` and `mockAxiosPut` stubs for Confluence
 *   GET and PUT calls.
 * - `fs/promises` → `mockReadFile` stub for loading
 *   `docs/confluence-map.json`.
 *
 * Acceptance criteria verified:
 * - Page ID in allowlist + status `"draft"` → PUT issued with
 *   `status: "current"` and incremented version number (W-2).
 * - Page ID NOT in allowlist → `console.warn` with
 *   `CONFLUENCE_PAGE_NOT_ALLOWLISTED`, PUT skipped (W-2).
 * - Page ID in allowlist but status not `"draft"` → informational log,
 *   PUT skipped.
 * - Malformed `doc-sync-meta` block → structured error logged,
 *   `process.exit(1)` called.
 * - `CONFLUENCE_API_TOKEN` value does not appear in stdout.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist mocks — vi.hoisted() ensures availability inside vi.mock() factories
// ---------------------------------------------------------------------------

/** Octokit pulls.get stub — returns a PR with a controllable body. */
const mockPullsGet = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ data: { body: '' } }),
);

/** axios.get stub — returns a Confluence page object. */
const mockAxiosGet = vi.hoisted(() => vi.fn());

/** axios.put stub — simulates the Confluence publish PUT. */
const mockAxiosPut = vi.hoisted(() => vi.fn().mockResolvedValue({ data: {} }));

/** fs/promises.readFile stub — returns a serialised confluence-map.json. */
const mockReadFile = vi.hoisted(() => vi.fn());

// ---------------------------------------------------------------------------
// Module mocks (must precede any import of the module under test)
// ---------------------------------------------------------------------------

vi.mock('@octokit/rest', () => ({
  Octokit: vi.fn().mockImplementation(() => ({
    pulls: { get: mockPullsGet },
  })),
}));

vi.mock('axios', () => ({
  default: {
    get: mockAxiosGet,
    put: mockAxiosPut,
  },
}));

vi.mock('fs/promises', () => ({
  readFile: mockReadFile,
}));

// ---------------------------------------------------------------------------
// Import the module under test (AFTER vi.mock declarations)
// ---------------------------------------------------------------------------

import { publishConfluenceDrafts } from '../../src/confluence-publish.js';

// ---------------------------------------------------------------------------
// Managed environment variables
// ---------------------------------------------------------------------------

const MANAGED_ENV_VARS = [
  'GITHUB_TOKEN',
  'GITHUB_REPOSITORY',
  'GITHUB_PR_NUMBER',
  'CONFLUENCE_BASE_URL',
  'CONFLUENCE_USERNAME',
  'CONFLUENCE_API_TOKEN',
  'CONFLUENCE_PAGE_ID',
  'CONFLUENCE_REQUEST_TIMEOUT_MS',
] as const;

const savedEnv: Partial<Record<string, string>> = {};

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Builds a syntactically valid PR body containing a `doc-sync-meta` block
 * with the supplied `confluenceDrafts` array.
 */
function makeValidPrBody(confluenceDrafts: string[], triggerSha = 'sha123'): string {
  const meta = JSON.stringify({ triggerSha, confluenceDrafts });
  return `Triggered-by: ${triggerSha}\n<!-- doc-sync-meta: ${meta} -->`;
}

/**
 * Default Confluence page fixture returned by the mock GET for a draft page.
 */
const DRAFT_PAGE = {
  status: 'draft',
  version: { number: 3 },
  title: 'Test API Page',
};

// ---------------------------------------------------------------------------
// Shared setup / teardown
// ---------------------------------------------------------------------------

let exitSpy: ReturnType<typeof vi.spyOn>;
let consoleLogSpy: ReturnType<typeof vi.spyOn>;
let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // Save and clear all managed env vars
  for (const key of MANAGED_ENV_VARS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }

  // Apply baseline env vars needed for most tests
  process.env['GITHUB_TOKEN'] = 'ghp_test_token_placeholder_xxxxxxxxxxxxxxx';
  process.env['GITHUB_REPOSITORY'] = 'testowner/testrepo';
  process.env['GITHUB_PR_NUMBER'] = '42';
  process.env['CONFLUENCE_BASE_URL'] = 'https://example.atlassian.net';
  process.env['CONFLUENCE_USERNAME'] = 'test@example.com';
  process.env['CONFLUENCE_API_TOKEN'] = 'test-api-token-not-a-real-secret';
  process.env['CONFLUENCE_REQUEST_TIMEOUT_MS'] = '5000';

  // Reset all stubs
  mockPullsGet.mockReset().mockResolvedValue({ data: { body: '' } });
  mockAxiosGet.mockReset();
  mockAxiosPut.mockReset().mockResolvedValue({ data: {} });
  // Default: empty confluence-map.json (allowlist is built from CONFLUENCE_PAGE_ID only)
  mockReadFile.mockReset().mockResolvedValue(JSON.stringify({ _comment: 'test map' }));

  // Mock process.exit to throw so tests can intercept it.
  // This prevents mocked exit from silently allowing code to continue.
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: number) => {
    throw new Error(`process.exit(${code ?? 0})`);
  }) as ReturnType<typeof vi.spyOn>;

  consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  // Restore env vars
  for (const key of MANAGED_ENV_VARS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }

  // Restore spies
  exitSpy.mockRestore();
  consoleLogSpy.mockRestore();
  consoleWarnSpy.mockRestore();
  consoleErrorSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// Scenario 1: Page ID in allowlist + status "draft" → PUT issued (W-2)
// ---------------------------------------------------------------------------

describe('Scenario 1 — allowlisted draft page is published', () => {
  beforeEach(() => {
    process.env['CONFLUENCE_PAGE_ID'] = 'page-draft-001';
    mockPullsGet.mockResolvedValue({
      data: { body: makeValidPrBody(['page-draft-001']) },
    });
    mockAxiosGet.mockResolvedValue({ data: DRAFT_PAGE });
  });

  it('calls PUT with status "current" for an allowlisted draft page', async () => {
    await publishConfluenceDrafts();

    expect(mockAxiosPut).toHaveBeenCalledOnce();
    const [, putBody] = mockAxiosPut.mock.calls[0] as [string, Record<string, unknown>];
    expect(putBody['status']).toBe('current');
  });

  it('increments the version number by 1 in the PUT body', async () => {
    await publishConfluenceDrafts();

    const [, putBody] = mockAxiosPut.mock.calls[0] as [string, Record<string, unknown>];
    const version = putBody['version'] as { number: number };
    expect(version.number).toBe(DRAFT_PAGE.version.number + 1); // 3 + 1 = 4
  });

  it('sends the PUT to the correct Confluence page URL', async () => {
    await publishConfluenceDrafts();

    const [putUrl] = mockAxiosPut.mock.calls[0] as [string];
    expect(putUrl).toContain('/api/v2/pages/page-draft-001');
  });

  it('includes the page title in the PUT body', async () => {
    await publishConfluenceDrafts();

    const [, putBody] = mockAxiosPut.mock.calls[0] as [string, Record<string, unknown>];
    expect(putBody['title']).toBe(DRAFT_PAGE.title);
  });

  it('calls GET before PUT to verify draft status', async () => {
    const order: string[] = [];
    mockAxiosGet.mockImplementation(() => {
      order.push('GET');
      return Promise.resolve({ data: DRAFT_PAGE });
    });
    mockAxiosPut.mockImplementation(() => {
      order.push('PUT');
      return Promise.resolve({ data: {} });
    });

    await publishConfluenceDrafts();

    expect(order).toEqual(['GET', 'PUT']);
  });

  it('logs a structured success message after publishing', async () => {
    await publishConfluenceDrafts();

    const allLogCalls = consoleLogSpy.mock.calls
      .map(args => String(args[0]))
      .join('\n');
    expect(allLogCalls).toContain('CONFLUENCE_PAGE_PUBLISHED');
    expect(allLogCalls).toContain('page-draft-001');
  });
});

// ---------------------------------------------------------------------------
// Scenario 2 — page ID NOT in allowlist → warning logged, PUT skipped (W-2)
// ---------------------------------------------------------------------------

describe('Scenario 2 — page ID not in allowlist is skipped (W-2)', () => {
  beforeEach(() => {
    // No CONFLUENCE_PAGE_ID set; readFile returns an empty map
    delete process.env['CONFLUENCE_PAGE_ID'];
    mockReadFile.mockResolvedValue(JSON.stringify({ _comment: 'empty map' }));
    mockPullsGet.mockResolvedValue({
      data: { body: makeValidPrBody(['unlisted-page-999']) },
    });
  });

  it('logs a structured CONFLUENCE_PAGE_NOT_ALLOWLISTED warning', async () => {
    await publishConfluenceDrafts();

    const warnCalls = consoleWarnSpy.mock.calls.map(args => String(args[0]));
    const hasWarning = warnCalls.some(msg => msg.includes('CONFLUENCE_PAGE_NOT_ALLOWLISTED'));
    expect(hasWarning).toBe(true);
  });

  it('warning message references the skipped page ID', async () => {
    await publishConfluenceDrafts();

    const warnText = consoleWarnSpy.mock.calls.map(args => String(args[0])).join('\n');
    expect(warnText).toContain('unlisted-page-999');
  });

  it('does NOT issue a GET to Confluence for an unlisted page', async () => {
    await publishConfluenceDrafts();

    expect(mockAxiosGet).not.toHaveBeenCalled();
  });

  it('does NOT issue a PUT for an unlisted page (W-2 enforcement)', async () => {
    await publishConfluenceDrafts();

    expect(mockAxiosPut).not.toHaveBeenCalled();
  });

  it('allowlist built from confluence-map.json values includes real page IDs', async () => {
    // Map contains "src/api.ts" → "map-page-777"
    mockReadFile.mockResolvedValue(
      JSON.stringify({ 'src/api.ts': 'map-page-777' }),
    );
    mockPullsGet.mockResolvedValue({
      data: { body: makeValidPrBody(['map-page-777']) },
    });
    mockAxiosGet.mockResolvedValue({ data: DRAFT_PAGE });

    await publishConfluenceDrafts();

    // map-page-777 IS in the allowlist — PUT should fire
    expect(mockAxiosPut).toHaveBeenCalledOnce();
  });

  it('page ID from CONFLUENCE_PAGE_ID env var is in the allowlist', async () => {
    process.env['CONFLUENCE_PAGE_ID'] = 'env-page-888';
    mockPullsGet.mockResolvedValue({
      data: { body: makeValidPrBody(['env-page-888']) },
    });
    mockAxiosGet.mockResolvedValue({ data: DRAFT_PAGE });

    await publishConfluenceDrafts();

    expect(mockAxiosPut).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Scenario 3 — allowlisted page not in draft status → informational skip
// ---------------------------------------------------------------------------

describe('Scenario 3 — allowlisted page with non-draft status is skipped', () => {
  beforeEach(() => {
    process.env['CONFLUENCE_PAGE_ID'] = 'page-published-456';
    mockPullsGet.mockResolvedValue({
      data: { body: makeValidPrBody(['page-published-456']) },
    });
    // Page is already published (status "current")
    mockAxiosGet.mockResolvedValue({
      data: { status: 'current', version: { number: 7 }, title: 'Already Published' },
    });
  });

  it('does NOT issue a PUT for a page that is not in draft status', async () => {
    await publishConfluenceDrafts();

    expect(mockAxiosPut).not.toHaveBeenCalled();
  });

  it('logs an informational message when skipping a non-draft page', async () => {
    await publishConfluenceDrafts();

    const logText = consoleLogSpy.mock.calls.map(args => String(args[0])).join('\n');
    expect(logText).toContain('CONFLUENCE_PAGE_NOT_DRAFT');
  });

  it('informational log references the page ID and its actual status', async () => {
    await publishConfluenceDrafts();

    const logText = consoleLogSpy.mock.calls.map(args => String(args[0])).join('\n');
    expect(logText).toContain('page-published-456');
    expect(logText).toContain('current');
  });

  it('calls GET to check status before deciding to skip', async () => {
    await publishConfluenceDrafts();

    expect(mockAxiosGet).toHaveBeenCalledOnce();
    const [getUrl] = mockAxiosGet.mock.calls[0] as [string];
    expect(getUrl).toContain('/api/v2/pages/page-published-456');
  });
});

// ---------------------------------------------------------------------------
// Scenario 4 — malformed doc-sync-meta block → structured error + exit(1)
// ---------------------------------------------------------------------------

describe('Scenario 4 — malformed doc-sync-meta block causes process.exit(1)', () => {
  it('calls process.exit(1) when doc-sync-meta block is missing', async () => {
    mockPullsGet.mockResolvedValue({
      data: { body: 'PR body with no meta block at all' },
    });

    await expect(publishConfluenceDrafts()).rejects.toThrow('process.exit(1)');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('logs a structured error when doc-sync-meta block is missing', async () => {
    mockPullsGet.mockResolvedValue({
      data: { body: 'no meta here' },
    });

    await expect(publishConfluenceDrafts()).rejects.toThrow();

    const errorText = consoleErrorSpy.mock.calls.map(args => String(args[0])).join('\n');
    expect(errorText).toContain('DOC_SYNC_META_NOT_FOUND');
  });

  it('calls process.exit(1) when doc-sync-meta contains invalid JSON', async () => {
    mockPullsGet.mockResolvedValue({
      data: { body: '<!-- doc-sync-meta: {not: valid, json} -->' },
    });

    await expect(publishConfluenceDrafts()).rejects.toThrow('process.exit(1)');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('logs a structured error when doc-sync-meta JSON is malformed', async () => {
    // Use braces that satisfy the regex but contain invalid JSON content
    mockPullsGet.mockResolvedValue({
      data: { body: '<!-- doc-sync-meta: {not: valid json value} -->' },
    });

    await expect(publishConfluenceDrafts()).rejects.toThrow();

    const errorText = consoleErrorSpy.mock.calls.map(args => String(args[0])).join('\n');
    expect(errorText).toContain('DOC_SYNC_META_MALFORMED');
  });

  it('does NOT call axios.put when meta is malformed', async () => {
    mockPullsGet.mockResolvedValue({
      data: { body: '<!-- doc-sync-meta: {x -->' },
    });

    await expect(publishConfluenceDrafts()).rejects.toThrow();

    expect(mockAxiosPut).not.toHaveBeenCalled();
  });

  it('handles a null PR body gracefully (treated as missing meta)', async () => {
    mockPullsGet.mockResolvedValue({ data: { body: null } });

    await expect(publishConfluenceDrafts()).rejects.toThrow('process.exit(1)');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

// ---------------------------------------------------------------------------
// Scenario 5 — CONFLUENCE_API_TOKEN must not appear in stdout
// ---------------------------------------------------------------------------

describe('Scenario 5 — CONFLUENCE_API_TOKEN never appears in log output', () => {
  it('does not write the raw CONFLUENCE_API_TOKEN to console.log', async () => {
    const sensitiveToken = 'ATATT3xFfGF0SensitiveTokenValue_1234567890abcdef';
    process.env['CONFLUENCE_API_TOKEN'] = sensitiveToken;
    process.env['CONFLUENCE_PAGE_ID'] = 'page-secret-test';

    mockPullsGet.mockResolvedValue({
      data: { body: makeValidPrBody(['page-secret-test']) },
    });
    mockAxiosGet.mockResolvedValue({ data: DRAFT_PAGE });

    await publishConfluenceDrafts();

    const allLogOutput = consoleLogSpy.mock.calls
      .map(args => args.map(String).join(' '))
      .join('\n');

    expect(allLogOutput).not.toContain(sensitiveToken);
  });

  it('does not write the raw CONFLUENCE_API_TOKEN to console.warn', async () => {
    const sensitiveToken = 'ATATT3xFfGF0SensitiveTokenValue_1234567890abcdef';
    process.env['CONFLUENCE_API_TOKEN'] = sensitiveToken;
    // No page in allowlist → triggers the CONFLUENCE_PAGE_NOT_ALLOWLISTED warn path
    delete process.env['CONFLUENCE_PAGE_ID'];
    mockReadFile.mockResolvedValue(JSON.stringify({}));

    mockPullsGet.mockResolvedValue({
      data: { body: makeValidPrBody(['any-page']) },
    });

    await publishConfluenceDrafts();

    const allWarnOutput = consoleWarnSpy.mock.calls
      .map(args => args.map(String).join(' '))
      .join('\n');

    expect(allWarnOutput).not.toContain(sensitiveToken);
  });

  it('does not write the raw CONFLUENCE_API_TOKEN to console.error on GET failure', async () => {
    const sensitiveToken = 'ATATT3xFfGF0SensitiveTokenValue_1234567890abcdef';
    process.env['CONFLUENCE_API_TOKEN'] = sensitiveToken;
    process.env['CONFLUENCE_PAGE_ID'] = 'page-get-fail';

    mockPullsGet.mockResolvedValue({
      data: { body: makeValidPrBody(['page-get-fail']) },
    });
    // Simulate Confluence GET failure with a message containing the token
    mockAxiosGet.mockRejectedValue(
      new Error(`Request failed: Authorization: Basic ${Buffer.from(`test@example.com:${sensitiveToken}`).toString('base64')}`),
    );

    await publishConfluenceDrafts();

    const allErrorOutput = consoleErrorSpy.mock.calls
      .map(args => args.map(String).join(' '))
      .join('\n');

    // The raw ATATT token should not appear; redactSecrets should mask it
    expect(allErrorOutput).not.toContain(sensitiveToken);
  });
});

// ---------------------------------------------------------------------------
// Mixed-page scenarios — multiple pages, mixed allowlist membership
// ---------------------------------------------------------------------------

describe('Mixed scenarios — multiple pages processed together', () => {
  it('publishes only the allowlisted draft page when list contains both types', async () => {
    process.env['CONFLUENCE_PAGE_ID'] = 'page-good';
    // 'page-bad' is NOT in the allowlist

    mockPullsGet.mockResolvedValue({
      data: { body: makeValidPrBody(['page-good', 'page-bad']) },
    });
    mockAxiosGet.mockResolvedValue({ data: DRAFT_PAGE });

    await publishConfluenceDrafts();

    // Only one PUT (for page-good); page-bad is skipped
    expect(mockAxiosPut).toHaveBeenCalledOnce();
    const [putUrl] = mockAxiosPut.mock.calls[0] as [string];
    expect(putUrl).toContain('page-good');
    expect(putUrl).not.toContain('page-bad');
  });

  it('skips both pages with a warning when neither is allowlisted', async () => {
    delete process.env['CONFLUENCE_PAGE_ID'];
    mockReadFile.mockResolvedValue(JSON.stringify({}));

    mockPullsGet.mockResolvedValue({
      data: { body: makeValidPrBody(['p1', 'p2']) },
    });

    await publishConfluenceDrafts();

    expect(mockAxiosPut).not.toHaveBeenCalled();
    // Two separate warnings, one per page
    const warningCodes = consoleWarnSpy.mock.calls
      .map(args => String(args[0]))
      .filter(msg => msg.includes('CONFLUENCE_PAGE_NOT_ALLOWLISTED'));
    expect(warningCodes).toHaveLength(2);
  });
});
