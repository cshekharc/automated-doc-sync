/**
 * Unit tests for T-15 — PipelineOrchestrator (`src/pipeline.ts`).
 *
 * All sub-modules imported by the pipeline are mocked with `vi.mock` factory
 * functions using `vi.hoisted()` variables so that mock instances are
 * available both inside mock factory closures and in test bodies.
 *
 * `process.exit` is intercepted via `vi.spyOn` and replaced with an
 * implementation that throws so tests can assert on the exit code without
 * terminating the test process.
 *
 * Acceptance criteria verified:
 * 1. Error at any pipeline step → `rollback.rollback()` called,
 *    `process.exit(1)` called.
 * 2. On success → `PipelineResult` JSON emitted to stdout with the correct
 *    shape: `triggerCommitSha`, `regenerated`, `scaffolded`, `notFound`,
 *    `confluenceDraftPageIds`, `prUrl`, `skipped`.
 * 3. A mock secret injected into a simulated error message appears as
 *    `[REDACTED]` in the `console.error` output.
 * 4. On idempotency skip (TriggerValidator calls `process.exit(0)`) →
 *    `rollback.rollback()` is NOT called and the pipeline resolves cleanly.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist shared mock state — must be declared before vi.mock() factories.
// ---------------------------------------------------------------------------

/** Shared RollbackManager instance returned by the mocked constructor. */
const mockRollbackInstance = vi.hoisted(() => ({
  register: vi.fn(),
  rollback: vi.fn<[], Promise<void>>().mockResolvedValue(undefined),
}));

/** validateTrigger mock — returns a TriggerContext by default. */
const mockValidateTrigger = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    mergeSha: 'test-merge-sha-abcdef1234567890',
    baseSha: 'test-merge-sha-abcdef1234567890^1',
    changedFiles: [],
    owner: 'testowner',
    repo: 'testrepo',
  }),
);

/** detectDrift mock — returns an empty array by default. */
const mockDetectDrift = vi.hoisted(() =>
  vi.fn<[], Promise<unknown[]>>().mockResolvedValue([]),
);

/** locateMarkdownSection mock — returns a not-found DocSection by default. */
const mockLocateMarkdownSection = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    functionName: 'testFn',
    target: 'not-found',
    sectionContent: '',
  }),
);

/** locateConfluenceSection mock — returns a not-found DocSection by default. */
const mockLocateConfluenceSection = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    functionName: 'testFn',
    target: 'not-found',
    sectionContent: '',
  }),
);

/** resolveScaffoldTarget mock — returns a default docs path. */
const mockResolveScaffoldTarget = vi.hoisted(() =>
  vi.fn().mockReturnValue('docs/api.md'),
);

/** compareDrift mock — returns 'not-found' by default. */
const mockCompareDrift = vi.hoisted(() =>
  vi.fn<[unknown, unknown], string>().mockReturnValue('not-found'),
);

/** regenerateMarkdownSection mock. */
const mockRegenerateMarkdownSection = vi.hoisted(() =>
  vi.fn<[string, unknown, unknown], string>().mockReturnValue('# updated docs\n'),
);

/** regenerateConfluenceSection mock. */
const mockRegenerateConfluenceSection = vi.hoisted(() =>
  vi.fn<[string, unknown, unknown], string>().mockReturnValue('<h2>fn</h2><p>updated</p>'),
);

/** buildScaffoldSection mock. */
const mockBuildScaffoldSection = vi.hoisted(() =>
  vi.fn<[unknown], string>().mockReturnValue('## newFn\n\n```typescript\nnewFn(): void\n```\n\nNew function.\n'),
);

/** Shared GitPublisher instance returned by the mocked constructor. */
const mockGitPublisherInstance = vi.hoisted(() => ({
  createSyncBranch: vi.fn<[string, unknown], Promise<void>>().mockResolvedValue(undefined),
  writeDocFile: vi.fn<[string, string, unknown], Promise<void>>().mockResolvedValue(undefined),
  createDefaultDocFile: vi.fn<[string, unknown], Promise<void>>().mockResolvedValue(undefined),
  commitAndPush: vi.fn<[string[], string], Promise<void>>().mockResolvedValue(undefined),
  createPR: vi
    .fn<[unknown], Promise<string>>()
    .mockResolvedValue('https://github.com/testowner/testrepo/pull/99'),
}));

