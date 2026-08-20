/**
 * Unit tests for T-10 — DocLocator, Confluence path.
 *
 * Acceptance criteria verified:
 * - Returns correct DocSection with heading-matched sectionContent when page
 *   ID is configured (env var or confluence-map.json) and heading is found
 *   in a mocked page body.
 * - Returns target: 'not-found' when no heading text matches functionName.
 * - Returns target: 'not-found' (without calling axios) when no page ID is
 *   configured.
 * - CONFLUENCE_HEADING_LEVEL=h3 makes the locator search <h3> elements.
 * - R-4 fixture-based test: parses the real Confluence storage-format fixture
 *   from disk (no axios mock) and finds every function name listed in
 *   fixture-meta.json using extractConfluenceSection directly.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Hoist axios mock — must be available before any module is imported.
// ---------------------------------------------------------------------------

const mockAxiosGet = vi.hoisted(() => vi.fn());

vi.mock('axios', () => ({
  default: {
    get: mockAxiosGet,
  },
}));

// ---------------------------------------------------------------------------
// Imports under test (AFTER vi.mock declarations)
// ---------------------------------------------------------------------------

import {
  locateConfluenceSection,
  extractConfluenceSection,
} from '../../src/doc-locator/index.js';

// ---------------------------------------------------------------------------
// Path helpers (ESM-compatible __dirname equivalent)
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Absolute path to the Confluence fixture directory. */
const FIXTURE_DIR = resolve(__dirname, '../fixtures/confluence');

// ---------------------------------------------------------------------------
// Environment variable management helpers
// ---------------------------------------------------------------------------

const MANAGED_ENV_VARS = [
  'CONFLUENCE_PAGE_ID',
  'CONFLUENCE_BASE_URL',
  'CONFLUENCE_API_TOKEN',
  'CONFLUENCE_REQUEST_TIMEOUT_MS',
  'CONFLUENCE_HEADING_LEVEL',
] as const;

/** Snapshot of env vars taken in beforeEach so afterEach can restore them. */
const savedEnv: Partial<Record<string, string>> = {};

