# Implementation Plan: Automated Documentation Sync Pipeline

**Phase:** 4 — Implementation Plan
**Date:** 2026-08-20
**Status:** Draft — awaiting human approval before implementation begins

Source artifacts:
- `docs/requirements.md` (Phase 1, approved)
- `docs/architecture.md` (Phase 2, revised and approved with conditions)
- `docs/design-review.md` (Phase 3, APPROVED WITH CONDITIONS 2026-08-20)

---

## Approval Conditions Carried Forward

The following conditions from the design review must be satisfied at the specific
tasks called out below. No PR that touches the relevant module may merge until
its condition is met.

| Condition | Trigger | Required Before |
|---|---|---|
| **W-1** | Confluence draft-API version semantics must be verified against the target Confluence Cloud instance; rollback undo closure must use the correct version number or a dedicated discard-draft call; A-7 in `docs/architecture.md` must be updated with verified behavior | Merging any PR that touches `ConfluencePublisher` (T-11) |
| **W-2** | `ConfluencePublish` must cross-reference each parsed page ID from the `doc-sync-meta` block against the configured allowlist (`docs/confluence-map.json` / `CONFLUENCE_PAGE_ID`) before issuing any PUT; IDs not on the allowlist must be logged and skipped | Merging any PR that touches `ConfluencePublish` (T-14) |
| **R-4** | A real Confluence page storage-format fixture must be checked into `test/fixtures/confluence/` and the heading-extraction unit test must pass against it | Before the implementation phase closes (latest: before T-18 E2E tests merge) |

---

## Dependency Graph Summary

```
T-01 (scaffolding)
  └─ T-02 (types)
       ├─ T-03 (redactSecrets)
       ├─ T-04 (RollbackManager)      ← also needs T-03
       ├─ T-05 (DriftComparator)
       ├─ T-06 (SectionRegenerator)
       ├─ T-07 (DriftDetector)
       └─ T-08 (DocLocator Markdown)
            └─ T-10 (DocLocator Confluence) ← also needs T-09
                 └─ T-11 (ConfluencePublisher) ← also needs T-03, T-04 [W-1]
                      └─ T-13 (TriggerValidator) ← also needs T-03, T-04
                           └─ T-15 (PipelineOrchestrator) ← needs all modules
                                └─ T-16 (doc-sync.yml)
T-09 (Confluence fixture) [BLOCKED]
T-12 (GitPublisher) ← needs T-03, T-04, T-06, T-08
     └─ T-15 (also needs T-12)
T-14 (ConfluencePublish) ← needs T-11 [W-2]
     └─ T-17 (doc-sync-publish.yml)
T-18 (E2E tests) ← needs T-15, T-14, T-16, T-17
```

---

## Task List

---

### T-01 — Project scaffolding and toolchain configuration

**Depends on:** none

**Scope — files to create:**
- `package.json` — all runtime and dev dependencies at pinned major versions:
  TypeScript 5.x, ts-morph 22.x, remark 15.x / unified 11.x, @octokit/rest 20.x,
  simple-git 3.x, axios 1.x, glob 10.x, eslint-plugin-jsdoc 50.x, Vitest 2.x,
  Playwright 1.x; scripts: `build`, `test`, `test:e2e`, `lint`
- `tsconfig.json` — strict mode, target ES2022, moduleResolution node16, outDir dist/
- `.eslintrc.json` — eslint-plugin-jsdoc with `require-jsdoc` rule enabled for all
  exported functions in `src/**/*.ts` (F-11, NFR-4)
- `vitest.config.ts`
- `playwright.config.ts`
- `.gitignore`
- Empty directory stubs: `src/`, `src/utils/`, `src/drift-detector/`,
  `src/doc-locator/`, `src/regenerator/`, `src/confluence-publisher/`,
  `src/git-publisher/`, `test/unit/`, `test/e2e/`, `test/fixtures/typescript/`,
  `test/fixtures/docs/`, `test/fixtures/confluence/`
- `docs/confluence-map.json` — empty JSON object `{}` as a placeholder; real
  entries added in T-10

