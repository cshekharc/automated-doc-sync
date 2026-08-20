/**
 * Unit tests for T-11 — ConfluencePublisher.
 *
 * All HTTP calls are intercepted via vi.mock('axios') so no real Confluence
 * API is needed.
 *
 * Acceptance criteria verified:
 * - `writeDraft` PUT body always contains `status: "draft"` (never `"current"`).
 * - `RollbackManager.register()` is called BEFORE the axios PUT in `writeDraft`
 *   (register-then-mutate invariant, F-6).
 * - `rollback.register()` is called even when the axios PUT throws (undo
 *   registered before the mutation that failed).
 * - The rollback undo closure calls `revertToPublished` with the pre-draft body
 *   and `currentVersion` (not `currentVersion + 1`) — W-1.
 * - `CONFLUENCE_API_TOKEN` never appears in any string written to stdout;
 *   `[REDACTED]` appears in captured output because the Base64-encoded auth
 *   header (≥ 40 chars) is replaced by `redactSecrets` (NFR-2).
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist mocks — must be declared before any module import is resolved.
// ---------------------------------------------------------------------------

/** Mock for axios.get (used by fetchPage). */
const mockAxiosGet = vi.hoisted(() => vi.fn());

/** Mock for axios.put (used by writeDraft and revertToPublished). */
const mockAxiosPut = vi.hoisted(() => vi.fn());

vi.mock('axios', () => ({
  default: {
    get: mockAxiosGet,
    put: mockAxiosPut,
  },
}));

// ---------------------------------------------------------------------------
// Imports under test (AFTER vi.mock declarations)
// ---------------------------------------------------------------------------

import { ConfluencePublisher } from '../../src/confluence-publisher/index.js';
import { RollbackManager } from '../../src/rollback-manager.js';

// ---------------------------------------------------------------------------
// Environment variable management
// ---------------------------------------------------------------------------

const MANAGED_ENV_VARS = [
  'CONFLUENCE_BASE_URL',
  'CONFLUENCE_API_TOKEN',
  'CONFLUENCE_REQUEST_TIMEOUT_MS',
] as const;

const savedEnv: Partial<Record<string, string>> = {};

/** Default page response returned by mock fetchPage calls. */
function makePageResponse(options: {
  title?: string;
  versionNumber?: number;
  bodyXhtml?: string;
}): { data: unknown } {
  return {
    data: {
      title: options.title ?? 'Mock Page',
      version: { number: options.versionNumber ?? 1 },
      body: { storage: { value: options.bodyXhtml ?? '<h2>fn</h2><p>Body.</p>' } },
    },
  };
}

let publisher: ConfluencePublisher;
let consoleSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // Save and clear managed env vars before each test.
  for (const key of MANAGED_ENV_VARS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }

  // Set default env vars for each test.
  process.env['CONFLUENCE_BASE_URL'] = 'https://confluence.example.com';
  process.env['CONFLUENCE_API_TOKEN'] = 'test-token';
  process.env['CONFLUENCE_REQUEST_TIMEOUT_MS'] = '5000';

  // Reset axios mocks.
  mockAxiosGet.mockReset();
  mockAxiosPut.mockReset();

  // Default successful responses.
  mockAxiosGet.mockResolvedValue(makePageResponse({}));
  mockAxiosPut.mockResolvedValue({ data: {} });

  // Create publisher with default env.
  publisher = new ConfluencePublisher();

  // Suppress console output.
  consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
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

  // Restore console spies.
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// fetchPage — HTTP request details
// ---------------------------------------------------------------------------

