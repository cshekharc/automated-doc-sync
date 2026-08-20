# Code Review — Automated Documentation Sync

**Reviewer:** code-reviewer subagent  
**Date:** 2026-08-20  
**Implementation phase:** Phase 6  
**Test baseline:** 354 / 354 passing  

---

## Review Scope

All source files in `src/`, GitHub Actions workflows in `.github/workflows/`,
test fixtures under `test/`, and the implementation plan `docs/impl-plan.md`.
Reviewed against `docs/requirements.md` (11 FRs, 7 NFRs, 9 ACs) and the
architecture decisions captured in `docs/architecture.md`.

---

## Summary

Three blocking defects were found during the initial review. All three have been
resolved and the full test suite re-verified at 354 / 354. The implementation is
**APPROVED** to proceed to Phase 7 (Verification).

---

## Findings

### Finding 1 — Workflow 2 trigger never fires (CRITICAL → FIXED)

**File:** `.github/workflows/doc-sync-publish.yml`

**Problem:** The `pull_request` trigger included a `branches` filter listing
`docs/sync-*`. GitHub evaluates this filter against the **base** branch of the
PR, not the **head** branch. A `docs/sync-*` branch is always the PR head; the
base is always `main`. The filter therefore never matched and Workflow 2 never
ran, meaning Confluence drafts written by Workflow 1 would never be published.

**Fix applied:**

```yaml
# Before — filter applied to base branch (never fired):
on:
  pull_request:
    types: [closed]
    branches:
      - 'docs/sync-*'
jobs:
  publish-confluence-drafts:
    if: github.event.pull_request.merged == true

# After — filter applied to HEAD branch via job condition:
on:
  pull_request:
    types: [closed]
jobs:
  publish-confluence-drafts:
    if: github.event.pull_request.merged == true && startsWith(github.head_ref, 'docs/sync-')
    permissions:
      contents: read
      pull-requests: read
```

**Status:** FIXED. Workflow trigger and `permissions` block both corrected.

---

### Finding 2 — Double `/wiki/` in Confluence publish URLs (MAJOR → FIXED)

**File:** `src/confluence-publish.ts`

**Problem:** `CONFLUENCE_BASE_URL` is documented (and set in CI secrets) as
`https://example.atlassian.net/wiki`. The module constructed URLs as
`${baseUrl}/wiki/api/v2/pages/${pageId}`, producing a double-segment path:
`https://example.atlassian.net/wiki/wiki/api/v2/pages/...`. Every GET and PUT
in Workflow 2 would fail with HTTP 404.

**Fix applied:**

Changed both URL constructions from `${baseUrl}/wiki/api/v2/pages/${pageId}`
to `${baseUrl}/api/v2/pages/${pageId}`. The `/wiki` prefix is already carried
by `CONFLUENCE_BASE_URL`.

Lines changed: GET (~line 240), PUT (~line 281).  
Two test assertions in `test/unit/confluence-publish.test.ts` that were
asserting the old wrong path substring (`/wiki/api/v2/pages/...`) were also
corrected to `/api/v2/pages/...`.

**Status:** FIXED. All 27 tests in `confluence-publish.test.ts` pass.

---

### Finding 3 — Markdown scaffold formatter used for Confluence body (MAJOR → FIXED)

**File:** `src/pipeline.ts` line 233; `src/regenerator/index.ts` line 28

**Problem:** In the Confluence scaffold path (newly added function, no existing
Confluence section), `pipeline.ts` called `buildScaffoldSection(fn)`, which
produces Markdown output (`## heading`, fenced code block). This string was
appended directly to a Confluence storage-format XHTML body, producing malformed
markup that Confluence would reject or misrender.

The correct XHTML scaffold function `buildConfluenceScaffoldSection` existed in
`src/regenerator/index.ts` at line 28 but was not exported, making it
inaccessible to `pipeline.ts`.

**Fix applied:**

1. Added `export` keyword to `buildConfluenceScaffoldSection` in
   `src/regenerator/index.ts` (line 28).
2. Updated the import in `src/pipeline.ts` to include
   `buildConfluenceScaffoldSection`.
3. Replaced the `buildScaffoldSection(fn)` call at `pipeline.ts` line 233 with
   `buildConfluenceScaffoldSection(fn)`.

**Status:** FIXED. The scaffold path now appends valid XHTML (`<h2>…</h2>
<pre><code class="language-typescript">…</code></pre><p>…</p>`) to the
Confluence body. All 354 tests pass.

---

## Known Limitations (not blocking)

- **T-09 / W-1 / R-4 (partial):** Live Confluence API at
  `epam-team-test-csc.atlassian.net` returned HTTP 403 (product licence
  restriction). A synthetic XHTML fixture was created at
  `test/fixtures/confluence/page-32833537-body.html`. NFR-5 (live round-trip
  test) is therefore only partially satisfied. All unit and e2e tests use
  synthetic fixtures; a live environment test remains out of scope until a
  licensed Confluence instance is available.

---

## Test Results (post-fix)

| Suite | Tests | Status |
|-------|------:|--------|
| `test/unit/redact-secrets.test.ts` | 30 | ✓ pass |
| `test/unit/rollback-manager.test.ts` | 10 | ✓ pass |
| `test/unit/drift-comparator.test.ts` | 12 | ✓ pass |
| `test/unit/drift-detector.test.ts` | 18 | ✓ pass |
| `test/unit/doc-locator-markdown.test.ts` | 21 | ✓ pass |
| `test/unit/doc-locator-confluence.test.ts` | 28 | ✓ pass |
| `test/unit/regenerator.test.ts` | 32 | ✓ pass |
| `test/unit/confluence-publisher.test.ts` | 26 | ✓ pass |
| `test/unit/confluence-publish.test.ts` | 27 | ✓ pass |
| `test/unit/trigger-validator.test.ts` | 27 | ✓ pass |
| `test/unit/pipeline.test.ts` | 29 | ✓ pass |
| `test/unit/git-publisher.test.ts` | 44 | ✓ pass |
| `test/e2e/happy-path-markdown.spec.ts` | 6 | ✓ pass |
| `test/e2e/happy-path-confluence.spec.ts` | 6 | ✓ pass |
| `test/e2e/confluence-publish.spec.ts` | 5 | ✓ pass |
| `test/e2e/preflight-fail.spec.ts` | 5 | ✓ pass |
| `test/e2e/scaffold-new-function.spec.ts` | 6 | ✓ pass |
| `test/e2e/not-found.spec.ts` | 5 | ✓ pass |
| `test/e2e/idempotency.spec.ts` | 4 | ✓ pass |
| `test/e2e/rollback-github.spec.ts` | 5 | ✓ pass |
| `test/e2e/rollback-confluence.spec.ts` | 4 | ✓ pass |
| `test/e2e/overloads.spec.ts` | 4 | ✓ pass |
| **Total** | **354** | **✓ all pass** |

---

## Verdict

**APPROVED** — all blocking defects resolved, 354 / 354 tests passing.

Ready to proceed to **Phase 7 — Verification** (`docs/verification-report.md`).