**Acceptance criteria:**
- `npm install` completes without errors on Node.js 20 LTS
- `npm run build` succeeds against an empty `src/` (or a minimal placeholder)
- `npm run lint` passes with no errors
- `npm test` exits 0 with "no test files found" (Vitest zero-test pass)

**Approval conditions to satisfy:** none

---

### T-02 — Shared type definitions

**Depends on:** T-01

**Scope — files to create:**
- `src/types.ts` — exports the five cross-component interfaces and types exactly
  as specified in architecture §7:
  `ExportedFunction`, `DocSection`, `ComparisonResult`, `RollbackEntry`,
  `PipelineResult`; every exported symbol carries a JSDoc comment (NFR-4)

**Acceptance criteria:**
- `npm run build` succeeds with no TypeScript errors
- `npm run lint` passes (eslint-plugin-jsdoc reports no missing JSDoc violations)
- All five types are exported and importable from a sibling module
- No circular imports (verified by TypeScript compiler)

**Approval conditions to satisfy:** none

---

### T-03 — redactSecrets utility

**Depends on:** T-01, T-02

**Scope — files to create:**
- `src/utils/redact-secrets.ts` — exports `redactSecrets(text: string): string`;
  applies all six regex patterns from architecture §8.5:
  `ghp_[A-Za-z0-9]{36,}`, `ghs_[A-Za-z0-9]{36,}`,
  `github_pat_[A-Za-z0-9_]{36,}`, `ATATT[A-Za-z0-9+/=_-]{20,}`,
  `Bearer\s+[A-Za-z0-9._\-]{20,}`, generic Base64 blob ≥ 40 chars;
  each match replaced with `[REDACTED]`
- `test/unit/redact-secrets.test.ts`

**Acceptance criteria:**
- Each of the six named pattern families is independently tested and redacted
- A string containing multiple distinct secret patterns has all of them redacted
- A string containing no secrets is returned byte-for-byte unchanged
- `npm test` passes

**Approval conditions to satisfy:** none

---

### T-04 — RollbackManager

**Depends on:** T-01, T-02

**Scope — files to create:**
- `src/rollback-manager.ts` — exports `RollbackManager` class with `register(entry:
  RollbackEntry): void` and `rollback(): Promise<void>`; `rollback()` iterates the
  internal stack in LIFO order; a failing undo is caught, logged (via `console.error`),
  and skipped without aborting remaining undos (NFR-3); the class carries a JSDoc
  comment on every exported member (NFR-4)
- `test/unit/rollback-manager.test.ts`

**Acceptance criteria:**
- Undo closures execute in strict LIFO order (verified with sequenced counter array)
- A failing undo at position N does not prevent undos at positions N-1 … 0 from running
- Test verifies the register-then-mutate pattern: registers undo, simulates mid-write
  failure, asserts undo fires exactly once
- `npm test` passes

**Approval conditions to satisfy:** none

---

### T-05 — DriftComparator

**Depends on:** T-01, T-02

**Scope — files to create:**
- `src/drift-comparator.ts` — exports
  `compareDrift(fn: ExportedFunction, section: DocSection): ComparisonResult`;
  renders the expected canonical section form (heading + TypeScript fenced code block
  + stripped JSDoc body) as a plain string and compares it to the normalised
  `section.sectionContent`; returns `'stale'`, `'current'`, or `'not-found'`
  (NFR-4: JSDoc on every export)
- `test/unit/drift-comparator.test.ts`

**Acceptance criteria:**
- Returns `'not-found'` when `section.target === 'not-found'`
- Returns `'current'` when section content matches the canonical rendering of the
  function (whitespace-normalised)
- Returns `'stale'` when signature or JSDoc differs
- Table-driven test covers all three outcomes; `npm test` passes

**Approval conditions to satisfy:** none

---

### T-06 — SectionRegenerator

**Depends on:** T-01, T-02

**Scope — files to create:**
- `src/regenerator/index.ts` — exports:
  - `regenerateMarkdownSection(rawFile: string, section: DocSection, fn: ExportedFunction): string`
    — uses remark only to read `section.sectionStartOffset` / `section.sectionEndOffset`,
    performs `rawFile.slice(0, sectionStart) + newSectionString + rawFile.slice(sectionEnd)`;
    `remark-stringify` is never imported or called (F-3)
  - `regenerateConfluenceSection(rawXhtml: string, section: DocSection, fn: ExportedFunction): string`
    — character-offset splice on raw XHTML string; no XHTML re-serializer invoked
  - `buildScaffoldSection(fn: ExportedFunction): string`
    — returns heading + TS fenced code block + JSDoc body for newly added functions (FR-11)
  - JSDoc on every exported function (NFR-4)
