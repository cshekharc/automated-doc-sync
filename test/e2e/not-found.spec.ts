/**
 * E2E scenario: Not Found
 *
 * When a modified exported function has no matching heading in any
 * documentation target (Markdown or Confluence), it is recorded in the
 * pipeline result's `notFound` array and listed under "Known Limitations" in
 * the PR description. The pipeline still completes successfully (exit 0).
 *
 * AC-5 acceptance criterion verified.
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
    mergeSha: 'sha-not-found-abcdef1234567890',
    baseSha: 'sha-not-found-abcdef1234567890^1',
    changedFiles: ['src/orphan.ts'],
    owner: 'testowner',
    repo: 'testrepo',
  }),
);

const mockDetectDrift = vi.hoisted(() => vi.fn<[], Promise<unknown[]>>());

const mockLocateMarkdownSection = vi.hoisted(() => vi.fn());
const mockLocateConfluenceSection = vi.hoisted(() => vi.fn());

const mockCompareDrift = vi.hoisted(() => vi.fn<[unknown, { target: string }], string>());

const mockGitPublisherInstance = vi.hoisted(() => ({
  createSyncBranch: vi.fn<[string, unknown], Promise<void>>().mockResolvedValue(undefined),
  writeDocFile: vi.fn<[string, string, unknown], Promise<void>>().mockResolvedValue(undefined),
  createDefaultDocFile: vi.fn<[string, unknown], Promise<void>>().mockResolvedValue(undefined),
  commitAndPush: vi.fn<[string[], string], Promise<void>>().mockResolvedValue(undefined),
  createPR: vi
    .fn<[unknown], Promise<string>>()
    .mockResolvedValue('https://github.com/testowner/testrepo/pull/15'),
}));

const mockConfluencePublisherInstance = vi.hoisted(() => ({
  fetchPage: vi.fn().mockResolvedValue({ body: '', version: 1, title: 'Docs' }),
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
  resolveScaffoldTarget: vi.fn().mockReturnValue('docs/api.md'),
}));

vi.mock('../../src/drift-comparator.js', () => ({
  compareDrift: mockCompareDrift,
}));

vi.mock('../../src/regenerator/index.js', () => ({
  regenerateMarkdownSection: vi.fn().mockReturnValue('updated'),
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
  process.env['GITHUB_SHA'] = 'sha-not-found-abcdef1234567890';
  process.env['GITHUB_REPOSITORY'] = 'testowner/testrepo';

  // Resets
  mockRollbackInstance.register.mockReset();
  mockRollbackInstance.rollback.mockReset().mockResolvedValue(undefined);

  mockValidateTrigger.mockReset().mockResolvedValue({
    mergeSha: 'sha-not-found-abcdef1234567890',
    baseSha: 'sha-not-found-abcdef1234567890^1',
    changedFiles: ['src/orphan.ts'],
    owner: 'testowner',
    repo: 'testrepo',
  });

  // Modified function with no matching documentation section
  mockDetectDrift.mockReset().mockResolvedValue([
    {
      name: 'orphanFn',
      signature: 'export function orphanFn(): string',
      jsdoc: 'An orphan function with no docs.',
      sourceFilePath: 'src/orphan.ts',
      changeType: 'modified', // 'modified', not 'added' → goes to notFound
    },
  ]);

  // Both locators return not-found
  mockLocateMarkdownSection.mockReset().mockResolvedValue({
    functionName: 'orphanFn',
    target: 'not-found',
    sectionContent: '',
  });
  mockLocateConfluenceSection.mockReset().mockResolvedValue({
    functionName: 'orphanFn',
    target: 'not-found',
    sectionContent: '',
  });

  // compareDrift returns 'not-found' for both sections (target === 'not-found')
  mockCompareDrift.mockReset().mockReturnValue('not-found');

  mockReadFile.mockReset().mockResolvedValue('');

  mockGitPublisherInstance.createSyncBranch.mockReset().mockResolvedValue(undefined);
  mockGitPublisherInstance.writeDocFile.mockReset().mockResolvedValue(undefined);
  mockGitPublisherInstance.createDefaultDocFile.mockReset().mockResolvedValue(undefined);
  mockGitPublisherInstance.commitAndPush.mockReset().mockResolvedValue(undefined);
  mockGitPublisherInstance.createPR
    .mockReset()
    .mockResolvedValue('https://github.com/testowner/testrepo/pull/15');

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

describe('e2e: not-found — modified function with no matching heading listed as Known Limitation', () => {
  it('runs to completion without error when function has no matching heading', async () => {
    await run();

    expect(exitSpy).not.toHaveBeenCalled();
    expect(mockRollbackInstance.rollback).not.toHaveBeenCalled();
  });

  it('emits PipelineResult with notFound entry for the orphaned function', async () => {
    await run();

    const resultCall = consoleLogSpy.mock.calls.find(
      (args) => typeof args[0] === 'string' && (args[0] as string).includes('triggerCommitSha'),
    );
    expect(resultCall).toBeDefined();
    const parsed = JSON.parse(resultCall![0] as string) as Record<string, unknown>;

    expect(parsed['notFound']).toEqual([
      { name: 'orphanFn', sourceFilePath: 'src/orphan.ts' },
    ]);
    expect(parsed['regenerated']).toEqual([]);
    expect(parsed['scaffolded']).toEqual([]);
  });

  it('still calls GitPublisher.createPR so reviewers can see the Known Limitations', async () => {
    await run();

    expect(mockGitPublisherInstance.createPR).toHaveBeenCalledOnce();
    // The createPR argument is a PipelineResult; verify notFound is present
    const [pipelineResult] = mockGitPublisherInstance.createPR.mock.calls[0] as [
      { notFound: Array<{ name: string; sourceFilePath: string }> },
    ];
    expect(pipelineResult.notFound).toEqual([
      { name: 'orphanFn', sourceFilePath: 'src/orphan.ts' },
    ]);
  });

  it('does not call GitPublisher.writeDocFile or createDefaultDocFile', async () => {
    await run();

    expect(mockGitPublisherInstance.writeDocFile).not.toHaveBeenCalled();
    expect(mockGitPublisherInstance.createDefaultDocFile).not.toHaveBeenCalled();
  });

  it('does not call ConfluencePublisher.writeDraft', async () => {
    await run();

    expect(mockConfluencePublisherInstance.writeDraft).not.toHaveBeenCalled();
  });
});