beforeEach(() => {
  // Save and clear all managed env vars before each test.
  for (const key of MANAGED_ENV_VARS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  mockAxiosGet.mockReset();
});

afterEach(() => {
  // Restore all managed env vars after each test.
  for (const key of MANAGED_ENV_VARS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
});

// ---------------------------------------------------------------------------
// Shared mock response factory
// ---------------------------------------------------------------------------

/**
 * Builds a minimal mock Confluence API v2 page response.
 * `bodyXhtml` is placed at `data.body.storage.value` matching the real API shape.
 */
function makeMockPageResponse(options: {
  title?: string;
  versionNumber?: number;
  bodyXhtml: string;
}): { data: unknown } {
  return {
    data: {
      title: options.title ?? 'Mock Confluence Page',
      version: { number: options.versionNumber ?? 1 },
      body: {
        storage: {
          value: options.bodyXhtml,
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// locateConfluenceSection — page ID from CONFLUENCE_PAGE_ID env var
// ---------------------------------------------------------------------------

describe('locateConfluenceSection — page ID from env var', () => {
  it('returns target: confluence with correct DocSection when heading is found', async () => {
    process.env['CONFLUENCE_PAGE_ID'] = 'env-page-id-001';
    process.env['CONFLUENCE_BASE_URL'] = 'https://confluence.example.com';
    process.env['CONFLUENCE_API_TOKEN'] = 'test-token';

    mockAxiosGet.mockResolvedValue(
      makeMockPageResponse({
        title: 'API Reference',
        versionNumber: 7,
        bodyXhtml:
          '<h2>myFunction</h2><p>Does something useful.</p><h2>anotherFunction</h2>',
      }),
    );

    const result = await locateConfluenceSection('myFunction', 'src/unknown/file.ts');

    expect(result.target).toBe('confluence');
    expect(result.functionName).toBe('myFunction');
    expect(result.confluencePageId).toBe('env-page-id-001');
    expect(result.confluencePageTitle).toBe('API Reference');
    expect(result.confluenceVersionNumber).toBe(7);
    // sectionContent must contain the heading but not the next one
    expect(result.sectionContent).toContain('<h2>myFunction</h2>');
    expect(result.sectionContent).toContain('Does something useful.');
    expect(result.sectionContent).not.toContain('<h2>anotherFunction</h2>');
    // offsets must be present and consistent
    expect(result.sectionStartOffset).toBeGreaterThanOrEqual(0);
    expect(result.sectionEndOffset).toBeGreaterThan(result.sectionStartOffset!);
  });

  it('calls axios.get with the correct URL containing the page ID', async () => {
    process.env['CONFLUENCE_PAGE_ID'] = 'page-abc';
    process.env['CONFLUENCE_BASE_URL'] = 'https://confluence.example.com';
    process.env['CONFLUENCE_API_TOKEN'] = 'secret';

    mockAxiosGet.mockResolvedValue(
      makeMockPageResponse({
        bodyXhtml: '<h2>anyFunc</h2>',
      }),
    );

    await locateConfluenceSection('anyFunc', 'src/unknown/file.ts');

    expect(mockAxiosGet).toHaveBeenCalledOnce();
    const [url] = mockAxiosGet.mock.calls[0] as [string, unknown];
    expect(url).toContain('page-abc');
    expect(url).toContain('/api/v2/pages/');
    expect(url).toContain('body-format=storage');
  });

  it('sends Authorization header with Basic base64(":" + token)', async () => {
    process.env['CONFLUENCE_PAGE_ID'] = 'page-xyz';
    process.env['CONFLUENCE_BASE_URL'] = 'https://confluence.example.com';
    process.env['CONFLUENCE_API_TOKEN'] = 'my-secret-token';

    mockAxiosGet.mockResolvedValue(makeMockPageResponse({ bodyXhtml: '<h2>fn</h2>' }));

    await locateConfluenceSection('fn', 'src/unknown/file.ts');

    const [, config] = mockAxiosGet.mock.calls[0] as [string, { headers?: Record<string, string>; timeout?: number }];
    const expectedAuth = 'Basic ' + Buffer.from(':my-secret-token').toString('base64');
    expect(config?.headers?.['Authorization']).toBe(expectedAuth);
  });

  it('applies CONFLUENCE_REQUEST_TIMEOUT_MS as axios timeout', async () => {
    process.env['CONFLUENCE_PAGE_ID'] = 'page-timeout';
    process.env['CONFLUENCE_BASE_URL'] = 'https://confluence.example.com';
    process.env['CONFLUENCE_API_TOKEN'] = 'tok';
    process.env['CONFLUENCE_REQUEST_TIMEOUT_MS'] = '5000';

    mockAxiosGet.mockResolvedValue(makeMockPageResponse({ bodyXhtml: '<h2>fn</h2>' }));

    await locateConfluenceSection('fn', 'src/unknown/file.ts');

    const [, config] = mockAxiosGet.mock.calls[0] as [string, { headers?: Record<string, string>; timeout?: number }];
    expect(config?.timeout).toBe(5000);
  });

  it('defaults timeout to 30000 when CONFLUENCE_REQUEST_TIMEOUT_MS is not set', async () => {
    process.env['CONFLUENCE_PAGE_ID'] = 'page-default-timeout';
    process.env['CONFLUENCE_BASE_URL'] = 'https://confluence.example.com';
    process.env['CONFLUENCE_API_TOKEN'] = 'tok';

    mockAxiosGet.mockResolvedValue(makeMockPageResponse({ bodyXhtml: '<h2>fn</h2>' }));

    await locateConfluenceSection('fn', 'src/unknown/file.ts');

    const [, config] = mockAxiosGet.mock.calls[0] as [string, { headers?: Record<string, string>; timeout?: number }];
    expect(config?.timeout).toBe(30000);
  });
});

// ---------------------------------------------------------------------------
// locateConfluenceSection — page ID from docs/confluence-map.json
// ---------------------------------------------------------------------------

describe('locateConfluenceSection — page ID from confluence-map.json', () => {
  it('resolves page ID from the map for src/drift-detector/index.ts', async () => {
    // No CONFLUENCE_PAGE_ID set — page ID must come from the map file.
    process.env['CONFLUENCE_BASE_URL'] = 'https://confluence.example.com';
    process.env['CONFLUENCE_API_TOKEN'] = 'tok';

    mockAxiosGet.mockResolvedValue(
      makeMockPageResponse({
        title: 'Pipeline Docs',
        versionNumber: 3,
        bodyXhtml: '<h2>detectDrift</h2><p>Detects drift.</p>',
      }),
    );

    const result = await locateConfluenceSection('detectDrift', 'src/drift-detector/index.ts');

    expect(result.target).toBe('confluence');
    // The confirmed page ID from the map
    expect(result.confluencePageId).toBe('32833537');
    expect(result.sectionContent).toContain('<h2>detectDrift</h2>');

    // The URL passed to axios.get must contain the mapped page ID
    const [url] = mockAxiosGet.mock.calls[0] as [string, unknown];
    expect(url).toContain('32833537');
  });

  it('falls back to env var when sourceFilePath is not in the map', async () => {
    process.env['CONFLUENCE_PAGE_ID'] = 'fallback-id-999';
    process.env['CONFLUENCE_BASE_URL'] = 'https://confluence.example.com';
    process.env['CONFLUENCE_API_TOKEN'] = 'tok';

    mockAxiosGet.mockResolvedValue(
      makeMockPageResponse({ bodyXhtml: '<h2>someFunc</h2>' }),
    );

    const result = await locateConfluenceSection('someFunc', 'src/not/in/map.ts');

    expect(result.confluencePageId).toBe('fallback-id-999');
    const [url] = mockAxiosGet.mock.calls[0] as [string, unknown];
    expect(url).toContain('fallback-id-999');
  });
});

// ---------------------------------------------------------------------------
// locateConfluenceSection — not-found: heading absent in page body
// ---------------------------------------------------------------------------

describe('locateConfluenceSection — not-found when heading absent', () => {
  it('returns target: not-found when functionName has no matching heading', async () => {
    process.env['CONFLUENCE_PAGE_ID'] = 'page-123';
    process.env['CONFLUENCE_BASE_URL'] = 'https://confluence.example.com';
    process.env['CONFLUENCE_API_TOKEN'] = 'tok';

    mockAxiosGet.mockResolvedValue(
      makeMockPageResponse({
        bodyXhtml: '<h2>someOtherFunction</h2><p>Content.</p>',
      }),
    );

    const result = await locateConfluenceSection('nonExistentFunction', 'src/unknown/file.ts');

    expect(result.target).toBe('not-found');
    expect(result.functionName).toBe('nonExistentFunction');
    expect(result.sectionContent).toBe('');
  });

  it('returns empty sectionContent when not-found', async () => {
    process.env['CONFLUENCE_PAGE_ID'] = 'page-456';
    process.env['CONFLUENCE_BASE_URL'] = 'https://confluence.example.com';
    process.env['CONFLUENCE_API_TOKEN'] = 'tok';

    mockAxiosGet.mockResolvedValue(
      makeMockPageResponse({ bodyXhtml: '<p>No headings here.</p>' }),
    );

    const result = await locateConfluenceSection('missingFunc', 'src/unknown/file.ts');

    expect(result.sectionContent).toBe('');
  });

  it('does not set confluencePageId when not-found due to absent heading', async () => {
    process.env['CONFLUENCE_PAGE_ID'] = 'page-789';
    process.env['CONFLUENCE_BASE_URL'] = 'https://confluence.example.com';
    process.env['CONFLUENCE_API_TOKEN'] = 'tok';

    mockAxiosGet.mockResolvedValue(
      makeMockPageResponse({ bodyXhtml: '<h2>otherFunc</h2>' }),
    );

    const result = await locateConfluenceSection('missingFunc', 'src/unknown/file.ts');

    expect(result.target).toBe('not-found');
    expect(result.confluencePageId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// locateConfluenceSection — not-found: no page ID configured
// ---------------------------------------------------------------------------

describe('locateConfluenceSection — not-found when no page ID configured', () => {
  it('returns target: not-found without calling axios when no page ID is available', async () => {
    // Neither CONFLUENCE_PAGE_ID nor a map entry for this path exists.
    const result = await locateConfluenceSection('myFunc', 'src/completely/unknown.ts');

    expect(result.target).toBe('not-found');
    expect(result.sectionContent).toBe('');
    expect(mockAxiosGet).not.toHaveBeenCalled();
  });

  it('preserves functionName in the not-found sentinel', async () => {
    const result = await locateConfluenceSection('orphanFunction', 'src/no/map/entry.ts');

    expect(result.functionName).toBe('orphanFunction');
    expect(result.target).toBe('not-found');
  });
});

// ---------------------------------------------------------------------------
// locateConfluenceSection — CONFLUENCE_HEADING_LEVEL=h3
// ---------------------------------------------------------------------------

describe('locateConfluenceSection — CONFLUENCE_HEADING_LEVEL=h3', () => {
  it('searches h3 elements (not h2) when CONFLUENCE_HEADING_LEVEL=h3', async () => {
    process.env['CONFLUENCE_PAGE_ID'] = 'page-h3';
    process.env['CONFLUENCE_BASE_URL'] = 'https://confluence.example.com';
    process.env['CONFLUENCE_API_TOKEN'] = 'tok';
    process.env['CONFLUENCE_HEADING_LEVEL'] = 'h3';

    mockAxiosGet.mockResolvedValue(
      makeMockPageResponse({
        bodyXhtml:
          '<h2>notAtH3Level</h2>' +
          '<h3>targetFunction</h3><p>Content for target.</p>' +
          '<h3>nextFunction</h3>',
      }),
    );

    const result = await locateConfluenceSection('targetFunction', 'src/unknown/file.ts');

    expect(result.target).toBe('confluence');
    expect(result.sectionContent).toContain('<h3>targetFunction</h3>');
    expect(result.sectionContent).toContain('Content for target.');
    expect(result.sectionContent).not.toContain('<h3>nextFunction</h3>');
  });

  it('returns not-found for an h2 heading when level is set to h3', async () => {
    process.env['CONFLUENCE_PAGE_ID'] = 'page-h3-miss';
    process.env['CONFLUENCE_BASE_URL'] = 'https://confluence.example.com';
    process.env['CONFLUENCE_API_TOKEN'] = 'tok';
    process.env['CONFLUENCE_HEADING_LEVEL'] = 'h3';

    mockAxiosGet.mockResolvedValue(
      makeMockPageResponse({
        // Only an h2 version of the heading — no h3 version exists
        bodyXhtml: '<h2>myFunc</h2><p>Body.</p>',
      }),
    );

    const result = await locateConfluenceSection('myFunc', 'src/unknown/file.ts');

    expect(result.target).toBe('not-found');
  });

  it('section ends at the next h3 or higher heading when level is h3', async () => {
    process.env['CONFLUENCE_PAGE_ID'] = 'page-h3-end';
    process.env['CONFLUENCE_BASE_URL'] = 'https://confluence.example.com';
    process.env['CONFLUENCE_API_TOKEN'] = 'tok';
    process.env['CONFLUENCE_HEADING_LEVEL'] = 'h3';

    const bodyXhtml =
      '<h3>alpha</h3><p>Alpha body.</p>' +
      '<h3>beta</h3><p>Beta body.</p>';

    mockAxiosGet.mockResolvedValue(makeMockPageResponse({ bodyXhtml }));

    const result = await locateConfluenceSection('alpha', 'src/unknown/file.ts');

    expect(result.target).toBe('confluence');
    expect(result.sectionContent).toContain('Alpha body.');
    expect(result.sectionContent).not.toContain('Beta body.');
  });
});

// ---------------------------------------------------------------------------
// extractConfluenceSection — unit tests (no axios needed)
// ---------------------------------------------------------------------------

describe('extractConfluenceSection', () => {
  it('finds a simple <h2>name</h2> heading', () => {
    const xhtml = '<h2>myFunc</h2><p>Body content.</p>';
    const result = extractConfluenceSection('myFunc', 'h2', xhtml);

    expect(result.found).toBe(true);
    expect(result.sectionContent).toBe(xhtml); // only heading, no next heading
    expect(result.sectionStartOffset).toBe(0);
    expect(result.sectionEndOffset).toBe(xhtml.length);
  });

  it('finds a heading wrapped in a span: <h2><span ...>name</span></h2>', () => {
    const xhtml = '<h2><span class="heading-text">myFunc</span></h2><p>Body.</p>';
    const result = extractConfluenceSection('myFunc', 'h2', xhtml);

    expect(result.found).toBe(true);
    expect(result.sectionContent).toContain('<h2>');
    expect(result.sectionContent).toContain('myFunc');
  });

  it('returns found: false when the function name is absent', () => {
    const xhtml = '<h2>otherFunc</h2><p>Content.</p>';
    const result = extractConfluenceSection('notHere', 'h2', xhtml);

    expect(result.found).toBe(false);
    expect(result.sectionContent).toBe('');
    expect(result.sectionStartOffset).toBe(0);
    expect(result.sectionEndOffset).toBe(0);
  });

  it('section ends at the start of the next same-level heading', () => {
    const xhtml =
      '<h2>first</h2><p>First body.</p>' +
      '<h2>second</h2><p>Second body.</p>';
    const result = extractConfluenceSection('first', 'h2', xhtml);

    expect(result.found).toBe(true);
    expect(result.sectionContent).toContain('<h2>first</h2>');
    expect(result.sectionContent).toContain('First body.');
    expect(result.sectionContent).not.toContain('<h2>second</h2>');
    expect(result.sectionContent).not.toContain('Second body.');
  });

  it('section ends at a higher-level (h1) heading when searching h2', () => {
    const xhtml =
      '<h1>Top</h1>' +
      '<h2>alpha</h2><p>Alpha content.</p>' +
      '<h1>NextTop</h1>';
    const result = extractConfluenceSection('alpha', 'h2', xhtml);

    expect(result.found).toBe(true);
    expect(result.sectionContent).toContain('Alpha content.');
    expect(result.sectionContent).not.toContain('<h1>NextTop</h1>');
  });

  it('section extends to end of document when it is the last heading', () => {
    const xhtml = '<h2>first</h2><p>First.</p><h2>last</h2><p>Last body.</p>';
    const result = extractConfluenceSection('last', 'h2', xhtml);

    expect(result.found).toBe(true);
    expect(result.sectionEndOffset).toBe(xhtml.length);
    expect(result.sectionContent).toBe('<h2>last</h2><p>Last body.</p>');
  });

  it('sectionContent equals xhtml.slice(sectionStartOffset, sectionEndOffset)', () => {
    const xhtml =
      '<p>Intro.</p>' +
      '<h2>alpha</h2><p>Alpha.</p>' +
      '<h2>beta</h2><p>Beta.</p>';
    const result = extractConfluenceSection('alpha', 'h2', xhtml);

    expect(result.found).toBe(true);
    expect(result.sectionContent).toBe(
      xhtml.slice(result.sectionStartOffset, result.sectionEndOffset),
    );
  });

  it('is case-insensitive for the heading tag (matches <H2> and <h2>)', () => {
    const xhtml = '<H2>mixedCase</H2><p>Body.</p>';
    const result = extractConfluenceSection('mixedCase', 'h2', xhtml);

    expect(result.found).toBe(true);
  });

  it('handles function names that contain no special regex characters', () => {
    const xhtml = '<h2>detectDrift</h2><p>Detects drift.</p>';
    const result = extractConfluenceSection('detectDrift', 'h2', xhtml);

    expect(result.found).toBe(true);
    expect(result.sectionContent).toContain('detectDrift');
  });

  it('searches h3 elements when headingLevel is h3', () => {
    const xhtml =
      '<h2>notThis</h2>' +
      '<h3>targetFunc</h3><p>Target content.</p>' +
      '<h3>nextFunc</h3>';
    const result = extractConfluenceSection('targetFunc', 'h3', xhtml);

    expect(result.found).toBe(true);
    expect(result.sectionContent).toContain('<h3>targetFunc</h3>');
    expect(result.sectionContent).not.toContain('<h3>nextFunc</h3>');
  });
});

// ---------------------------------------------------------------------------
// R-4 — Fixture-based test: real Confluence storage-format XHTML
//
// This test reads the on-disk fixture file directly and calls
// extractConfluenceSection with the raw XHTML string. No axios mock is used.
// This is the R-4 acceptance-criteria test required before the implementation
// phase can close (see docs/impl-plan.md §R-4 and §T-09).
// ---------------------------------------------------------------------------

describe('R-4 — Fixture-based heading extraction', () => {
  it('finds all expected function names from fixture-meta.json in the Confluence fixture', () => {
    const fixturePath = resolve(FIXTURE_DIR, 'page-32833537-body.html');
    const metaPath = resolve(FIXTURE_DIR, 'fixture-meta.json');

    const xhtml = readFileSync(fixturePath, 'utf8');
    const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as {
      pageId: string;
      headingLevel: string;
      expectedFunctionNames: string[];
    };

    expect(meta.expectedFunctionNames.length).toBeGreaterThan(0);

    for (const funcName of meta.expectedFunctionNames) {
      const result = extractConfluenceSection(funcName, meta.headingLevel, xhtml);

      expect(
        result.found,
        `Expected heading for "${funcName}" at level <${meta.headingLevel}> to be found in fixture`,
      ).toBe(true);

      // sectionContent must contain the opening heading tag with the function name
      expect(result.sectionContent).toContain(
        `<${meta.headingLevel}>${funcName}</${meta.headingLevel}>`,
      );

      // Offsets must be valid and consistent
      expect(result.sectionStartOffset).toBeGreaterThanOrEqual(0);
      expect(result.sectionEndOffset).toBeGreaterThan(result.sectionStartOffset);
      expect(result.sectionContent).toBe(
        xhtml.slice(result.sectionStartOffset, result.sectionEndOffset),
      );
    }
  });

  it('R-4: sectionContent for each fixture function does not bleed into the next section', () => {
    const fixturePath = resolve(FIXTURE_DIR, 'page-32833537-body.html');
    const metaPath = resolve(FIXTURE_DIR, 'fixture-meta.json');

    const xhtml = readFileSync(fixturePath, 'utf8');
    const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as {
      pageId: string;
      headingLevel: string;
      expectedFunctionNames: string[];
    };

    const names = meta.expectedFunctionNames;

    for (let i = 0; i < names.length - 1; i++) {
      const currentName = names[i]!;
      const nextName = names[i + 1]!;

      const result = extractConfluenceSection(currentName, meta.headingLevel, xhtml);

      expect(result.found).toBe(true);
      // Current section must NOT contain the next function's heading
      expect(result.sectionContent).not.toContain(
        `<${meta.headingLevel}>${nextName}</${meta.headingLevel}>`,
      );
    }
  });

  it('R-4: fixture file is non-empty and contains at least one expected function heading', () => {
    const fixturePath = resolve(FIXTURE_DIR, 'page-32833537-body.html');
    const metaPath = resolve(FIXTURE_DIR, 'fixture-meta.json');

    const xhtml = readFileSync(fixturePath, 'utf8');
    const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as {
      pageId: string;
      headingLevel: string;
      expectedFunctionNames: string[];
    };

    expect(xhtml.length).toBeGreaterThan(0);
    expect(meta.expectedFunctionNames.length).toBeGreaterThan(0);

    // At least one of the expected function names must produce a successful extraction
    const anyFound = meta.expectedFunctionNames.some(
      name => extractConfluenceSection(name, meta.headingLevel, xhtml).found,
    );
    expect(anyFound).toBe(true);
  });
});
