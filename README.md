# Automated Documentation Sync

An agentic TypeScript/Node.js pipeline that detects drift between exported function signatures / JSDoc comments in source code and published documentation (Confluence pages and Markdown files), regenerates only the stale sections, and opens a GitHub PR for human review.

Built as an agentic SDLC capstone using Claude Code's primitives (subagents, slash commands, hooks, MCP servers).

**Repository:** [cshekharc/automated-doc-sync](https://github.com/cshekharc/automated-doc-sync)
**Confluence reference page:** [Pipeline Reference](https://epam-team-test-csc.atlassian.net/wiki/spaces/SD/pages/33030145)

---

## How it works

The pipeline runs as two GitHub Actions workflows triggered on PR merge events.

### Workflow 1 — Detect drift and open sync PR (`doc-sync.yml`)

Triggers when any PR merges into `main`.

```
merged PR
    │
    ▼
DriftDetector      ← git show sha^1:<file> + ts-morph AST diff
    │ changed exported functions
    ▼
DocLocator         ← finds section in docs/*.md or Confluence page
    │ (markdownFilePath + offsets) or (confluencePageId + offsets)
    ▼
DriftComparator    ← 'stale' | 'current' | 'not-found'
    │ stale / not-found sections
    ▼
Regenerator        ← raw-string splice (never rewrites the whole file)
    │ updated file content
    ▼
ConfluencePublisher ← PUT /wiki/api/v2/pages/{id}  status: "draft"
    │
    ▼
GitPublisher       ← commit + push docs/sync-<timestamp> branch
    │
    ▼
GitPublisher       ← gh pr create  (with doc-sync-meta comment in body)
```

### Workflow 2 — Publish Confluence drafts (`doc-sync-publish.yml`)

Triggers when a `docs/sync-*` PR is merged.

Reads the `<!-- doc-sync-meta: {...} -->` block written by Workflow 1 into the PR body, then issues `PUT /wiki/api/v2/pages/{id}` with `status: "current"` for every draft Confluence page listed there.

---

## Quick start

### Prerequisites

- Node.js ≥ 20
- `gh` CLI authenticated (`gh auth login`)
- Atlassian Cloud account with an [API token](https://id.atlassian.com/manage-profile/security/api-tokens)

### Install and build

```bash
npm install
npm run build
```

### Run tests

```bash
npm test              # 354 unit tests (Vitest)
npm run test:e2e      # 50 e2e tests (Playwright)
npm run lint          # ESLint — zero warnings enforced
```

---

## Configuration

### GitHub Actions secrets

Set these in **Settings → Secrets and variables → Actions** for the repository.

| Secret | Required | Description |
|---|---|---|
| `CONFLUENCE_BASE_URL` | Yes | Confluence Cloud base URL, e.g. `https://org.atlassian.net/wiki` |
| `CONFLUENCE_USERNAME` | Yes | Atlassian account email address used for Basic auth |
| `CONFLUENCE_API_TOKEN` | Yes | Atlassian Cloud API token — never logged (NFR-2) |
| `CONFLUENCE_PAGE_ID` | No | Fallback Confluence page ID when not in `docs/confluence-map.json` |
| `CONFLUENCE_REQUEST_TIMEOUT_MS` | No | HTTP timeout in ms, default `30000` |
| `GITHUB_REQUEST_TIMEOUT_MS` | No | GitHub API timeout in ms, default `30000` |
| `DOCS_DEFAULT_FILE` | No | Fallback docs file path, default `docs/api.md` |

`GITHUB_TOKEN` is provided automatically by GitHub Actions.

### Page mapping

`docs/confluence-map.json` maps repo-relative source file paths to Confluence page IDs:

```json
{
  "_comment": "Maps repo-relative source file paths to Confluence page IDs",
  "src/drift-detector/index.ts": "32833537"
}
```

Add an entry for each source file whose documentation lives on a Confluence page.

### Local development

Export the variables before running the pipeline locally:

```bash
export CONFLUENCE_BASE_URL="https://yourorg.atlassian.net/wiki"
export CONFLUENCE_USERNAME="you@example.com"
export CONFLUENCE_API_TOKEN="ATATT..."
export GITHUB_TOKEN="ghp_..."
export GITHUB_REPOSITORY="owner/repo"

npm run build && node dist/pipeline.js
```

---

## Project structure

```
src/
├── pipeline.ts                  Entry point for Workflow 1
├── confluence-publish.ts        Entry point for Workflow 2
├── drift-detector/index.ts      Detects changed exported functions via ts-morph
├── doc-locator/index.ts         Locates sections in Markdown and Confluence
├── drift-comparator.ts          Classifies sections as stale / current / not-found
├── regenerator/index.ts         Regenerates stale sections via raw-string splice
├── confluence-publisher/index.ts Writes Confluence draft pages (PUT status: "draft")
├── git-publisher/index.ts       Commits, pushes, and opens the sync PR
├── trigger-validator.ts         Validates merge event + idempotency check
├── rollback-manager.ts          Register-then-mutate rollback stack
├── types.ts                     Shared TypeScript types
└── utils/
    ├── confluence-auth.ts       Shared Basic auth header builder (email:token)
    └── redact-secrets.ts        Scrubs tokens from all log output

docs/
├── confluence-map.json          Source file → Confluence page ID mapping
├── requirements.md              Phase 1 — 11 FRs, 7 NFRs, 9 ACs
├── architecture.md              Phase 2
├── design-review.md             Phase 3 — APPROVED WITH CONDITIONS (all met)
├── impl-plan.md                 Phase 4 — 18 tasks
├── code-review.md               Phase 6 — APPROVED (3 blocking defects fixed)
└── verification-report.md       Phase 7

.github/workflows/
├── doc-sync.yml                 Workflow 1 — drift detection + sync PR
└── doc-sync-publish.yml         Workflow 2 — publish Confluence drafts

.claude/
├── agents/                      Specialist subagents for each SDLC phase
├── commands/                    Slash commands (/requirements, /architecture, …)
├── hooks/                       phase-gate.sh, secret-scan.sh (PreToolUse)
├── settings.json                Hook wiring and permissions
└── setup-mcp.sh                 One-time MCP server registration
```

---

## Key modules

### `buildConfluenceAuthHeader(username, token)`
`src/utils/confluence-auth.ts`

Centralised builder for the `Authorization: Basic` header. Uses the Atlassian Cloud format `base64(email:token)`. All three Confluence-touching modules use this single implementation — the result is always passed through `redactSecrets` before logging.

### `detectDrift(changedFilePaths, sha)`
`src/drift-detector/index.ts`

Fetches the base file via `git show sha^1:<path>` and reads the head from disk. Parses both with an in-memory `ts-morph` project (no temp files). Returns only functions whose signature or JSDoc changed. Overload deduplication: the last declaration (implementation signature) wins.

### `locateConfluenceSection(functionName, sourceFilePath)`
`src/doc-locator/index.ts`

Resolves the Confluence page ID from `docs/confluence-map.json` (falling back to `CONFLUENCE_PAGE_ID`), fetches the page body in storage format, and extracts the heading-delimited XHTML section via regex (required because `ac:` namespace elements break standard XML parsers).

### `compareDrift(fn, section)`
`src/drift-comparator.ts`

Returns `'stale'` if the doc section does not embed the current signature/JSDoc, `'current'` if it does, or `'not-found'` if no section exists.

### `ConfluencePublisher.writeDraft(pageId, updatedHtml, version, rollback)`
`src/confluence-publisher/index.ts`

Register-then-mutate invariant (F-6): registers the rollback undo closure on `RollbackManager` *before* issuing the PUT so that the undo captures the pre-mutation state. Writes with `status: "draft"` — the live published page is never modified by Workflow 1.

### `redactSecrets(input)`
`src/utils/redact-secrets.ts`

Applied to every string written to stdout or stderr. Detects and replaces `ghp_`, `ghs_`, `github_pat_`, `ATATT` (Atlassian tokens), Bearer headers, and base64 blobs ≥ 40 chars with `[REDACTED]`.

---

## SDLC phases (agentic pipeline)

This project was built using Claude Code's 8-phase agentic SDLC. Each phase is a slash command that delegates to a specialist subagent; a `phase-gate.sh` hook prevents skipping phases.

| # | Phase | Artifact | Slash command |
|---|---|---|---|
| 1 | Requirements | `docs/requirements.md` | `/requirements` |
| 2 | Architecture | `docs/architecture.md` | `/architecture` |
| 3 | Design Review | `docs/design-review.md` | `/design-review` |
| 4 | Impl. Plan | `docs/impl-plan.md` | `/plan` |
| 5 | Implementation | `src/` | `/implement TASK-N` |
| 6 | Code Review | `docs/code-review.md` | `/review` |
| 7 | Verification | `docs/verification-report.md` | `/verify` |
| 8 | PR | opened via `gh pr create` | `/pr` |

---

## Known limitations

- Live Confluence round-trip (NFR-5) not empirically verified — HTTP 403 licence restriction encountered during development; all Confluence tests use synthetic fixtures.
- GitHub Actions 5-minute runtime budget (NFR-1) verified by static inspection only.
- `CONFLUENCE_USERNAME` must be added to **Settings → Secrets** (`CONFLUENCE_USERNAME = you@example.com`) in addition to `CONFLUENCE_API_TOKEN` before the workflows will authenticate successfully.
