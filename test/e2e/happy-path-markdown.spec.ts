/**
 * E2E scenario: Happy Path — Markdown
 *
 * A modified exported function whose name matches an existing `##` heading in
 * `docs/api.md` flows through the full pipeline:
 *   detectDrift → locateMarkdownSection (stale) → regenerateMarkdownSection
 *   → GitPublisher.writeDocFile → commitAndPush → createPR
 *
 * Acceptance criteria covered: AC-1, AC-2, AC-3, AC-4
 *
 * MOCK_API_MODE=true — no real external API calls are made.
 * All sub-modules are replaced with vi.mock() factory stubs.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist shared mock state
// ---------------------------------------------------------------------------

const mockRollbackInstance = vi.hoisted(() => ({
  register: vi.fn(),
  rollback: vi.fn<[], Promise<void>>().mockResolvedValue(undefined),
}));

const mockValidateTrigger = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    mergeSha: 'sha-happy-markdown-1234567890abcdef',
    baseSha: 'sha-happy-markdown-1234567890abcdef^1',
    changedFiles: ['src/utils.ts'],
    owner: 'testowner',
    repo: 'testrepo',
  }),
);

const mockDetectDrift = vi.hoisted(() => vi.fn<[], Promise<unknown[]>>());

const mockLocateMarkdownSection = vi.hoisted(() => vi.fn());
const mockLocateConfluenceSection = vi.hoisted(() => vi.fn());
const mockResolveScaffoldTarget = vi.hoisted(() => vi.fn().mockReturnValue('docs/api.md'));

const mockCompareDrift = vi.hoisted(() => vi.fn<[unknown, { target: string }], string>());

const mockRegenerateMarkdownSection = vi.hoisted(() =>
  vi.fn<[string, unknown, unknown], string>().mockReturnValue(
    '## fetchUser\n\n```typescript\nexport function fetchUser(id: string): User\n```\n\nFetches a user by ID.\n',
  ),
);

const mockBuildScaffoldSection = vi.hoisted(() =>
  vi.fn<[unknown], string>().mockReturnValue('## newFn\n\nnew fn.\n'),
);

const mockGitPublisherInstance = vi.hoisted(() => ({
  createSyncBranch: vi.fn<[string, unknown], Promise<void>>().mockResolvedValue(undefined),
  writeDocFile: vi.fn<[string, string, unknown], Promise<void>>().mockResolvedValue(undefined),
  createDefaultDocFile: vi.fn<[string, unknown], Promise<void>>().mockResolvedValue(undefined),
  commitAndPush: vi.fn<[string[], string], Promise<void>>().mockResolvedValue(undefined),
  createPR: vi
    .fn<[unknown], Promise<string>>()
    .mockResolvedValue('https://github.com/testowner/testrepo/pull/7'),
}));

const mockConfluencePublisherInstance = vi.hoisted(() => ({
  fetchPage: vi.fn().mockResolvedValue({ body: '<h2>fetchUser</h2>', version: 1, title: 'Docs' }),
  writeDraft: vi.fn<[string, string, number, unknown], Promise<void>>().mockResolvedValue(undefined),
}));

const mockReadFile = vi.hoisted(() =>
  vi.fn<[string, string], Promise<string>>().mockResolvedValue(
    '# API Reference\n\n## fetchUser\n\nOld description.\n',
  ),
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
  regenerateMarkdownSection: mockRegenerateMarkdownSection,
  regenerateConfluenceSection: vi.fn().mockReturnValue('<h2>fn</h2>'),
  buildScaffoldSection: mockBuildScaffoldSection,
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
// Import under test (AFTER vi.mock declarations)
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
  // Save existing env var values
  for (const key of MANAGED_ENV_VARS) {
    savedEnv[key] = process.env[key];
  }

  // MOCK_API_MODE=true: signals that no real external API calls should be made
  process.env['MOCK_API_MODE'] = 'true';
  delete process.env['CONFLUENCE_PAGE_ID'];
  process.env['GITHUB_SHA'] = 'sha-happy-markdown-1234567890abcdef';
  process.env['GITHUB_REPOSITORY'] = 'testowner/testrepo';

  // Reset mock state
  mockRollbackInstance.register.mockReset();
  mockRollbackInstance.rollback.mockReset().mockResolvedValue(undefined);

  mockValidateTrigger.mockReset().mockResolvedValue({
    mergeSha: 'sha-happy-markdown-1234567890abcdef',
    baseSha: 'sha-happy-markdown-1234567890abcdef^1',
    changedFiles: ['src/utils.ts'],
    owner: 'testowner',
    repo: 'testrepo',
  });

  // One modified function: fetchUser
  mockDetectDrift.mockReset().mockResolvedValue([
    {
      name: 'fetchUser',
      signature: 'export function fetchUser(id: string): User',
      jsdoc: 'Fetches a user by their ID.',
      sourceFilePath: 'src/utils.ts',
      changeType: 'modified',
    },
  ]);

  // Markdown section found and stale; Confluence section not found
  mockLocateMarkdownSection.mockReset().mockResolvedValue({
    functionName: 'fetchUser',
    target: 'markdown',
    markdownFilePath: 'docs/api.md',
    sectionContent: '## fetchUser\n\nOld description.\n',
    sectionStartOffset: 15,
    sectionEndOffset: 40,
  });

  mockLocateConfluenceSection.mockReset().mockResolvedValue({
    functionName: 'fetchUser',
    target: 'not-found',
    sectionContent: '',
  });

  // compareDrift: stale for markdown, not-found for confluence
  mockCompareDrift.mockReset().mockImplementation((_fn, section: { target: string }) => {
    if (section.target === 'markdown') return 'stale';
    return 'not-found';
  });

  mockRegenerateMarkdownSection.mockReset().mockReturnValue(
    '## fetchUser\n\n```typescript\nexport function fetchUser(id: string): User\n```\n\nFetches a user by their ID.\n',
  );

  mockReadFile.mockReset().mockResolvedValue('# API Reference\n\n## fetchUser\n\nOld description.\n');

  mockGitPublisherInstance.createSyncBranch.mockReset().mockResolvedValue(undefined);
  mockGitPublisherInstance.writeDocFile.mockReset().mockResolvedValue(undefined);
  mockGitPublisherInstance.createDefaultDocFile.mockReset().mockResolvedValue(undefined);
  mockGitPublisherInstance.commitAndPush.mockReset().mockResolvedValue(undefined);
  mockGitPublisherInstance.createPR
    .mockReset()
    .mockResolvedValue('https://github.com/testowner/testrepo/pull/7');

  mockConfluencePublisherInstance.fetchPage.mockReset().mockResolvedValue({
    body: '<h2>fetchUser</h2>',
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

describe('e2e: happy-path-markdown — modified function regenerated into docs/*.md', () => {
  it('runs to completion without error when docs/api.md heading is stale', async () => {
    await run();

    expect(exitSpy).not.toHaveBeenCalled();
    expect(mockRollbackInstance.rollback).not.toHaveBeenCalled();
  });

  it('calls GitPublisher.writeDocFile with the markdown path containing regenerated content', async () => {
    await run();

    expect(mockGitPublisherInstance.writeDocFile).toHaveBeenCalledOnce();
    const [filePath, content] = mockGitPublisherInstance.writeDocFile.mock.calls[0] as [
      string,
      string,
    ];
    expect(filePath).toBe('docs/api.md');
    expect(content).toContain('fetchUser');
  });

  it('calls GitPublisher.commitAndPush with the affected function name and trigger SHA', async () => {
    await run();

    expect(mockGitPublisherInstance.commitAndPush).toHaveBeenCalledOnce();
    const [affectedNames, sha] = mockGitPublisherInstance.commitAndPush.mock.calls[0] as [
      string[],
      string,
    ];
    expect(affectedNames).toContain('fetchUser');
    expect(sha).toBe('sha-happy-markdown-1234567890abcdef');
  });

  it('calls GitPublisher.createPR and opens a pull request', async () => {
    await run();

    expect(mockGitPublisherInstance.createPR).toHaveBeenCalledOnce();
  });

  it('emits a PipelineResult JSON with regenerated entry for the markdown section', async () => {
    await run();

    expect(consoleLogSpy).toHaveBeenCalled();
    // Find the call that has a JSON PipelineResult (contains triggerCommitSha)
    const resultCall = consoleLogSpy.mock.calls.find(
      (args) => typeof args[0] === 'string' && (args[0] as string).includes('triggerCommitSha'),
    );
    expect(resultCall).toBeDefined();
    const parsed = JSON.parse(resultCall![0] as string) as Record<string, unknown>;

    expect(parsed['triggerCommitSha']).toBe('sha-happy-markdown-1234567890abcdef');
    expect(parsed['regenerated']).toEqual([
      { name: 'fetchUser', target: 'markdown', location: 'docs/api.md' },
    ]);
    expect(parsed['scaffolded']).toEqual([]);
    expect(parsed['notFound']).toEqual([]);
    expect(parsed['confluenceDraftPageIds']).toEqual([]);
    expect(parsed['prUrl']).toBe('https://github.com/testowner/testrepo/pull/7');
    expect(parsed['skipped']).toBe(false);
  });

  it('does not call ConfluencePublisher.writeDraft when only the markdown section is stale', async () => {
    await run();

    expect(mockConfluencePublisherInstance.writeDraft).not.toHaveBeenCalled();
  });
});