- `test/unit/regenerator.test.ts`

**Acceptance criteria:**
- `rawFile.slice(0, sectionStart)` in the returned string is byte-for-byte identical
  to the original prefix (AC-3)
- `rawFile.slice(sectionEnd)` in the returned string is byte-for-byte identical to the
  original suffix (AC-3)
- `remark-stringify` is not imported anywhere in `src/regenerator/` (statically verifiable)
- `buildScaffoldSection` output matches the template from architecture §4 Step 6
  (heading, TypeScript fence, JSDoc body)
- `npm test` passes

**Approval conditions to satisfy:** none

---

### T-07 — DriftDetector

**Depends on:** T-01, T-02

**Scope — files to create:**
- `src/drift-detector/index.ts` — exports
  `detectDrift(changedFilePaths: string[], sha: string): Promise<ExportedFunction[]>`;
  runs `git diff GITHUB_SHA^1 GITHUB_SHA --name-only -- 'src/**/*.ts'` via
  `simple-git` (F-4); for each changed file fetches base version via
  `git show GITHUB_SHA^1:<file>`, reads head version from disk; creates two
  in-memory `ts-morph` SourceFile objects; extracts exported functions; deduplicates
  overloads by name — last declaration (implementation signature) is canonical,
  overload-only signatures discarded (F-9); classifies each as `added` or
  `modified`; ignores unchanged functions (FR-2)
- `test/unit/drift-detector.test.ts`
- `test/fixtures/typescript/` — a small set of `.ts` fixture strings used by tests
  (overloaded function, plain function, new function)

**Acceptance criteria:**
- Function present only in head → `changeType: 'added'`
- Function present in both with differing signature/JSDoc → `changeType: 'modified'`
- Function identical in both → not returned
- Three overload declarations of the same name → one `ExportedFunction` entry whose
  `signature` field holds only the implementation signature (last declaration)
- `simple-git` call uses `GITHUB_SHA^1 GITHUB_SHA` (verifiable by mocking simple-git)
- `npm test` passes

**Approval conditions to satisfy:** none

---

### T-08 — DocLocator — Markdown path

**Depends on:** T-01, T-02

**Scope — files to create:**
- `src/doc-locator/index.ts` — Markdown path only (Confluence path added in T-10);
  exports `locateMarkdownSection(functionName: string, docsGlob: string): Promise<DocSection>`;
  iterates `docs/*.md` via `glob`, parses each with `remark` into an mdast, finds
  heading nodes whose text value exactly equals `functionName`, returns `DocSection`
  with `markdownFilePath`, `sectionStartOffset`, `sectionEndOffset`, and
  `sectionContent`; returns `DocSection` with `target: 'not-found'` when no match
  found; no serialization of file content (F-3); scaffolding target heuristic from
  architecture §5.4 (src/\<dir>/\<base>.ts → docs/\<base>.md, fallback to
  `DOCS_DEFAULT_FILE`) implemented in this task
- `test/unit/doc-locator-markdown.test.ts`
- `test/fixtures/docs/` — fixture Markdown files with known headings and offsets

**Acceptance criteria:**
- Returns correct `sectionStartOffset` and `sectionEndOffset` for a function name
  that matches an `##`-level heading in a fixture `.md` file
- Returns `target: 'not-found'` for a function name with no matching heading
- Searches across multiple `docs/*.md` files and returns the first match
- Scaffolding heuristic resolves target file: `src/foo/bar.ts` → `docs/bar.md`;
  falls back to `DOCS_DEFAULT_FILE` when neither derived path exists
- `npm test` passes

**Approval conditions to satisfy:** none

---

### T-09 — Confluence storage-format fixture

**Depends on:** T-01

