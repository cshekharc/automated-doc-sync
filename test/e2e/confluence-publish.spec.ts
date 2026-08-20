/**
 * E2E scenario: Confluence Publish (Workflow 2)
 *
 * When a docs/sync-* PR is merged, `publishConfluenceDrafts()` reads the
 * merged PR body, extracts the `<!-- doc-sync-meta: {...} -->` block, verifies
 * every draft page ID against the allowlist, confirms the page is still in
 * `draft` status, and then issues a PUT with `status: "current"` to publish it.
 *
 * NFR-7, F-1 acceptance criteria verified:
 * - PUT issued with `status: "current"` and incremented version.
 * - No real Confluence or GitHub API calls (MOCK_API_MODE=true).
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mock state
// ---------------------------------------------------------------------------

/** Octokit pulls.get — returns a PR with a controllable body. */
const mockPullsGet = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ data: { body: '' } }),
);

/** axios.get — simulates GET /wiki/api/v2/pages/{id} */
const mockAxiosGet = vi.hoisted(() => vi.fn());

/** axios.put — simulates PUT /wiki/api/v2/pages/{id} */
const mockAxiosPut = vi.hoisted(() => vi.fn().mockResolvedValue({ data: {} }));

/** fs/promises.readFile — returns an empty confluence-map.json by default. */
const mockReadFile = vi.hoisted(() =>
  vi.fn().mockResolvedValue(JSON.stringify({})),
);

// ---------------------------------------------------------------------------
// Module mocks
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
// Import under test
// ---------------------------------------------------------------------------

import { publishConfluenceDrafts } from '../../src/confluence-publish.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Builds a PR body containing a valid doc-sync-meta block. */
function makeMetaPrBody(confluenceDrafts: string[], triggerSha = 'sha-publish-abc123'): string {
  const meta = JSON.stringify({ triggerSha, confluenceDrafts });
  return `Triggered-by: ${triggerSha}\n<!-- doc-sync-meta: ${meta} -->`;
}

// ---------------------------------------------------------------------------
// Environment and spy management
// ---------------------------------------------------------------------------

const MANAGED_ENV_VARS = [
  'MOCK_API_MODE',
  'GITHUB_TOKEN',
  'GITHUB_REPOSITORY',
  'GITHUB_PR_NUMBER',
  'CONFLUENCE_BASE_URL',
  'CONFLUENCE_API_TOKEN',
  'CONFLUENCE_PAGE_ID',
  'CONFLUENCE_REQUEST_TIMEOUT_MS',
] as const;

const savedEnv: Partial<Record<string, string>> = {};

let exitSpy: ReturnType<typeof vi.spyOn>;
let consoleLogSpy: ReturnType<typeof vi.spyOn>;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  for (const key of MANAGED_ENV_VARS) {
    savedEnv[key] = process.env[key];
  }

  process.env['MOCK_API_MODE'] = 'true';
  process.env['GITHUB_TOKEN'] = 'mock-github-token';
  process.env['GITHUB_REPOSITORY'] = 'testowner/testrepo';
  process.env['GITHUB_PR_NUMBER'] = '42';
  process.env['CONFLUENCE_BASE_URL'] = 'https://mock.atlassian.net';
  process.env['CONFLUENCE_API_TOKEN'] = 'mock-confluence-token';
  // Page 32833537 is in the allowlist via CONFLUENCE_PAGE_ID env var
  process.env['CONFLUENCE_PAGE_ID'] = '32833537';
  process.env['CONFLUENCE_REQUEST_TIMEOUT_MS'] = '5000';

  // Reset mocks
  mockPullsGet.mockReset();
  mockAxiosGet.mockReset();
  mockAxiosPut.mockReset().mockResolvedValue({ data: {} });
  mockReadFile.mockReset().mockResolvedValue(JSON.stringify({}));

  // Default: PR body contains a draft page ID
  mockPullsGet.mockResolvedValue({
    data: { body: makeMetaPrBody(['32833537']) },
  });

  // Default: GET returns a page in draft status at version 5
  mockAxiosGet.mockResolvedValue({
    data: {
      status: 'draft',
      version: { number: 5 },
      title: 'API Documentation',
    },
  });

  exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: number) => {
    throw new Error(`process.exit(${code ?? 0})`);
  }) as ReturnType<typeof vi.spyOn>;

  consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  exitSpy.mockRestore();
  consoleLogSpy.mockRestore();
  consoleErrorSpy.mockRestore();
  consoleWarnSpy.mockRestore();

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

describe('e2e: confluence-publish — Workflow 2 publishes draft Confluence pages on PR merge', () => {
  it('issues PUT with status "current" and incremented version when draft page is allowlisted', async () => {
    await publishConfluenceDrafts();

    expect(mockAxiosPut).toHaveBeenCalledOnce();
    const [url, body] = mockAxiosPut.mock.calls[0] as [string, { status: string; version: { number: number } }];
    expect(url).toContain('32833537');
    expect(body.status).toBe('current');
    expect(body.version.number).toBe(6); // 5 + 1
  });

  it('logs CONFLUENCE_PAGE_PUBLISHED on success', async () => {
    await publishConfluenceDrafts();

    const publishedCall = consoleLogSpy.mock.calls.find(
      (args) => typeof args[0] === 'string' && (args[0] as string).includes('CONFLUENCE_PAGE_PUBLISHED'),
    );
    expect(publishedCall).toBeDefined();
  });

  it('skips page IDs not in the allowlist and logs CONFLUENCE_PAGE_NOT_ALLOWLISTED', async () => {
    mockPullsGet.mockResolvedValue({
      data: { body: makeMetaPrBody(['99999999']) }, // not in allowlist
    });

    await publishConfluenceDrafts();

    // No PUT should be issued
    expect(mockAxiosPut).not.toHaveBeenCalled();

    const warnCall = consoleWarnSpy.mock.calls.find(
      (args) => typeof args[0] === 'string' && (args[0] as string).includes('CONFLUENCE_PAGE_NOT_ALLOWLISTED'),
    );
    expect(warnCall).toBeDefined();
  });

  it('skips a page that is no longer in draft status', async () => {
    mockAxiosGet.mockResolvedValue({
      data: { status: 'current', version: { number: 5 }, title: 'API Documentation' },
    });

    await publishConfluenceDrafts();

    expect(mockAxiosPut).not.toHaveBeenCalled();

    const skipCall = consoleLogSpy.mock.calls.find(
      (args) => typeof args[0] === 'string' && (args[0] as string).includes('CONFLUENCE_PAGE_NOT_DRAFT'),
    );
    expect(skipCall).toBeDefined();
  });

  it('calls process.exit(1) when the PR body has no doc-sync-meta block', async () => {
    mockPullsGet.mockResolvedValue({
      data: { body: 'A PR body with no meta block at all.' },
    });

    await expect(publishConfluenceDrafts()).rejects.toThrow('process.exit(1)');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
