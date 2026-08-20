/**
 * E2E scenario: Happy Path — Confluence
 *
 * A modified exported function whose name matches an existing heading in a
 * Confluence page flows through the full pipeline:
 *   detectDrift → locateConfluenceSection (stale) → regenerateConfluenceSection
 *   → ConfluencePublisher.writeDraft → commitAndPush → createPR
 *
 * The resulting PR body includes `confluenceDraftPageIds` in the doc-sync-meta
 * block so that Workflow 2 can publish the draft on PR merge.
 *
 * Acceptance criteria covered: AC-2, AC-3, AC-4
 *
 * MOCK_API_MODE=true — no real external API calls.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mock state
// ---------------------------------------------------------------------------

const mockRollbackInstance = vi.hoisted(() => ({
  register: vi.fn(),
  rollback: vi.fn<[], Promise<void>>().mockResolvedValue(undefined),
}));

const mockValidateTrigger = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    mergeSha: 'sha-confluence-happy-abcdef12345678',
    baseSha: 'sha-confluence-happy-abcdef12345678^1',
    changedFiles: ['src/drift-detector/index.ts'],
    owner: 'testowner',
    repo: 'testrepo',
  }),
);

const mockDetectDrift = vi.hoisted(() => vi.fn<[], Promise<unknown[]>>());

const mockLocateMarkdownSection = vi.hoisted(() => vi.fn());
const mockLocateConfluenceSection = vi.hoisted(() => vi.fn());
const mockResolveScaffoldTarget = vi.hoisted(() => vi.fn().mockReturnValue('docs/api.md'));

const mockCompareDrift = vi.hoisted(() => vi.fn<[unknown, { target: string }], string>());

const mockRegenerateConfluenceSection = vi.hoisted(() =>
  vi.fn<[string, unknown, unknown], string>().mockReturnValue(
    '<h2>detectDrift</h2><pre><code>export async function detectDrift(...)</code></pre><p>Updated docs.</p>',
  ),
);

const mockGitPublisherInstance = vi.hoisted(() => ({
  createSyncBranch: vi.fn<[string, unknown], Promise<void>>().mockResolvedValue(undefined),
  writeDocFile: vi.fn<[string, string, unknown], Promise<void>>().mockResolvedValue(undefined),
  createDefaultDocFile: vi.fn<[string, unknown], Promise<void>>().mockResolvedValue(undefined),
  commitAndPush: vi.fn<[string[], string], Promise<void>>().mockResolvedValue(undefined),
  createPR: vi
    .fn<[unknown], Promise<string>>()
    .mockResolvedValue('https://github.com/testowner/testrepo/pull/8'),
}));

const mockConfluencePublisherInstance = vi.hoisted(() => ({
  fetchPage: vi.fn().mockResolvedValue({
    body: '<h2>detectDrift</h2><p>Old docs.</p>',
    version: 3,
    title: 'API Docs',
  }),
  writeDraft: vi.fn<[string, string, number, unknown], Promise<void>>().mockResolvedValue(undefined),
}));

const mockReadFile = vi.hoisted(() =>
  vi.fn<[string, string], Promise<string>>().mockResolvedValue(''),
);

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('../../src/rollback-manager.js', () => ({
  RollbackManager: vi.fn().mockImplementation(() => mockRollbackInstance),
}));

vi.mock('../../src/trigger-validator.js', () => ({
  validateTrigger: mockValidateTrigger,
}));

vi.mock('../../src/drift-detector/index.js', () => ({
  detectDrift: mockDetectDrift,
}));

vi.mock('../../src/doc-locator/index.js', () => ({
  locateMarkdownSection: mockLocateMarkdownSection,
  locateConfluenceSection: mockLocateConfluenceSection,
  resolveScaffoldTarget: mockResolveScaffoldTarget,
}));

vi.mock('../../src/drift-comparator.js', () => ({
  compareDrift: mockCompareDrift,
}));

vi.mock('../../src/regenerator/index.js', () => ({
  regenerateMarkdownSection: vi.fn().mockReturnValue('updated markdown'),
  regenerateConfluenceSection: mockRegenerateConfluenceSection,
  buildScaffoldSection: vi.fn().mockReturnValue('## fn\n\nnew fn.\n'),
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

let exitSpy: ReturnType<typeof vi.spyOn>;
let consoleLogSpy: ReturnType<typeof vi.spyOn>;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  for (const key of MANAGED_ENV_VARS) {
    savedEnv[key] = process.env[key];
  }

  process.env['MOCK_API_MODE'] = 'true';
  delete process.env['CONFLUENCE_PAGE_ID'];
  process.env['GITHUB_SHA'] = 'sha-confluence-happy-abcdef12345678';
  process.env['GITHUB_REPOSITORY'] = 'testowner/testrepo';

  // Resets
  mockRollbackInstance.register.mockReset();
  mockRollbackInstance.rollback.mockReset().mockResolvedValue(undefined);

  mockValidateTrigger.mockReset().mockResolvedValue({
    mergeSha: 'sha-confluence-happy-abcdef12345678',
    baseSha: 'sha-confluence-happy-abcdef12345678^1',
    changedFiles: ['src/drift-detector/index.ts'],
    owner: 'testowner',
    repo: 'testrepo',
  });

  // Modified function: detectDrift
  mockDetectDrift.mockReset().mockResolvedValue([
    {
      name: 'detectDrift',
      signature: 'export async function detectDrift(changedFilePaths: string[], sha: string): Promise<ExportedFunction[]>',
      jsdoc: 'Detects drift in exported TypeScript functions.',
      sourceFilePath: 'src/drift-detector/index.ts',
      changeType: 'modified',
    },
  ]);

  // Markdown: not-found; Confluence: stale
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
    confluenceVersionNumber: 3,
    sectionContent: '<h2>detectDrift</h2><p>Old docs.</p>',
    sectionStartOffset: 0,
    sectionEndOffset: 42,
  });

  // compareDrift: not-found for markdown, stale for confluence
  mockCompareDrift.mockReset().mockImplementation((_fn, section: { target: string }) => {
    if (section.target === 'confluence') return 'stale';
    return 'not-found';
  });

  mockRegenerateConfluenceSection.mockReset().mockReturnValue(
    '<h2>detectDrift</h2><pre><code>updated signature</code></pre><p>Updated docs.</p>',
  );

  mockReadFile.mockReset().mockResolvedValue('');

  mockGitPublisherInstance.createSyncBranch.mockReset().mockResolvedValue(undefined);
  mockGitPublisherInstance.writeDocFile.mockReset().mockResolvedValue(undefined);
  mockGitPublisherInstance.createDefaultDocFile.mockReset().mockResolvedValue(undefined);
  mockGitPublisherInstance.commitAndPush.mockReset().mockResolvedValue(undefined);
  mockGitPublisherInstance.createPR
    .mockReset()
    .mockResolvedValue('https://github.com/testowner/testrepo/pull/8');

  mockConfluencePublisherInstance.fetchPage.mockReset().mockResolvedValue({
    body: '<h2>detectDrift</h2><p>Old docs.</p>',
    version: 3,
    title: 'API Docs',
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

describe('e2e: happy-path-confluence — modified function regenerated into Confluence draft', () => {
  it('runs to completion without error when Confluence section is stale', async () => {
    await run();

    expect(exitSpy).not.toHaveBeenCalled();
    expect(mockRollbackInstance.rollback).not.toHaveBeenCalled();
  });

  it('calls ConfluencePublisher.fetchPage to obtain the current XHTML body', async () => {
    await run();

    // fetchPage is called inside writeDraft (register-then-mutate step 1)
    expect(mockConfluencePublisherInstance.fetchPage).toHaveBeenCalledWith('32833537');
  });

  it('calls ConfluencePublisher.writeDraft with the regenerated XHTML and correct version', async () => {
    await run();

    expect(mockConfluencePublisherInstance.writeDraft).toHaveBeenCalledOnce();
    const [pageId, _html, version] = mockConfluencePublisherInstance.writeDraft.mock
      .calls[0] as [string, string, number, unknown];
    expect(pageId).toBe('32833537');
    expect(version).toBe(3);
  });

  it('calls GitPublisher.createPR after writing the Confluence draft', async () => {
    await run();

    expect(mockGitPublisherInstance.createPR).toHaveBeenCalledOnce();
  });

  it('emits PipelineResult JSON with the Confluence page in regenerated and confluenceDraftPageIds', async () => {
    await run();

    const resultCall = consoleLogSpy.mock.calls.find(
      (args) => typeof args[0] === 'string' && (args[0] as string).includes('triggerCommitSha'),
    );
    expect(resultCall).toBeDefined();
    const parsed = JSON.parse(resultCall![0] as string) as Record<string, unknown>;

    expect(parsed['regenerated']).toEqual([
      { name: 'detectDrift', target: 'confluence', location: '32833537' },
    ]);
    expect(parsed['confluenceDraftPageIds']).toEqual(['32833537']);
    expect(parsed['prUrl']).toBe('https://github.com/testowner/testrepo/pull/8');
  });

  it('does not call GitPublisher.writeDocFile when only the Confluence section is stale', async () => {
    await run();

    expect(mockGitPublisherInstance.writeDocFile).not.toHaveBeenCalled();
  });
});