**BLOCKED — explicit external condition:**
This task cannot begin until a real Confluence Cloud API token (`CONFLUENCE_API_TOKEN`),
base URL (`CONFLUENCE_BASE_URL`), and the confirmed page ID (`CONFLUENCE_PAGE_ID=32833537`)
are available to the implementer. The fixture cannot be fabricated; it must be exported
from the actual target Confluence instance to ensure the heading-extraction logic is
validated against real storage-format XHTML.

**Scope — files to create:**
- `test/fixtures/confluence/page-32833537-body.html` — raw XHTML storage-format body
  exported from the real Confluence page (`GET /wiki/api/v2/pages/32833537?body-format=storage`)
  with at least one `<h2>` (or configured heading-level) element whose text content
  exactly matches a known function name
- `test/fixtures/confluence/fixture-meta.json` — records the page ID, heading level,
  and the expected function names parseable from the fixture, so tests can assert
  against known values without hard-coding them in test source

**Acceptance criteria (R-4):**
- `test/fixtures/confluence/page-32833537-body.html` exists and is non-empty
- `fixture-meta.json` records ≥ 1 expected function name present in the fixture
- A unit test (`test/unit/confluence-heading-extraction.test.ts`, created in T-10)
  parses the fixture and finds every function name listed in `fixture-meta.json`
  without throwing
- Heading extraction finds ≥ 1 heading matching the expected value

**Approval conditions to satisfy:** R-4 (this task is the resolution of R-4)

---

### T-10 — DocLocator — Confluence path

**Depends on:** T-08, T-09

**Blocked until:** T-09 fixture file exists and the heading-extraction test described
there passes. This PR must not merge until the fixture-based test is included and green.

**Scope — files to modify/create:**
- `src/doc-locator/index.ts` — add Confluence path: exports
  `locateConfluenceSection(functionName: string, sourceFilePath: string): Promise<DocSection>`;
  resolves page ID from `CONFLUENCE_PAGE_ID` env var or from `docs/confluence-map.json`
  keyed on `sourceFilePath`; if neither is configured, returns `target: 'not-found'`
  (no error); fetches page body via
  `GET /wiki/api/v2/pages/{id}?body-format=storage` using axios with
  `CONFLUENCE_REQUEST_TIMEOUT_MS` timeout; searches returned XHTML for heading
  elements at level `CONFLUENCE_HEADING_LEVEL` (default `h2`) whose text content
  exactly equals `functionName`; returns `DocSection` with `confluencePageId`,
  `confluenceVersionNumber`, `sectionContent`; heading level configurable per A-2 (F-2)
- `docs/confluence-map.json` — populated with the confirmed mapping
  `{ "src/<file>.ts": "32833537" }` as a real entry (A-4); format documented
  inline via a leading `_comment` key
- `test/unit/doc-locator-confluence.test.ts` — includes both mock-axios tests AND
  the fixture-file-based test against `test/fixtures/confluence/page-32833537-body.html`

**Acceptance criteria:**
- Returns correct `DocSection` with heading-matched `sectionContent` when page ID
  is configured and heading is found in mocked page body
- Returns `target: 'not-found'` when no heading text matches `functionName`
- `CONFLUENCE_HEADING_LEVEL=h3` makes the locator search `<h3>` elements instead
- Fixture-based test: parses `test/fixtures/confluence/page-32833537-body.html` with
  no axios mock and finds all function names listed in `fixture-meta.json` (R-4)
- `npm test` passes

**Approval conditions to satisfy:** R-4 (fixture-based test must be green before this PR merges)

---

### T-11 — ConfluencePublisher

**Depends on:** T-03, T-04, T-10

**BLOCKED before merging (W-1):**
Before this PR may be merged, the implementer must verify empirically against the
target Confluence Cloud instance whether (a) a `PUT status: "draft"` increments the
published version number or creates a separate unpublished revision, and (b) what
version number the rollback `PUT` must send to successfully discard the draft without
a 409 Conflict. The verified behavior must be recorded in assumption A-7 in
`docs/architecture.md` and the rollback undo closure in this module must reflect it.
If the draft API is unavailable, fall back to the file-patch approach (Option A from
design review F-1) and update the rollback accordingly.