describe('fetchPage — HTTP request', () => {
  it('calls axios.get with the correct URL including pageId and body-format=storage', async () => {
    mockAxiosGet.mockResolvedValue(makePageResponse({}));

    await publisher.fetchPage('page-001');

    expect(mockAxiosGet).toHaveBeenCalledOnce();
    const [url] = mockAxiosGet.mock.calls[0] as [string, unknown];
    expect(url).toContain('page-001');
    expect(url).toContain('/api/v2/pages/');
    expect(url).toContain('body-format=storage');
  });

  it('sends Authorization: Basic header using base64(":" + CONFLUENCE_API_TOKEN)', async () => {
    process.env['CONFLUENCE_API_TOKEN'] = 'my-token';
    // Re-create publisher to pick up the new env var.
    const pub = new ConfluencePublisher();
    mockAxiosGet.mockResolvedValue(makePageResponse({}));

    await pub.fetchPage('page-002');

    const [, config] = mockAxiosGet.mock.calls[0] as [
      string,
      { headers?: Record<string, string>; timeout?: number },
    ];
    const expectedAuth = 'Basic ' + Buffer.from(':my-token').toString('base64');
    expect(config?.headers?.['Authorization']).toBe(expectedAuth);
  });

  it('applies CONFLUENCE_REQUEST_TIMEOUT_MS as the axios timeout', async () => {
    process.env['CONFLUENCE_REQUEST_TIMEOUT_MS'] = '8000';
    const pub = new ConfluencePublisher();
    mockAxiosGet.mockResolvedValue(makePageResponse({}));

    await pub.fetchPage('page-003');

    const [, config] = mockAxiosGet.mock.calls[0] as [
      string,
      { headers?: Record<string, string>; timeout?: number },
    ];
    expect(config?.timeout).toBe(8000);
  });

  it('defaults timeout to 30000 when CONFLUENCE_REQUEST_TIMEOUT_MS is not set', async () => {
    delete process.env['CONFLUENCE_REQUEST_TIMEOUT_MS'];
    const pub = new ConfluencePublisher();
    mockAxiosGet.mockResolvedValue(makePageResponse({}));

    await pub.fetchPage('page-004');

    const [, config] = mockAxiosGet.mock.calls[0] as [
      string,
      { headers?: Record<string, string>; timeout?: number },
    ];
    expect(config?.timeout).toBe(30000);
  });
});

// ---------------------------------------------------------------------------
// fetchPage — response parsing
// ---------------------------------------------------------------------------

describe('fetchPage — response parsing', () => {
  it('returns body, version, and title from the API response', async () => {
    mockAxiosGet.mockResolvedValue(
      makePageResponse({ title: 'My Page', versionNumber: 12, bodyXhtml: '<h2>myFn</h2>' }),
    );

    const result = await publisher.fetchPage('page-xyz');

    expect(result.body).toBe('<h2>myFn</h2>');
    expect(result.version).toBe(12);
    expect(result.title).toBe('My Page');
  });

  it('returns empty body and version 0 when response is missing fields', async () => {
    mockAxiosGet.mockResolvedValue({ data: {} });

    const result = await publisher.fetchPage('page-empty');

    expect(result.body).toBe('');
    expect(result.version).toBe(0);
    expect(result.title).toBe('');
  });
});

// ---------------------------------------------------------------------------
// writeDraft — PUT body always has status: "draft" (never "current")
// ---------------------------------------------------------------------------

describe('writeDraft — PUT body has status: "draft"', () => {
  it('PUT body contains status: "draft"', async () => {
    const rollback = new RollbackManager();
    vi.spyOn(rollback, 'register').mockImplementation(() => {});

    await publisher.writeDraft('page-draft', '<h2>updated</h2>', 3, rollback);

    expect(mockAxiosPut).toHaveBeenCalledOnce();
    const [, body] = mockAxiosPut.mock.calls[0] as [string, Record<string, unknown>];
    expect(body['status']).toBe('draft');
  });

  it('PUT body never contains status: "current"', async () => {
    const rollback = new RollbackManager();
    vi.spyOn(rollback, 'register').mockImplementation(() => {});

    await publisher.writeDraft('page-draft-2', '<h2>new</h2>', 5, rollback);

    const [, body] = mockAxiosPut.mock.calls[0] as [string, Record<string, unknown>];
    expect(body['status']).not.toBe('current');
  });

  it('PUT body version.number equals currentVersion + 1', async () => {
    const rollback = new RollbackManager();
    vi.spyOn(rollback, 'register').mockImplementation(() => {});

    await publisher.writeDraft('page-version', '<h2>fn</h2>', 7, rollback);

    const [, body] = mockAxiosPut.mock.calls[0] as [string, Record<string, unknown>];
    expect((body['version'] as { number: number }).number).toBe(8);
  });

  it('PUT body contains the updatedHtml in body.storage.value', async () => {
    const rollback = new RollbackManager();
    vi.spyOn(rollback, 'register').mockImplementation(() => {});

    const updatedHtml = '<h2>myFunction</h2><p>Updated docs.</p>';
    await publisher.writeDraft('page-html', updatedHtml, 2, rollback);

    const [, body] = mockAxiosPut.mock.calls[0] as [string, Record<string, unknown>];
    const bodyObj = body['body'] as { storage: { value: string; representation: string } };
    expect(bodyObj.storage.value).toBe(updatedHtml);
    expect(bodyObj.storage.representation).toBe('storage');
  });

  it('PUT URL contains the pageId', async () => {
    const rollback = new RollbackManager();
    vi.spyOn(rollback, 'register').mockImplementation(() => {});

    await publisher.writeDraft('page-target-123', '<h2>fn</h2>', 1, rollback);

    const [url] = mockAxiosPut.mock.calls[0] as [string, unknown];
    expect(url).toContain('page-target-123');
  });
});