/** Shared ConfluencePublisher instance returned by the mocked constructor. */
const mockConfluencePublisherInstance = vi.hoisted(() => ({
  fetchPage: vi.fn().mockResolvedValue({ body: '<h2>fn</h2>', version: 3, title: 'Docs' }),
  writeDraft: vi.fn<[string, string, number, unknown], Promise<void>>().mockResolvedValue(undefined),
}));

/** readFile mock — returns empty string by default. */
const mockReadFile = vi.hoisted(() =>
  vi.fn<[string, string], Promise<string>>().mockResolvedValue(''),
);

// ---------------------------------------------------------------------------
// Module mocks (must precede all imports of the module under test)
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
  regenerateConfluenceSection: mockRegenerateConfluenceSection,
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
// Import the module under test AFTER all vi.mock declarations.
// redactSecrets is NOT mocked — the real implementation is used so that
// test 3 (secrets redaction) exercises the actual pattern-matching logic.
// ---------------------------------------------------------------------------

import { run } from '../../src/pipeline.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Builds a minimal ExportedFunction with sensible defaults. */
function makeExportedFunction(overrides: Record<string, unknown> = {}) {
  return {
    name: 'myFn',
    signature: 'export function myFn(): void',
    jsdoc: 'Does something.',
    sourceFilePath: 'src/utils.ts',
    changeType: 'modified' as const,
    ...overrides,
  };
}

/** Builds a stale markdown DocSection for the given function name. */
function makeStaleMdSection(functionName = 'myFn') {
  return {
    functionName,
    target: 'markdown' as const,
    markdownFilePath: 'docs/api.md',
    sectionContent: '## myFn\n\n```typescript\nold()\n```\n\nOld docs.\n',
    sectionStartOffset: 0,
    sectionEndOffset: 50,
  };
}

/** Builds a stale Confluence DocSection for the given function name. */
function makeStaleConfluenceSection(functionName = 'myFn') {
  return {
    functionName,
    target: 'confluence' as const,
    confluencePageId: '32833537',
    confluencePageTitle: 'API Docs',
    confluenceVersionNumber: 5,
    sectionContent: '<h2>myFn</h2><p>Old docs.</p>',
    sectionStartOffset: 0,
    sectionEndOffset: 30,
  };
}

// ---------------------------------------------------------------------------
// Shared setup / teardown
// ---------------------------------------------------------------------------

let exitSpy: ReturnType<typeof vi.spyOn>;
let consoleLogSpy: ReturnType<typeof vi.spyOn>;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // Reset all mocks to their default implementations.
  mockRollbackInstance.register.mockReset();
  mockRollbackInstance.rollback.mockReset().mockResolvedValue(undefined);

  mockValidateTrigger.mockReset().mockResolvedValue({
    mergeSha: 'test-merge-sha-abcdef1234567890',
    baseSha: 'test-merge-sha-abcdef1234567890^1',
    changedFiles: [],
    owner: 'testowner',
    repo: 'testrepo',
  });

  mockDetectDrift.mockReset().mockResolvedValue([]);

  mockLocateMarkdownSection.mockReset().mockResolvedValue({
    functionName: 'testFn',
    target: 'not-found',
    sectionContent: '',
  });
  mockLocateConfluenceSection.mockReset().mockResolvedValue({
    functionName: 'testFn',
    target: 'not-found',
    sectionContent: '',
  });
  mockResolveScaffoldTarget.mockReset().mockReturnValue('docs/api.md');

  mockCompareDrift.mockReset().mockReturnValue('not-found');

  mockRegenerateMarkdownSection.mockReset().mockReturnValue('# updated docs\n');
  mockRegenerateConfluenceSection.mockReset().mockReturnValue('<h2>fn</h2><p>updated</p>');
  mockBuildScaffoldSection.mockReset().mockReturnValue(
    '## newFn\n\n```typescript\nnewFn(): void\n```\n\nNew function.\n',
  );

  mockGitPublisherInstance.createSyncBranch.mockReset().mockResolvedValue(undefined);
  mockGitPublisherInstance.writeDocFile.mockReset().mockResolvedValue(undefined);
  mockGitPublisherInstance.createDefaultDocFile.mockReset().mockResolvedValue(undefined);
  mockGitPublisherInstance.commitAndPush.mockReset().mockResolvedValue(undefined);
  mockGitPublisherInstance.createPR
    .mockReset()
    .mockResolvedValue('https://github.com/testowner/testrepo/pull/99');

  mockConfluencePublisherInstance.fetchPage
    .mockReset()
    .mockResolvedValue({ body: '<h2>fn</h2>', version: 3, title: 'Docs' });
  mockConfluencePublisherInstance.writeDraft.mockReset().mockResolvedValue(undefined);

  mockReadFile.mockReset().mockResolvedValue('');

  // Intercept process.exit so tests do not terminate the process.
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: number) => {
    throw new Error(`process.exit(${code ?? 0})`);
  }) as ReturnType<typeof vi.spyOn>;

  // Suppress console output; captured via spies where assertions need it.
  consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

  // Clear env vars that might affect confluence scaffold path.
  delete process.env['CONFLUENCE_PAGE_ID'];
});