**Scope — files to create:**
- `src/confluence-publisher/index.ts` — exports `ConfluencePublisher` class with:
  - `fetchPage(pageId: string): Promise<{ body: string; version: number }>` — GET with
    `body-format=storage`; applies `CONFLUENCE_REQUEST_TIMEOUT_MS` (default 30 000 ms)
  - `writeDraft(pageId: string, updatedHtml: string, currentVersion: number, rollback: RollbackManager): Promise<void>`
    — registers undo on `RollbackManager` BEFORE issuing PUT (register-then-mutate
    invariant, F-6); PUT body has `status: "draft"`, `version.number: currentVersion + 1`;
    published page remains unchanged during review (F-1)
  - `revertToPublished(pageId: string, originalBody: string, rollbackVersion: number): Promise<void>`
    — PUT with `status: "current"` and the version number determined in W-1 verification
  - `CONFLUENCE_API_TOKEN` read from env, applied via axios interceptor, never logged (NFR-2)
  - All exported members carry JSDoc (NFR-4)
- `test/unit/confluence-publisher.test.ts`

**Acceptance criteria:**
- `writeDraft` PUT body always contains `status: "draft"` (never `"current"`)
- `RollbackManager.register()` is called before the axios PUT call in `writeDraft`
  (verifiable by asserting undo is registered even when PUT throws synchronously)
- Rollback undo uses the version number verified per W-1 (not blindly `currentVersion`)
- `CONFLUENCE_API_TOKEN` does not appear in any string written to stdout
  (redactSecrets applied to all log output in this module)
- `npm test` passes

**Approval conditions to satisfy:** W-1 (must be verified and A-7 updated before merge)

---

### T-12 — GitPublisher

**Depends on:** T-03, T-04, T-06, T-08

**Scope — files to create:**
- `src/git-publisher/index.ts` — exports `GitPublisher` class with:
  - `createSyncBranch(timestamp: string, rollback: RollbackManager): Promise<void>`
    — registers branch-deletion undo BEFORE `git checkout -b docs/sync-<timestamp>`;
    also registers remote-branch-deletion undo before push (F-6)
  - `writeDocFile(filePath: string, content: string, rollback: RollbackManager): Promise<void>`
    — registers `git checkout HEAD -- <file>` undo BEFORE writing the file; per-file
    in a loop, not batched (F-6, F-8)
  - `createDefaultDocFile(filePath: string, rollback: RollbackManager): Promise<void>`
    — checks `fs.existsSync` first; registers `fs.unlink` undo BEFORE creating the
    file if it was absent (F-8)
  - `commitAndPush(affectedFunctions: string[], triggerSha: string): Promise<void>`
    — `git add docs/`, commit with `docs: sync documentation for <fns>` message,
    push to origin
  - `createPR(result: PipelineResult): Promise<string>` — calls `POST /repos/{owner}/
    {repo}/pulls`; body contains: `Triggered-by: <sha>`, regenerated/scaffolded lists,
    Known Limitations, `<!-- doc-sync-meta: ... -->` block; no `reviewers` field (FR-6);
    applies `GITHUB_REQUEST_TIMEOUT_MS` (default 30 000 ms)
  - All exported members carry JSDoc (NFR-4)
- `test/unit/git-publisher.test.ts` — mocks `simple-git` and `@octokit/rest`

**Acceptance criteria:**
- Branch name matches `docs/sync-<UTC-ISO-timestamp>` (e.g., `docs/sync-20260820T143000Z`)
- `RollbackManager.register()` is called before each of: branch creation, push,
  every individual file write, new-file creation (verifiable by asserting undo count
  equals mutation count in a spy-based test)
- PR description includes `Triggered-by: <sha>` (NFR-6), function lists, Known
  Limitations section, and well-formed `<!-- doc-sync-meta: {...} -->` block
- No `reviewers` field present in the Octokit PR creation call payload
- `npm test` passes

**Approval conditions to satisfy:** none

---

### T-13 — TriggerValidator

**Depends on:** T-03, T-04, T-11

