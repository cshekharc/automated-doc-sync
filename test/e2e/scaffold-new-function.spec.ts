/**
 * E2E scenario: Scaffold New Function
 *
 * When a newly exported function (changeType: 'added') has no matching
 * heading in any documentation target, `buildScaffoldSection` is called and
 * the result is appended to the resolved scaffold target file (e.g.
 * `docs/api.md`). A PR is then opened with the scaffolded entry listed under
 * `### Scaffolded sections`.
 *
 * AC-9 acceptance criterion verified.
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
    mergeSha: 'sha-scaffold-test-abcdef123456',
    baseSha: 'sha-scaffold-test-abcdef123456^1',
    changedFiles: ['src/new-module.ts'],
    owner: 'testowner',
    repo: 'testrepo',
  }),
);

const mockDetectDrift = vi.hoisted(() => vi.fn<[], Promise<unknown[]>>());

const mockLocateMarkdownSection = vi.hoisted(() => vi.fn());
const mockLocateConfluenceSection = vi.hoisted(() => vi.fn());
const mockResolveScaffoldTarget = vi.hoisted(() => vi.fn().mockReturnValue('docs/api.md'));

const mockCompareDrift = vi.hoisted(() => vi.fn<[unknown, { target: string }], string>());

const mockBuildScaffoldSection = vi.hoisted(() =>
  vi.fn<[unknown], string>().mockReturnValue(
    '## newFunction\n\n```typescript\nexport function newFunction(): void\n```\n\nA newly added function.\n',
  ),
);

const mockGitPublisherInstance = vi.hoisted(() => ({
  createSyncBranch: vi.fn<[string, unknown], Promise<void>>().mockResolvedValue(undefined),
  writeDocFile: vi.fn<[string, string, unknown], Promise<void>>().mockResolvedValue(undefined),
  createDefaultDocFile: vi.fn<[string, unknown], Promise<void>>().mockResolvedValue(undefined),
  commitAndPush: vi.fn<[string[], string], Promise<void>>().mockResolvedValue(undefined),
  createPR: vi
    .fn<[unknown], Promise<string>>()
    .mockResolvedValue('https://github.com/testowner/testrepo/pull/11'),
}));

const mockConfluencePublisherInstance = vi.hoisted(() => ({
  fetchPage: vi.fn().mockResolvedValue({ body: '', version: 1, title: 'API Docs' }),
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
  regenerateMarkdownSection: vi.fn().mockReturnValue('updated'),
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
  // No CONFLUENCE_PAGE_ID → Confluence scaffold skipped
  delete process.env['CONFLUENCE_PAGE_ID'];
  process.env['GITHUB_SHA'] = 'sha-scaffold-test-abcdef123456';
  process.env['GITHUB_REPOSITORY'] = 'testowner/testrepo';

  // Resets
  mockRollbackInstance.register.mockReset();
  mockRollbackInstance.rollback.mockReset().mockResolvedValue(undefined);

  mockValidateTrigger.mockReset().mockResolvedValue({
    mergeSha: 'sha-scaffold-test-abcdef123456',
    baseSha: 'sha-scaffold-test-abcdef123456^1',
    changedFiles: ['src/new-module.ts'],
    owner: 'testowner',
    repo: 'testrepo',
  });

  // A newly added function — changeType 'added'
  mockDetectDrift.mockReset().mockResolvedValue([
    {
      name: 'newFunction',
      signature: 'export function newFunction(): void',
      jsdoc: 'A newly added function.',
      sourceFilePath: 'src/new-module.ts',
      changeType: 'added',
    },
  ]);

  // No existing documentation section in either target
  mockLocateMarkdownSection.mockReset().mockResolvedValue({
    functionName: 'newFunction',
    target: 'not-found',
    sectionContent: '',
  });
  mockLocateConfluenceSection.mockReset().mockResolvedValue({
    functionName: 'newFunction',
    target: 'not-found',
    sectionContent: '',
  });

  // compareDrift returns 'not-found' for both (section.target === 'not-found')
  mockCompareDrift.mockReset().mockReturnValue('not-found');

  // Scaffold target resolves to docs/api.md
  mockResolveScaffoldTarget.mockReset().mockReturnValue('docs/api.md');

  // readFile returns empty string (new/empty scaffold target file)
  mockReadFile.mockReset().mockResolvedValue('');

  mockBuildScaffoldSection.mockReset().mockReturnValue(
    '## newFunction\n\n```typescript\nexport function newFunction(): void\n```\n\nA newly added function.\n',
  );

  mockGitPublisherInstance.createSyncBranch.mockReset().mockResolvedValue(undefined);
  mockGitPublisherInstance.writeDocFile.mockReset().mockResolvedValue(undefined);
  mockGitPublisherInstance.createDefaultDocFile.mockReset().mockResolvedValue(undefined);
  mockGitPublisherInstance.commitAndPush.mockReset().mockResolvedValue(undefined);
  mockGitPublisherInstance.createPR
    .mockReset()
    .mockResolvedValue('https://github.com/testowner/testrepo/pull/11');

  mockConfluencePublisherInstance.fetchPage.mockReset().mockResolvedValue({
    body: '',
    version: 1,
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

describe('e2e: scaffold-new-function — added function gets skeleton section scaffolded', () => {
  it('runs to completion without error for a newly added function', async () => {
    await run();

    expect(exitSpy).not.toHaveBeenCalled();
    expect(mockRollbackInstance.rollback).not.toHaveBeenCalled();
  });

  it('calls GitPublisher.createDefaultDocFile with the scaffold target path', async () => {
    await run();

    expect(mockGitPublisherInstance.createDefaultDocFile).toHaveBeenCalledOnce();
    const [path] = mockGitPublisherInstance.createDefaultDocFile.mock.calls[0] as [string];
    expect(path).toBe('docs/api.md');
  });

  it('calls buildScaffoldSection with the added function', async () => {
    await run();

    expect(mockBuildScaffoldSection).toHaveBeenCalledOnce();
    const [fn] = mockBuildScaffoldSection.mock.calls[0] as [{ name: string }];
    expect(fn.name).toBe('newFunction');
  });

  it('calls GitPublisher.writeDocFile with docs/api.md containing the scaffold content', async () => {
    await run();

    expect(mockGitPublisherInstance.writeDocFile).toHaveBeenCalledOnce();
    const [filePath, content] = mockGitPublisherInstance.writeDocFile.mock.calls[0] as [
      string,
      string,
    ];
    expect(filePath).toBe('docs/api.md');
    expect(content).toContain('newFunction');
  });

  it('emits PipelineResult with scaffolded entry targeting markdown docs/api.md', async () => {
    await run();

    const resultCall = consoleLogSpy.mock.calls.find(
      (args) => typeof args[0] === 'string' && (args[0] as string).includes('triggerCommitSha'),
    );
    expect(resultCall).toBeDefined();
    const parsed = JSON.parse(resultCall![0] as string) as Record<string, unknown>;

    expect(parsed['scaffolded']).toEqual([
      { name: 'newFunction', target: 'markdown', location: 'docs/api.md' },
    ]);
    expect(parsed['notFound']).toEqual([]);
    expect(parsed['regenerated']).toEqual([]);
  });

  it('resolves the scaffold target path using resolveScaffoldTarget', async () => {
    await run();

    expect(mockResolveScaffoldTarget).toHaveBeenCalledWith('src/new-module.ts');
  });
});