afterEach(() => {
  exitSpy.mockRestore();
  consoleLogSpy.mockRestore();
  consoleErrorSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// 1. Error handling — rollback + process.exit(1)
// ---------------------------------------------------------------------------

describe('error handling — any sub-module failure triggers rollback and exit(1)', () => {
  it('calls rollback.rollback() and process.exit(1) when validateTrigger throws', async () => {
    mockValidateTrigger.mockRejectedValue(new Error('network error'));

    await expect(run()).rejects.toThrow('process.exit(1)');

    expect(mockRollbackInstance.rollback).toHaveBeenCalledOnce();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('calls rollback.rollback() and process.exit(1) when detectDrift throws', async () => {
    mockDetectDrift.mockRejectedValue(new Error('git error'));

    await expect(run()).rejects.toThrow('process.exit(1)');

    expect(mockRollbackInstance.rollback).toHaveBeenCalledOnce();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('calls rollback.rollback() and process.exit(1) when createSyncBranch throws', async () => {
    mockGitPublisherInstance.createSyncBranch.mockRejectedValue(new Error('branch error'));

    await expect(run()).rejects.toThrow('process.exit(1)');

    expect(mockRollbackInstance.rollback).toHaveBeenCalledOnce();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('calls rollback.rollback() and process.exit(1) when locateMarkdownSection throws', async () => {
    mockDetectDrift.mockResolvedValue([makeExportedFunction()]);
    mockLocateMarkdownSection.mockRejectedValue(new Error('filesystem error'));

    await expect(run()).rejects.toThrow('process.exit(1)');

    expect(mockRollbackInstance.rollback).toHaveBeenCalledOnce();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('calls rollback.rollback() and process.exit(1) when commitAndPush throws', async () => {
    mockGitPublisherInstance.commitAndPush.mockRejectedValue(new Error('push failed'));

    await expect(run()).rejects.toThrow('process.exit(1)');

    expect(mockRollbackInstance.rollback).toHaveBeenCalledOnce();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('calls rollback.rollback() and process.exit(1) when createPR throws', async () => {
    mockGitPublisherInstance.createPR.mockRejectedValue(new Error('GitHub API error'));

    await expect(run()).rejects.toThrow('process.exit(1)');

    expect(mockRollbackInstance.rollback).toHaveBeenCalledOnce();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('calls rollback.rollback() and process.exit(1) when regenerateMarkdownSection throws', async () => {
    mockDetectDrift.mockResolvedValue([makeExportedFunction({ changeType: 'modified' })]);
    mockLocateMarkdownSection.mockResolvedValue(makeStaleMdSection());
    mockCompareDrift.mockReturnValue('stale');
    mockReadFile.mockResolvedValue('existing markdown content');
    mockRegenerateMarkdownSection.mockImplementation(() => {
      throw new Error('regeneration error');
    });

    await expect(run()).rejects.toThrow('process.exit(1)');

    expect(mockRollbackInstance.rollback).toHaveBeenCalledOnce();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('calls rollback.rollback() and process.exit(1) when writeDraft throws', async () => {
    mockDetectDrift.mockResolvedValue([makeExportedFunction({ changeType: 'modified' })]);
    mockLocateConfluenceSection.mockResolvedValue(makeStaleConfluenceSection());
    mockCompareDrift.mockImplementation((_fn, section: { target: string }) => {
      if (section.target === 'confluence') return 'stale';
      return 'not-found';
    });
    mockConfluencePublisherInstance.writeDraft.mockRejectedValue(new Error('Confluence error'));

    await expect(run()).rejects.toThrow('process.exit(1)');

    expect(mockRollbackInstance.rollback).toHaveBeenCalledOnce();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

// ---------------------------------------------------------------------------
// 2. Success — PipelineResult JSON emitted to stdout with correct shape
// ---------------------------------------------------------------------------

describe('success — PipelineResult JSON emitted to stdout', () => {
  it('emits valid JSON with the correct PipelineResult shape when no functions drifted', async () => {
    // detectDrift returns empty array — no function processing loop iterations.
    mockDetectDrift.mockResolvedValue([]);

    await run();

    expect(consoleLogSpy).toHaveBeenCalledOnce();
    const output = consoleLogSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(output) as Record<string, unknown>;

    expect(parsed['triggerCommitSha']).toBe('test-merge-sha-abcdef1234567890');
    expect(parsed['regenerated']).toEqual([]);
    expect(parsed['scaffolded']).toEqual([]);
    expect(parsed['notFound']).toEqual([]);
    expect(parsed['confluenceDraftPageIds']).toEqual([]);
    expect(parsed['prUrl']).toBe('https://github.com/testowner/testrepo/pull/99');
    expect(parsed['skipped']).toBe(false);
  });

  it('uses mergeSha from TriggerContext as triggerCommitSha', async () => {
    mockValidateTrigger.mockResolvedValue({
      mergeSha: 'sha-from-trigger-context-xyz',
      baseSha: 'sha-from-trigger-context-xyz^1',
      changedFiles: [],
      owner: 'testowner',
      repo: 'testrepo',
    });

    await run();

    const parsed = JSON.parse(consoleLogSpy.mock.calls[0][0] as string) as Record<string, unknown>;
    expect(parsed['triggerCommitSha']).toBe('sha-from-trigger-context-xyz');
  });

  it('includes prUrl from GitPublisher.createPR in the result', async () => {
    mockGitPublisherInstance.createPR.mockResolvedValue(
      'https://github.com/testowner/testrepo/pull/42',
    );

    await run();

    const parsed = JSON.parse(consoleLogSpy.mock.calls[0][0] as string) as Record<string, unknown>;
    expect(parsed['prUrl']).toBe('https://github.com/testowner/testrepo/pull/42');
  });

  it('adds regenerated markdown entries when a stale markdown section is found', async () => {
    mockDetectDrift.mockResolvedValue([makeExportedFunction({ changeType: 'modified' })]);
    mockLocateMarkdownSection.mockResolvedValue(makeStaleMdSection());
    mockCompareDrift.mockImplementation((_fn, section: { target: string }) => {
      return section.target === 'markdown' ? 'stale' : 'not-found';
    });
    mockReadFile.mockResolvedValue('# Title\n\n## myFn\n\nOld docs.\n');
    mockRegenerateMarkdownSection.mockReturnValue('# Title\n\n## myFn\n\nNew docs.\n');

    await run();

    const parsed = JSON.parse(consoleLogSpy.mock.calls[0][0] as string) as {
      regenerated: Array<{ name: string; target: string; location: string }>;
    };
    expect(parsed.regenerated).toHaveLength(1);
    expect(parsed.regenerated[0]).toMatchObject({
      name: 'myFn',
      target: 'markdown',
      location: 'docs/api.md',
    });
  });

  it('adds notFound entries for modified functions with no docs', async () => {
    mockDetectDrift.mockResolvedValue([
      makeExportedFunction({ name: 'orphanFn', changeType: 'modified', sourceFilePath: 'src/utils.ts' }),
    ]);
    mockLocateMarkdownSection.mockResolvedValue({
      functionName: 'orphanFn',
      target: 'not-found',
      sectionContent: '',
    });
    mockLocateConfluenceSection.mockResolvedValue({
      functionName: 'orphanFn',
      target: 'not-found',
      sectionContent: '',
    });
    mockCompareDrift.mockReturnValue('not-found');

    await run();

    const parsed = JSON.parse(consoleLogSpy.mock.calls[0][0] as string) as {
      notFound: Array<{ name: string; sourceFilePath: string }>;
    };
    expect(parsed.notFound).toHaveLength(1);
    expect(parsed.notFound[0]).toMatchObject({
      name: 'orphanFn',
      sourceFilePath: 'src/utils.ts',
    });
  });

  it('adds scaffolded markdown entries for added functions with no docs', async () => {
    mockDetectDrift.mockResolvedValue([
      makeExportedFunction({ name: 'newFn', changeType: 'added', sourceFilePath: 'src/new.ts' }),
    ]);
    mockLocateMarkdownSection.mockResolvedValue({
      functionName: 'newFn',
      target: 'not-found',
      sectionContent: '',
    });
    mockLocateConfluenceSection.mockResolvedValue({
      functionName: 'newFn',
      target: 'not-found',
      sectionContent: '',
    });
    mockCompareDrift.mockReturnValue('not-found');
    mockResolveScaffoldTarget.mockReturnValue('docs/new.md');
    mockReadFile.mockResolvedValue('# New Module\n');

    await run();

    const parsed = JSON.parse(consoleLogSpy.mock.calls[0][0] as string) as {
      scaffolded: Array<{ name: string; target: string; location: string }>;
    };
    expect(parsed.scaffolded.some(s => s.name === 'newFn' && s.target === 'markdown')).toBe(true);
  });

  it('adds confluenceDraftPageIds when a Confluence section is regenerated', async () => {
    mockDetectDrift.mockResolvedValue([makeExportedFunction({ changeType: 'modified' })]);
    mockLocateMarkdownSection.mockResolvedValue({
      functionName: 'myFn',
      target: 'not-found',
      sectionContent: '',
    });
    mockLocateConfluenceSection.mockResolvedValue(makeStaleConfluenceSection());
    mockCompareDrift.mockImplementation((_fn, section: { target: string }) => {
      return section.target === 'confluence' ? 'stale' : 'not-found';
    });

    await run();

    const parsed = JSON.parse(consoleLogSpy.mock.calls[0][0] as string) as {
      confluenceDraftPageIds: string[];
      regenerated: Array<{ name: string; target: string }>;
    };
    expect(parsed.confluenceDraftPageIds).toContain('32833537');
    expect(parsed.regenerated.some(r => r.target === 'confluence')).toBe(true);
  });

  it('calls commitAndPush with affected function names and mergeSha', async () => {
    mockDetectDrift.mockResolvedValue([makeExportedFunction({ changeType: 'modified' })]);
    mockLocateMarkdownSection.mockResolvedValue(makeStaleMdSection());
    mockCompareDrift.mockImplementation((_fn, section: { target: string }) => {
      return section.target === 'markdown' ? 'stale' : 'not-found';
    });
    mockReadFile.mockResolvedValue('## myFn\n\nOld docs.\n');

    await run();

    expect(mockGitPublisherInstance.commitAndPush).toHaveBeenCalledWith(
      ['myFn'],
      'test-merge-sha-abcdef1234567890',
    );
  });

  it('calls createPR with the assembled PipelineResult', async () => {
    await run();

    expect(mockGitPublisherInstance.createPR).toHaveBeenCalledOnce();
    const passedResult = mockGitPublisherInstance.createPR.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(passedResult['triggerCommitSha']).toBeDefined();
    expect(Array.isArray(passedResult['regenerated'])).toBe(true);
    expect(Array.isArray(passedResult['scaffolded'])).toBe(true);
    expect(Array.isArray(passedResult['notFound'])).toBe(true);
    expect(Array.isArray(passedResult['confluenceDraftPageIds'])).toBe(true);
  });

  it('does not duplicate a function name in affectedFunctionNames for the same fn', async () => {
    // The same function has both stale markdown AND stale confluence.
    mockDetectDrift.mockResolvedValue([makeExportedFunction({ changeType: 'modified' })]);
    mockLocateMarkdownSection.mockResolvedValue(makeStaleMdSection());
    mockLocateConfluenceSection.mockResolvedValue(makeStaleConfluenceSection());
    mockCompareDrift.mockReturnValue('stale');
    mockReadFile.mockResolvedValue('## myFn\n\nOld docs.\n');

    await run();

    const callArgs = mockGitPublisherInstance.commitAndPush.mock.calls[0] as [
      string[],
      string,
    ];
    const fnNames = callArgs[0];
    // 'myFn' should appear exactly once even though it was affected via both paths.
    expect(fnNames.filter(n => n === 'myFn')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 3. Secrets redaction — stdout/stderr strings pass through redactSecrets
// ---------------------------------------------------------------------------

describe('secrets redaction', () => {
  it('redacts a GitHub PAT pattern from the error JSON written to stderr', async () => {
    // Inject a known GitHub PAT pattern into a simulated error message.
    const secretToken = 'ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    mockDetectDrift.mockRejectedValue(
      new Error(`Downstream error: token=${secretToken} access denied`),
    );

    // Restore console.error so we can capture its real calls.
    consoleErrorSpy.mockRestore();
    const capturedErrors: string[] = [];
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      capturedErrors.push(args.map(String).join(' '));
    });

    await expect(run()).rejects.toThrow('process.exit(1)');

    const allErrorOutput = capturedErrors.join('\n');
    // The raw secret must NOT appear in any error output.
    expect(allErrorOutput).not.toContain(secretToken);
    // The redaction placeholder MUST appear instead.
    expect(allErrorOutput).toContain('[REDACTED]');
  });

  it('redacts a Confluence API token pattern (ATATT) from error output', async () => {
    const secretToken = 'ATATTxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890abcd';
    mockGitPublisherInstance.createPR.mockRejectedValue(
      new Error(`Confluence auth failed: ${secretToken}`),
    );

    consoleErrorSpy.mockRestore();
    const capturedErrors: string[] = [];
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      capturedErrors.push(args.map(String).join(' '));
    });

    await expect(run()).rejects.toThrow('process.exit(1)');

    const allOutput = capturedErrors.join('\n');
    expect(allOutput).not.toContain(secretToken);
    expect(allOutput).toContain('[REDACTED]');
  });

  it('emits clean (non-secret) PipelineResult JSON to stdout without modification', async () => {
    // No secrets in the result; redactSecrets should leave it unchanged.
    mockGitPublisherInstance.createPR.mockResolvedValue(
      'https://github.com/testowner/testrepo/pull/1',
    );

    await run();

    expect(consoleLogSpy).toHaveBeenCalledOnce();
    const output = consoleLogSpy.mock.calls[0][0] as string;
    // Verify the output is valid JSON with no truncation from accidental redaction.
    const parsed = JSON.parse(output) as Record<string, unknown>;
    expect(parsed['prUrl']).toBe('https://github.com/testowner/testrepo/pull/1');
  });
});

// ---------------------------------------------------------------------------
// 4. Idempotency skip — process.exit(0) from TriggerValidator → no rollback
// ---------------------------------------------------------------------------

describe('idempotency skip', () => {
  it('does not call rollback.rollback() when validateTrigger calls process.exit(0)', async () => {
    // Simulate validateTrigger calling process.exit(0), which in tests throws.
    mockValidateTrigger.mockImplementation(() => {
      // In production this terminates the process. In tests the spy throws.
      process.exit(0);
    });

    // run() should resolve cleanly (the catch block detects exit(0) and returns).
    await run();

    expect(mockRollbackInstance.rollback).not.toHaveBeenCalled();
  });

  it('does not call process.exit(1) when the skip is from exit(0)', async () => {
    mockValidateTrigger.mockImplementation(() => {
      process.exit(0);
    });

    await run();

    expect(exitSpy).not.toHaveBeenCalledWith(1);
    // exit(0) WAS called (by the mock validator), but NOT exit(1).
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('does not emit any PipelineResult JSON to stdout on idempotency skip', async () => {
    mockValidateTrigger.mockImplementation(() => {
      process.exit(0);
    });

    await run();

    // console.log should NOT have been called with PipelineResult JSON.
    const pipelineResultCalls = consoleLogSpy.mock.calls.filter(args => {
      try {
        const parsed = JSON.parse(args[0] as string) as Record<string, unknown>;
        return 'triggerCommitSha' in parsed;
      } catch {
        return false;
      }
    });
    expect(pipelineResultCalls).toHaveLength(0);
  });

  it('does not call detectDrift or any other step after the skip', async () => {
    mockValidateTrigger.mockImplementation(() => {
      process.exit(0);
    });

    await run();

    expect(mockDetectDrift).not.toHaveBeenCalled();
    expect(mockGitPublisherInstance.createSyncBranch).not.toHaveBeenCalled();
    expect(mockGitPublisherInstance.commitAndPush).not.toHaveBeenCalled();
    expect(mockGitPublisherInstance.createPR).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 5. Pipeline sequencing — correct call order
// ---------------------------------------------------------------------------

describe('pipeline sequencing', () => {
  it('calls validateTrigger before detectDrift', async () => {
    const order: string[] = [];
    mockValidateTrigger.mockImplementation(async () => {
      order.push('validateTrigger');
      return {
        mergeSha: 'sha-order-test',
        baseSha: 'sha-order-test^1',
        changedFiles: [],
        owner: 'testowner',
        repo: 'testrepo',
      };
    });
    mockDetectDrift.mockImplementation(async () => {
      order.push('detectDrift');
      return [];
    });

    await run();

    expect(order.indexOf('validateTrigger')).toBeLessThan(order.indexOf('detectDrift'));
  });

  it('calls createSyncBranch before any writeDocFile call', async () => {
    const order: string[] = [];
    mockGitPublisherInstance.createSyncBranch.mockImplementation(async () => {
      order.push('createSyncBranch');
    });
    mockDetectDrift.mockResolvedValue([makeExportedFunction({ changeType: 'modified' })]);
    mockLocateMarkdownSection.mockResolvedValue(makeStaleMdSection());
    mockCompareDrift.mockImplementation((_fn, section: { target: string }) =>
      section.target === 'markdown' ? 'stale' : 'not-found',
    );
    mockReadFile.mockResolvedValue('## myFn\n\nOld docs.\n');
    mockGitPublisherInstance.writeDocFile.mockImplementation(async () => {
      order.push('writeDocFile');
    });

    await run();

    expect(order.indexOf('createSyncBranch')).toBeLessThan(order.indexOf('writeDocFile'));
  });

  it('calls commitAndPush before createPR', async () => {
    const order: string[] = [];
    mockGitPublisherInstance.commitAndPush.mockImplementation(async () => {
      order.push('commitAndPush');
    });
    mockGitPublisherInstance.createPR.mockImplementation(async () => {
      order.push('createPR');
      return 'https://github.com/testowner/testrepo/pull/1';
    });

    await run();

    expect(order.indexOf('commitAndPush')).toBeLessThan(order.indexOf('createPR'));
  });

  it('passes changedFiles and mergeSha to detectDrift', async () => {
    mockValidateTrigger.mockResolvedValue({
      mergeSha: 'detect-drift-sha',
      baseSha: 'detect-drift-sha^1',
      changedFiles: ['src/utils.ts', 'src/index.ts'],
      owner: 'testowner',
      repo: 'testrepo',
    });

    await run();

    expect(mockDetectDrift).toHaveBeenCalledWith(
      ['src/utils.ts', 'src/index.ts'],
      'detect-drift-sha',
    );
  });
});