**Scope — files to create:**
- `src/trigger-validator.ts` — exports
  `validateTrigger(rollback: RollbackManager): Promise<TriggerContext>` where
  `TriggerContext` contains `{ mergeSha, baseSha, changedFiles }`;
  performs in order:
  1. Reads `GITHUB_EVENT_PATH`; verifies `github.event.pull_request.merged === true`;
     exits non-zero with structured log if not a merged PR (FR-1)
  2. Idempotency check (FR-10, F-5): paginates open PRs via
     `GET /repos/{owner}/{repo}/pulls?state=open&per_page=100`; filters client-side
     to `head.ref` starting with `docs/sync-`; inspects only that subset for body
     containing `Triggered-by: <GITHUB_SHA>`; if found, logs skip message and
     `process.exit(0)`
  3. Branch-protection pre-check (R-5): calls
     `GET /repos/{owner}/{repo}/branches/docs%2Fsync-test/protection`;
     if `docs/*` branches are protected, logs warning and exits non-zero before
     any mutation
  4. Pre-flight Confluence parse validation (Step 2a, F-7): calls
     `ConfluencePublisher.fetchPage(CONFLUENCE_PAGE_ID)`; counts heading elements
     at `CONFLUENCE_HEADING_LEVEL`; if page body is non-empty and count is zero,
     emits structured error `CONFLUENCE_PARSE_VALIDATION_FAILED` and
     `process.exit(1)` before any mutation occurs
  - All exported members carry JSDoc (NFR-4)
- `test/unit/trigger-validator.test.ts`

**Acceptance criteria:**
- Non-merged PR event → structured error log, non-zero exit
- Existing `docs/sync-*` PR found with matching SHA → log "skipping", `process.exit(0)`
  without calling any downstream module
- Confluence page with zero headings in non-empty body →
  `CONFLUENCE_PARSE_VALIDATION_FAILED` structured log, non-zero exit, no mutation
- Confluence page with ≥ 1 heading → validation passes, returns `TriggerContext`
- `npm test` passes

**Approval conditions to satisfy:** none (depends on T-11 which carries W-1)

---

### T-14 — ConfluencePublish (Workflow 2 entry point)

**Depends on:** T-11, T-03

**BLOCKED before merging (W-2):**
Before this PR may be merged, the allowlist check must be present and tested:
after parsing `confluenceDrafts` from the `doc-sync-meta` block, each page ID
must be cross-referenced against `docs/confluence-map.json` keys and
`CONFLUENCE_PAGE_ID` env var. Any ID not present in the allowlist must be logged
with a structured warning and skipped. No `PUT status: "current"` may be issued
for an unlisted ID.

**Scope — files to create:**
- `src/confluence-publish.ts` — entry point for Workflow 2; reads merged PR body
  via `GET /repos/{owner}/{repo}/pulls/{pull_number}` using Octokit; extracts
  `<!-- doc-sync-meta: {...} -->` block via regex; parses `confluenceDrafts` array;
  cross-references each ID against allowlist (W-2); for each allowlisted ID:
  calls `GET /wiki/api/v2/pages/{id}` to verify `status === "draft"` before
  proceeding; issues `PUT /wiki/api/v2/pages/{id}` with `status: "current"` to
  publish; logs structured result for each page; no rollback registered (human
  approved by merging PR, per NFR-7); all exported members carry JSDoc (NFR-4)
- `test/unit/confluence-publish.test.ts`

**Acceptance criteria:**
- Page ID present in allowlist and in `draft` status → `PUT status: "current"` issued
- Page ID NOT in allowlist → structured warning logged, PUT skipped (W-2)
- Page ID in allowlist but not in `draft` status → skipped with informational log
- Malformed `doc-sync-meta` block → structured error log, non-zero exit
- `npm test` passes

**Approval conditions to satisfy:** W-2 (allowlist check must be present and green before merge)

---

### T-15 — PipelineOrchestrator

**Depends on:** T-03, T-04, T-05, T-06, T-07, T-08, T-10, T-11, T-12, T-13

**Scope — files to create:**
- `src/pipeline.ts` — entry point for Workflow 1; exports `run(): Promise<void>`;
  sequences all components in the order defined in architecture §4:
  `TriggerValidator` → `DriftDetector` → `DocLocator` → `DriftComparator`
  → `SectionRegenerator` → `ConfluencePublisher` → `GitPublisher`;
  owns the single outer `try/catch`; on any error calls
  `RollbackManager.rollback()` then re-throws; applies `redactSecrets` to every
  string written to `process.stdout` including structured JSON error fields (F-12);
  emits `PipelineResult` as structured JSON on success; exits non-zero on failure
  (NFR-3); all exported members carry JSDoc (NFR-4)