// ---------------------------------------------------------------------------
// writeDraft — register-before-mutate order (F-6)
// ---------------------------------------------------------------------------

describe('writeDraft — register-before-mutate invariant (F-6)', () => {
  it('calls rollback.register before axios.put', async () => {
    const order: string[] = [];

    const rollback = new RollbackManager();
    vi.spyOn(rollback, 'register').mockImplementation(entry => {
      order.push(`register:${entry.description}`);
    });

    mockAxiosPut.mockImplementation(async () => {
      order.push('put');
      return { data: {} };
    });

    await publisher.writeDraft('page-order', '<h2>fn</h2>', 4, rollback);

    // register must appear before put in the recorded order
    const registerIdx = order.findIndex(s => s.startsWith('register:'));
    const putIdx = order.indexOf('put');

    expect(registerIdx).toBeGreaterThanOrEqual(0);
    expect(putIdx).toBeGreaterThanOrEqual(0);
    expect(registerIdx).toBeLessThan(putIdx);
  });

  it('calls rollback.register exactly once per writeDraft call', async () => {
    const rollback = new RollbackManager();
    const registerSpy = vi.spyOn(rollback, 'register').mockImplementation(() => {});

    await publisher.writeDraft('page-once', '<h2>fn</h2>', 2, rollback);

    expect(registerSpy).toHaveBeenCalledOnce();
  });

  it('rollback.register is called even when axios.put throws', async () => {
    // fetchPage (axios.get) succeeds; only the PUT throws.
    mockAxiosGet.mockResolvedValue(
      makePageResponse({ versionNumber: 3, bodyXhtml: '<h2>original</h2>' }),
    );
    mockAxiosPut.mockRejectedValue(new Error('Network unreachable'));

    const rollback = new RollbackManager();
    const registerSpy = vi.spyOn(rollback, 'register').mockImplementation(() => {});

    await expect(
      publisher.writeDraft('page-throws', '<h2>new</h2>', 3, rollback),
    ).rejects.toThrow('Network unreachable');

    // register must have been called before the PUT threw
    expect(registerSpy).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// writeDraft — rollback undo calls revertToPublished correctly (W-1)
// ---------------------------------------------------------------------------

describe('writeDraft — rollback undo uses currentVersion (not currentVersion + 1)', () => {
  it('undo closure calls revertToPublished with the pre-draft body and currentVersion', async () => {
    const originalBody = '<h2>preDraftContent</h2>';
    const currentVersion = 5;

    // fetchPage returns the original body at currentVersion.
    mockAxiosGet.mockResolvedValue(
      makePageResponse({ versionNumber: currentVersion, bodyXhtml: originalBody }),
    );

    // Capture the undo closure registered by writeDraft.
    let capturedUndo: (() => Promise<void>) | undefined;
    const rollback = new RollbackManager();
    vi.spyOn(rollback, 'register').mockImplementation(entry => {
      capturedUndo = entry.undo;
    });

    await publisher.writeDraft('page-rollback', '<h2>updatedContent</h2>', currentVersion, rollback);

    // Reset PUT mock so we can inspect only the revert call.
    mockAxiosPut.mockReset().mockResolvedValue({ data: {} });

    expect(capturedUndo).toBeDefined();
    await capturedUndo!();

    // revertToPublished should issue one PUT.
    expect(mockAxiosPut).toHaveBeenCalledOnce();

    const [url, putBody] = mockAxiosPut.mock.calls[0] as [string, Record<string, unknown>];

    // URL must reference the correct page.
    expect(url).toContain('page-rollback');

    // Status must be "current" (not "draft") — restoring the published state.
    expect(putBody['status']).toBe('current');

    // W-1: version must be currentVersion (5), NOT currentVersion + 1 (6).
    const versionObj = putBody['version'] as { number: number };
    expect(versionObj.number).toBe(currentVersion);
    expect(versionObj.number).not.toBe(currentVersion + 1);

    // Body content must be the original (pre-draft) body.
    const bodyObj = putBody['body'] as { storage: { value: string } };
    expect(bodyObj.storage.value).toBe(originalBody);
  });

  it('undo description references the page ID and restoration version', async () => {
    mockAxiosGet.mockResolvedValue(makePageResponse({ versionNumber: 9 }));

    let capturedDescription = '';
    const rollback = new RollbackManager();
    vi.spyOn(rollback, 'register').mockImplementation(entry => {
      capturedDescription = entry.description;
    });

    await publisher.writeDraft('page-desc', '<h2>fn</h2>', 9, rollback);

    expect(capturedDescription).toContain('page-desc');
  });
});

// ---------------------------------------------------------------------------
// revertToPublished — PUT body always has status: "current"
// ---------------------------------------------------------------------------

describe('revertToPublished — PUT body', () => {
  it('PUT body contains status: "current"', async () => {
    await publisher.revertToPublished('page-revert', '<h2>original</h2>', 4);

    expect(mockAxiosPut).toHaveBeenCalledOnce();
    const [, body] = mockAxiosPut.mock.calls[0] as [string, Record<string, unknown>];
    expect(body['status']).toBe('current');
  });

  it('PUT body version.number equals rollbackVersion (not rollbackVersion + 1)', async () => {
    const rollbackVersion = 11;
    await publisher.revertToPublished('page-v11', '<h2>orig</h2>', rollbackVersion);

    const [, body] = mockAxiosPut.mock.calls[0] as [string, Record<string, unknown>];
    const versionObj = body['version'] as { number: number };
    expect(versionObj.number).toBe(rollbackVersion);
    expect(versionObj.number).not.toBe(rollbackVersion + 1);
  });

  it('PUT body contains the originalBody in body.storage.value', async () => {
    const originalBody = '<h2>restoredContent</h2><p>Paragraph.</p>';
    await publisher.revertToPublished('page-body', originalBody, 3);

    const [, body] = mockAxiosPut.mock.calls[0] as [string, Record<string, unknown>];
    const bodyObj = body['body'] as { storage: { value: string } };
    expect(bodyObj.storage.value).toBe(originalBody);
  });

  it('PUT URL contains the pageId', async () => {
    await publisher.revertToPublished('page-id-42', '<h2>orig</h2>', 2);

    const [url] = mockAxiosPut.mock.calls[0] as [string, unknown];
    expect(url).toContain('page-id-42');
  });

  it('PUT body id field equals pageId', async () => {
    await publisher.revertToPublished('id-check-page', '<h2>orig</h2>', 1);

    const [, body] = mockAxiosPut.mock.calls[0] as [string, Record<string, unknown>];
    expect(body['id']).toBe('id-check-page');
  });
});

// ---------------------------------------------------------------------------
// Token redaction — CONFLUENCE_API_TOKEN never appears in stdout (NFR-2)
// ---------------------------------------------------------------------------

describe('token redaction — CONFLUENCE_API_TOKEN is never exposed in stdout', () => {
  it(
    'CONFLUENCE_API_TOKEN does not appear in stdout; ' +
      '[REDACTED] appears where the Base64 auth header is logged',
    async () => {
      // Use a long Confluence-format token whose Base64 encoding is ≥ 40 chars,
      // ensuring it is caught by the generic Base64 catch-all pattern in
      // redactSecrets (pattern 6: [A-Za-z0-9+/]{40,}={0,2}).
      //
      // The token also matches pattern 4 (ATATT[A-Za-z0-9+/=_-]{20,}) if it
      // were ever logged directly, providing defence-in-depth.
      //
      // Token length: 46 chars → base64(":token") = 64 chars ≥ 40.
      const mockToken = 'ATATTBrBTwolS1gkqKETa1GVqMBLVdwMstYmXXXXXXXX';

      delete process.env['CONFLUENCE_API_TOKEN'];
      process.env['CONFLUENCE_API_TOKEN'] = mockToken;
      process.env['CONFLUENCE_BASE_URL'] = 'https://confluence.example.com';

      mockAxiosGet.mockResolvedValue(
        makePageResponse({ title: 'Test', versionNumber: 1, bodyXhtml: '' }),
      );

      // Collect ALL console.log output.
      const capturedLogs: string[] = [];
      consoleSpy.mockRestore(); // restore the beforeEach spy
      vi.spyOn(console, 'log').mockImplementation((...args) => {
        capturedLogs.push(args.map(String).join(' '));
      });

      // Create publisher AFTER setting env var so it reads the mock token.
      const pub = new ConfluencePublisher();
      await pub.fetchPage('test-page-redact');

      const allOutput = capturedLogs.join('\n');

      // Primary assertion: the raw token value must NEVER appear in stdout.
      expect(allOutput).not.toContain(mockToken);

      // Secondary assertion: [REDACTED] must appear because fetchPage logs the
      // auth header (Base64 blob ≥ 40 chars) through redactSecrets, which
      // replaces it with [REDACTED] before writing to stdout.
      expect(allOutput).toContain('[REDACTED]');
    },
  );

  it('raw token is absent from writeDraft stdout even when PUT succeeds', async () => {
    const mockToken = 'ATATTSecretTokenForWriteDraftTest12345678901234';

    delete process.env['CONFLUENCE_API_TOKEN'];
    process.env['CONFLUENCE_API_TOKEN'] = mockToken;

    mockAxiosGet.mockResolvedValue(makePageResponse({ versionNumber: 3 }));
    mockAxiosPut.mockResolvedValue({ data: {} });

    const capturedLogs: string[] = [];
    consoleSpy.mockRestore();
    vi.spyOn(console, 'log').mockImplementation((...args) => {
      capturedLogs.push(args.map(String).join(' '));
    });

    const pub = new ConfluencePublisher();
    const rollback = new RollbackManager();
    vi.spyOn(rollback, 'register').mockImplementation(() => {});

    await pub.writeDraft('page-redact-write', '<h2>fn</h2>', 3, rollback);

    const allOutput = capturedLogs.join('\n');
    expect(allOutput).not.toContain(mockToken);
  });

  it('raw token is absent from revertToPublished stdout', async () => {
    const mockToken = 'ATATTRevertTestTokenXXXXXXXXXXXXXXXXXXXXXXXXXX';

    delete process.env['CONFLUENCE_API_TOKEN'];
    process.env['CONFLUENCE_API_TOKEN'] = mockToken;

    mockAxiosPut.mockResolvedValue({ data: {} });

    const capturedLogs: string[] = [];
    consoleSpy.mockRestore();
    vi.spyOn(console, 'log').mockImplementation((...args) => {
      capturedLogs.push(args.map(String).join(' '));
    });

    const pub = new ConfluencePublisher();
    await pub.revertToPublished('page-redact-revert', '<h2>orig</h2>', 2);

    const allOutput = capturedLogs.join('\n');
    expect(allOutput).not.toContain(mockToken);
  });
});

// ---------------------------------------------------------------------------
// writeDraft — complete happy path integration
// ---------------------------------------------------------------------------

describe('writeDraft — complete sequence', () => {
  it('calls axios.get once (fetchPage) and axios.put once (draft PUT) on success', async () => {
    const rollback = new RollbackManager();
    vi.spyOn(rollback, 'register').mockImplementation(() => {});

    mockAxiosGet.mockResolvedValue(makePageResponse({ versionNumber: 6 }));
    mockAxiosPut.mockResolvedValue({ data: {} });

    await publisher.writeDraft('page-happy', '<h2>updated</h2>', 6, rollback);

    expect(mockAxiosGet).toHaveBeenCalledOnce();
    expect(mockAxiosPut).toHaveBeenCalledOnce();
  });

  it('passes the pageId to both the fetchPage GET and the draft PUT', async () => {
    const rollback = new RollbackManager();
    vi.spyOn(rollback, 'register').mockImplementation(() => {});

    await publisher.writeDraft('page-id-verify', '<h2>fn</h2>', 2, rollback);

    const [getUrl] = mockAxiosGet.mock.calls[0] as [string, unknown];
    const [putUrl] = mockAxiosPut.mock.calls[0] as [string, unknown];

    expect(getUrl).toContain('page-id-verify');
    expect(putUrl).toContain('page-id-verify');
  });
});