- `test/unit/pipeline.test.ts` — orchestration tests with all sub-modules mocked

**Acceptance criteria:**
- On simulated sub-module error at step N, `RollbackManager.rollback()` is called
  and process exits with code 1
- On success, `PipelineResult` JSON is emitted to stdout containing `triggerCommitSha`,
  `regenerated`, `scaffolded`, `notFound`, `confluenceDraftPageIds`, `prUrl`
- All stdout strings are passed through `redactSecrets` (verified by injecting a
  mock secret into a simulated error response and asserting `[REDACTED]` in output)
- On idempotency skip (TriggerValidator returns early), `RollbackManager.rollback()`
  is NOT called and process exits 0
- `npm test` passes

**Approval conditions to satisfy:** none (all blocking conditions addressed in T-11, T-14)

---

### T-16 — GitHub Actions workflow: doc-sync.yml

**Depends on:** T-15

**Scope — files to create:**
- `.github/workflows/doc-sync.yml` — Workflow 1; triggers on `pull_request` event
  with activity type `closed` and guard `if: github.event.pull_request.merged == true`;
  declares:
  - `timeout-minutes: 5` on the job (F-10, NFR-1)
  - `fetch-depth: 0` in the `actions/checkout` step (F-4, required for `GITHUB_SHA^1`)
  - `node-version: '20'` in the `actions/setup-node` step
  - permissions block: `contents: write`, `pull-requests: write` (A-3)
  - env vars: `GITHUB_TOKEN`, `CONFLUENCE_BASE_URL`, `CONFLUENCE_API_TOKEN`,
    `CONFLUENCE_PAGE_ID`, `CONFLUENCE_REQUEST_TIMEOUT_MS`, `GITHUB_REQUEST_TIMEOUT_MS`
    sourced from GitHub Actions secrets (NFR-2 — no secrets in workflow YAML values)
  - run step: `npm ci && npm run build && node dist/pipeline.js`

**Acceptance criteria:**
- YAML syntax is valid (parseable by `js-yaml` or `yq`)
- `on.pull_request.types` includes `closed` and `if` guard for `merged == true` is present
- `fetch-depth: 0` present in the checkout step
- `timeout-minutes: 5` present on the job
- `contents: write` and `pull-requests: write` present in permissions block
- No secret values appear inline (all use `${{ secrets.* }}` references)

**Approval conditions to satisfy:** none

---

### T-17 — GitHub Actions workflow: doc-sync-publish.yml

**Depends on:** T-14

**Scope — files to create:**
- `.github/workflows/doc-sync-publish.yml` — Workflow 2; triggers on `pull_request`
  event with activity type `closed`, guard `if: github.event.pull_request.merged == true`,
  and a branch filter matching `docs/sync-*`; declares:
  - `node-version: '20'` in setup-node step
  - env vars: `GITHUB_TOKEN`, `CONFLUENCE_BASE_URL`, `CONFLUENCE_API_TOKEN`,
    `CONFLUENCE_PAGE_ID` sourced from secrets
  - run step: `npm ci && npm run build && node dist/confluence-publish.js`
  - No `timeout-minutes` is strictly required (publish is idempotent on partial
    failure), but a 10-minute guard is added as a safeguard

**Acceptance criteria:**
- YAML syntax is valid
- Branch filter limits trigger to `docs/sync-*` branches only
- `if: github.event.pull_request.merged == true` guard is present
- No secret values appear inline (all use `${{ secrets.* }}` references)
- `node dist/confluence-publish.js` (not `dist/pipeline.js`) is the run command

**Approval conditions to satisfy:** none

---

### T-18 — End-to-end test suite

**Depends on:** T-15, T-14, T-16, T-17

**Blocked until:** T-09 is complete (R-4 fixture must exist before e2e tests close
the implementation phase)

**Scope — files to create:**
- `test/e2e/` — Playwright APIRequestContext-based tests using `msw` (or
  `@mswjs/interceptors`) to mock GitHub REST API and Confluence REST API v2;
  controlled via `MOCK_API_MODE=true` env var; no real external API calls
- One spec file per scenario listed below (10 total scenarios from architecture §9.2):

| Spec file | Scenario | ACs covered |
|---|---|---|
| `happy-path-markdown.spec.ts` | Single modified function, heading in `docs/*.md` | AC-1, AC-2, AC-3, AC-4 |
| `happy-path-confluence.spec.ts` | Single modified function, heading in Confluence, draft written | AC-2, AC-3, AC-4 |
| `confluence-publish.spec.ts` | Workflow 2 publishes draft on PR merge | NFR-7, F-1 |
| `preflight-fail.spec.ts` | Pre-flight validation: zero headings in Confluence page | F-7 |
| `scaffold-new-function.spec.ts` | New exported function scaffolded into `docs/api.md` | AC-9 |
| `not-found.spec.ts` | Modified function with no heading, listed as Not Found | AC-5 |
| `idempotency.spec.ts` | Duplicate pipeline run for same SHA exits 0, no second PR | AC-6 |
| `rollback-github.spec.ts` | GitHub API unreachable mid-run; branch and files rolled back | AC-8 |
| `rollback-confluence.spec.ts` | Confluence API fails after draft written; draft reverted | AC-8 |
| `overloads.spec.ts` | TypeScript function with overloads → single ExportedFunction | F-9 |

**Acceptance criteria:**
- All 10 spec files pass under `npm run test:e2e` with `MOCK_API_MODE=true`
- No spec file calls a real GitHub or Confluence endpoint (enforced by msw
  handler that throws on unmatched requests)
- Rollback specs assert the final state: branch deleted, files restored,
  Confluence draft reverted (or absence of draft on mock server state)
- `npm run test:e2e` exits 0

**Approval conditions to satisfy:** R-4 must be complete (T-09) before this task closes

---

## Summary Table

| Task | Title | Depends On | Blocked Until | W/R Condition |
|---|---|---|---|---|
| T-01 | Project scaffolding and toolchain | — | — | — |
| T-02 | Shared type definitions | T-01 | — | — |
| T-03 | redactSecrets utility | T-01, T-02 | — | — |
| T-04 | RollbackManager | T-01, T-02 | — | — |
| T-05 | DriftComparator | T-01, T-02 | — | — |
| T-06 | SectionRegenerator | T-01, T-02 | — | — |
| T-07 | DriftDetector | T-01, T-02 | — | — |
| T-08 | DocLocator — Markdown path | T-01, T-02 | — | — |
| T-09 | Confluence storage-format fixture | T-01 | **BLOCKED: real Confluence credentials** | R-4 |
| T-10 | DocLocator — Confluence path | T-08, T-09 | T-09 fixture exists and fixture test passes | R-4 |
| T-11 | ConfluencePublisher | T-03, T-04, T-10 | — | **W-1 before merge** |
| T-12 | GitPublisher | T-03, T-04, T-06, T-08 | — | — |
| T-13 | TriggerValidator | T-03, T-04, T-11 | — | — |
| T-14 | ConfluencePublish (Workflow 2) | T-11, T-03 | — | **W-2 before merge** |
| T-15 | PipelineOrchestrator | T-03–T-08, T-10–T-13 | — | — |
| T-16 | doc-sync.yml workflow | T-15 | — | — |
| T-17 | doc-sync-publish.yml workflow | T-14 | — | — |
| T-18 | End-to-end test suite | T-14–T-17 | T-09 complete (R-4) | R-4 |

---

## Explicitly Blocked Tasks

**T-09** is blocked on a hard external dependency: real Confluence Cloud API
credentials and a real target page must be accessible to export the storage-format
fixture. This cannot be synthesized. Until credentials are provided, T-09 cannot
start, which in turn holds T-10 and ultimately delays T-18.

**Implementer action required:** obtain `CONFLUENCE_BASE_URL`, `CONFLUENCE_API_TOKEN`,
and confirm `CONFLUENCE_PAGE_ID=32833537` before T-09 can be assigned.

---

*End of Implementation Plan. Do not begin implementation until this document is
human-approved.*
