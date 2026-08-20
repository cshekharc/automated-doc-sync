# Design Review: Automated Documentation Sync Pipeline

**Phase:** 3 — Design Review
**Date:** 2026-08-20
**Reviewer:** Staff Engineer (skeptical review)
**Verdict:** REJECTED — two Critical findings must be resolved before implementation begins

Reviewed artifacts:
- `docs/requirements.md` (Phase 1, approved)
- `docs/architecture.md` (Phase 2, under review)

---

## Overall Verdict

**REJECTED — Approved with Required Changes**

Two Critical findings block implementation:

1. The architecture publishes Confluence changes **before** the PR is created, directly
   violating NFR-7's explicit requirement that Confluence changes require human review
   before publishing. A PR rejection after pipeline success leaves live Confluence pages
   in a permanently altered state with no remediation path.

2. The Confluence section-location strategy queries pages by **page title** matching the
   function name. For any repository where all API functions are documented on a single
   Confluence page (e.g., "API Reference"), this returns zero matches for every function.
   FR-3 (Confluence support) would be silently non-functional from day one.

Five Major findings also require architecture revisions before implementation begins.

---

## Strengths

- **Component boundaries are clean.** Each module has a single stated responsibility;
  the orchestrator/try-catch/RollbackManager separation is textbook compensating-transaction
  pattern and directly enables NFR-3 and NFR-5.
- **Alternative approaches are justified.** The rejection of the monolithic-script and
  LLM-agent alternatives is well-reasoned and correctly traces to NFR-5 (testability)
  and FR-5 (determinism).
- **Data types are well-specified.** The Section 7 interface block is unusually concrete
  for an architecture document; it provides a solid contract for implementation without
  over-specifying internals.
- **Rollback coverage is broad.** Table 8.2 covers the four expected mutation types and
  the LIFO-with-continue-on-undo-failure design is correct.
- **Test scenarios map to acceptance criteria.** Section 9.2 explicitly links each e2e
  scenario to an AC; the gap analysis below is against completeness, not intent.

---

## Findings

### Finding 1 — NFR-7 Violated: Confluence Updated Before Human Review

**Severity: Critical**
**Requirement traced:** NFR-7, AC-7 (indirectly), AC-8

NFR-7 states: "all Confluence changes shall be visible to the reviewer as a diff **before
publishing**, so no update is approved without explicit human review."

The architecture's data flow publishes Confluence changes in **Step 7** and creates the
PR in **Step 9**. By the time a human opens the PR, the Confluence page is already live
with the new content. If the human reviewer decides the regenerated content is wrong and
closes the PR without merging, the Confluence page remains permanently altered.

The RollbackManager fires only inside the pipeline's catch block (Section 8.1). It has no
hook for post-pipeline events such as PR closure by a human. There is no compensating
operation described for "human rejects the PR after successful pipeline completion."

This is not a nuance — NFR-7 explicitly requires "before publishing" review for
Confluence. The current design inverts that order entirely.

**Required resolution:** One of the following approaches must be chosen and documented:

- **Option A (preferred):** Remove live Confluence publishing from the pipeline entirely.
  Store the proposed Confluence content as a file diff inside the PR branch (e.g.,
  `docs/_confluence-patches/<pageId>.html`). Add a second workflow that reads and applies
  those patches only when the PR is merged to `main`. This respects NFR-7.

- **Option B:** Accept Confluence as a "draft mode" update (Confluence supports draft/
  unpublished page versions via the API). The pipeline writes to an unpublished draft;
  the PR description links to the draft preview URL. The second workflow publishes the
  draft on PR merge. This satisfies "before publishing" semantics if Confluence's API
  supports it for the target instance.

- **Option C (weak):** Treat Confluence as out of scope for the gated review and update
  the NFR-7 wording to exempt Confluence — but this requires a requirements change,
  not just an architecture change, and the product owner must approve.

---

### Finding 2 — Confluence Section Location Fails for Multi-Function Pages (FR-3)

**Severity: Critical**
**Requirement traced:** FR-3, FR-4, FR-8, AC-2

Section 4, Step 4 describes the Confluence search as:

> "calls the Confluence REST API `GET /wiki/api/v2/spaces/{spaceKey}/pages` with a
> `title` filter, then fetches page body in storage format and searches for
> `<h2>functionName</h2>`"

`GET /wiki/api/v2/spaces/{spaceKey}/pages` with a `title` filter returns pages whose
**page title** matches the filter value. The function name is passed as the filter.
This finds pages titled `myFunction`. In any repository where API functions are
documented in a single page titled "API Reference" with `## functionName` headings
inside it, the title filter returns zero results for every function, and every function
is classified `not-found`. FR-3's Confluence path is silently dead.

A secondary issue: even if a correctly-titled page is found, searching for the literal
string `<h2>functionName</h2>` in Confluence's storage format may fail because
Confluence XHTML headings carry `ac:` namespace attributes and can appear as
`<h2 id="...">functionName</h2>` or wrapped in macros.

This is related to but distinct from R-4. R-4 acknowledges the storage format is
unknown; this finding identifies that the search strategy itself is architecturally
wrong regardless of format.

**Required resolution:**

- Replace the title-filter approach with a CQL (Confluence Query Language) full-text
  search: `GET /wiki/rest/api/content/search?cql=space="{KEY}" AND text ~ "{functionName}"
  AND type=page` to find candidate pages, then parse their bodies for the heading. This
  is the standard Confluence pattern for content search.
- Document the heading-matching strategy against a real Confluence page fixture (as
  R-4 already flags) and define the exact storage-format pattern before implementation
  begins. Do not leave this as a runtime discovery.

---

### Finding 3 — remark Serialization Does Not Guarantee Byte-for-Byte Fidelity (AC-3)

**Severity: Major**
**Requirement traced:** FR-5, FR-9, AC-3

Section 5.6 states that `SectionRegenerator` "uses `remark` to parse the file AST,
splice out the stale section's nodes, insert new content nodes, and **serialize back
to Markdown**" and "Guarantees that no byte outside the target section changes."

This claim is false. `remark-stringify` (the serialization step) is a Markdown
formatter. When serializing back from mdast it will normalize:

- Emphasis markers (may change `_text_` to `*text*`)
- ATX vs setext heading styles
- Bullet list markers
- Blank-line handling around block elements
- Code fence character choice

Even if only one AST node is modified, the serializer re-emits the entire file in its
canonical form. A file containing `_italics_` will have that changed to `*italics*`
even though no change was intended. AC-3 requires "every other section and line in the
same `docs/*.md` file... shall remain **byte-for-byte identical** to the pre-sync
version." This is impossible using a full-file parse-and-serialize approach.

**Required resolution:** One of the following:

- **Option A:** Use string-level splice, not AST-level. Find the byte offsets of the
  target section (heading line to next same-or-higher heading line) using remark only
  to locate the boundary; then do `original.slice(0, start) + newSection + original.slice(end)`.
  The section being replaced is re-generated from scratch anyway, so only the boundaries
  need to be AST-derived.
- **Option B:** Use `remark-stringify` with `toMarkdown` options locked to a
  round-trip-safe configuration AND add a round-trip test fixture that asserts no change
  to a file that has not had its target section modified. Accept that this is
  format-normalization (weakening AC-3), and get the product owner to approve a weaker
  form of the requirement.

Option A is recommended. Update Section 5.6 to describe the string-splice approach.

---

### Finding 4 — git diff Uses Wrong SHA Pair for Merge Commits

**Severity: Major**
**Requirement traced:** FR-2, AC-1

Section 4, Step 3 states: "runs `git diff <base-sha>..<merge-sha> --name-only`."

In a GitHub Actions `pull_request` closed event:
- `GITHUB_SHA` is the **merge commit** (the result of merging the PR branch into main)
- The PR event JSON's `base.sha` is the **tip of the base branch at event time** — which
  may include commits pushed to `main` after the PR was opened but before it was merged

Using `git diff base.sha..GITHUB_SHA` therefore includes changes from other commits that
landed on `main` during the PR's lifetime, not just the changes in the merged PR.

The correct diff for "what changed in this PR" is:
```
git diff GITHUB_SHA^1 GITHUB_SHA -- 'src/**/*.ts'
```
(`^1` is the first parent of the merge commit, which is the tip of main just before the
merge; the second parent is the tip of the PR branch.) This isolates exactly the
changes introduced by the PR.

**Required resolution:** Update Step 3 in Section 4 and Section 5.3 to use
`git diff GITHUB_SHA^1 GITHUB_SHA` and document that this requires the merge commit to
be available on the runner (which it is by default in GitHub Actions with
`fetch-depth: 0` checkout, which must be declared in the workflow YAML).

---

### Finding 5 — Idempotency Check Requires Full PR Pagination; Race Condition Exists

**Severity: Major**
**Requirement traced:** FR-10, AC-6

Section 4, Step 2 states: "`TriggerValidator` queries the GitHub API for open pull
requests whose body contains the sentinel string `Triggered-by: <GITHUB_SHA>`."

The GitHub REST API endpoint `GET /repos/{owner}/{repo}/pulls?state=open` does **not**
support full-text body search. The only filtering parameters are `state`, `head`,
`base`, `sort`, and `direction`. Finding a PR by body content requires:
1. Paginating through **all** open PRs (default page size 30, no upper bound)
2. Filtering client-side by body string

For a busy repository with hundreds of open PRs this is O(n) API calls and could
consume a significant fraction of the 5-minute NFR-1 budget. It also consumes GitHub
API rate limit quota.

Additionally, there is a race condition: if two identical GitHub Actions runs fire for
the same merge SHA (e.g., re-run via the Actions UI), both can pass the idempotency
check before either has created its PR, resulting in two identical PRs. The sentinel
check is only effective after the PR exists.

**Required resolution:**

- Filter the PR list by **branch name prefix** `docs/sync-` using the `head` parameter
  before inspecting bodies. This dramatically reduces the set of PRs to inspect and is
  supported by the GitHub API.
- For the race condition: add a lock mechanism, such as creating a lightweight git tag
  `refs/doc-sync-in-progress/<SHA>` at the start of the run and deleting it at the end,
  and check for this tag as part of the idempotency check. Or document the race condition
  explicitly as an accepted limitation in Section 11.

---

### Finding 6 — File-Write Undo Registered After Mutation in Step 8

**Severity: Major**
**Requirement traced:** NFR-3, AC-8

Section 8.1 states the invariant: "Before any mutation, the calling component pushes an
undo closure onto the `RollbackManager` stack."

Section 4, Step 8 describes `GitPublisher`'s sequence as:
> "3. Writes updated `docs/*.md` content to disk.
>  4. Registers a file-restore undo for each modified file."

This is the wrong order. If writing `docs/api.md` fails mid-way through writing
multiple files (e.g., disk full after the first write), the file that was already
written has no registered undo because the undo was never pushed. The rollback will not
restore that file. NFR-3 and AC-8 are violated.

**Required resolution:** Swap the order. Register `git checkout HEAD -- docs/foo.md`
as an undo **before** writing `docs/foo.md`. Do this per-file inside the loop, not as
a batch. Update Step 8 in Section 4 and the description in Section 5.8 to reflect this.

---

### Finding 7 — R-4 Fallback Strategy Makes Confluence Support Undetectably Broken

**Severity: Major**
**Requirement traced:** FR-3, FR-5, R-4

Section 11 documents R-4: "The exact format Confluence uses for function-name headings
is Not Found." The mitigation is "fallback to `not-found` if parsing is ambiguous."

This mitigation is inadequate for a production pipeline. If the Confluence storage
format does not match the parser's assumptions, every Confluence lookup returns
`not-found`. The pipeline will then:
1. List all functions as "Known Limitations" in the PR
2. Exit 0 (successful)
3. Never update any Confluence page

This is silent data loss — the Confluence documentation drifts indefinitely with no
error signal. The operator has no way to distinguish "function genuinely not documented"
from "Confluence parser is broken for this instance." The architecture flags this as a
risk but provides no pre-flight validation or detection mechanism.

**Required resolution:**

- Add a pre-flight validation step in `TriggerValidator` (or a new `ConfigValidator`):
  fetch one known Confluence page, attempt to parse its headings, and if zero headings
  are found in a page known to contain content, emit a hard failure with a
  `CONFLUENCE_PARSE_VALIDATION_FAILED` error code and exit non-zero.
- Alternatively, add a CI smoke test against a real or accurately-recorded Confluence
  fixture that must pass before the implementation phase closes. Document in R-4 what
  the fixture file is and where it lives.
- Remove the "fallback to not-found" as the primary mitigation; it should be the last
  resort, not the first defense.

---

### Finding 8 — New File Creation in Scaffolding Heuristic Has No Rollback Entry

**Severity: Minor**
**Requirement traced:** NFR-3, Section 5.4 step 3

Section 5.4 states that if neither `docs/<base>.md` nor `docs/<dir>.md` exists, the
pipeline falls back to `DOCS_DEFAULT_FILE` (default: `docs/api.md`) and "is created as
an empty Markdown file if absent."

Section 8.2's mutation table does not list "create new `docs/*.md` file" as a mutation
requiring rollback. If the pipeline fails after creating `docs/api.md` but before
pushing the branch, the empty file is left on disk (or in the working tree) with no
automatic cleanup. This violates NFR-3's "shall not leave... a partially modified file
in an inconsistent state."

**Required resolution:** Add to Section 8.2: "Create `DOCS_DEFAULT_FILE` on disk →
Undo: delete the file (only if it was absent before the pipeline run)." Register this
undo before the file is created.

---

### Finding 9 — TypeScript Function Overloads Produce Duplicate `ExportedFunction` Entries

**Severity: Minor**
**Requirement traced:** FR-2, FR-3

TypeScript supports function overloads:
```typescript
export function parse(input: string): number;
export function parse(input: Buffer): number;
export function parse(input: string | Buffer): number { … }
```

`ts-morph`'s `getFunctions()` on the source file returns multiple function declarations
with the same name. The `ExportedFunction` interface (Section 7) has a single `signature`
field. The architecture does not define which signature is canonical (the implementation
signature? the union of overload signatures? only the first overload?), nor what happens
when `DocLocator` finds one heading named `parse` but `DriftDetector` emits three entries
named `parse`.

**Required resolution:** Add a note to Section 5.3 (DriftDetector) defining overload
handling: e.g., "collapse overloads by function name; the implementation signature (last
declaration) is canonical; overload signatures are concatenated in the `signature` field."
Update the `ExportedFunction` interface comment to match.

---

### Finding 10 — NFR-1 (5-minute SLA) Has No Enforcement Mechanism

**Severity: Minor**
**Requirement traced:** NFR-1

The architecture makes no mention of per-step timeouts, overall pipeline timeout, or
any mechanism to detect or fail gracefully when the 5-minute limit is approached. The
GitHub Actions workflow YAML `timeout-minutes` field is not mentioned. NFR-1 is
specified but has no implementation path.

R-2 identifies Confluence page scanning as a performance risk and proposes using
title/space filters. R-3 identifies rate limits and proposes a 500 ms delay. With
100 functions requiring 100 Confluence searches at 500 ms each, that is 50 seconds for
scanning alone, before any API write operations.

**Required resolution:**

- Add `timeout-minutes: 5` to the GitHub Actions workflow job definition. Document this
  in the architecture.
- Add a per-step timeout (e.g., 30 seconds for each external API call) to
  `ConfluencePublisher` and `GitPublisher`, surfaced as configurable environment
  variables (`CONFLUENCE_REQUEST_TIMEOUT_MS`, `GITHUB_REQUEST_TIMEOUT_MS`).
- Add a note to Section 5.4 / R-2 quantifying the worst-case Confluence scan time
  given the sequential-with-delay approach, and whether that fits within the 5-minute
  budget.

---

### Finding 11 — NFR-4 (All Exports Have JSDoc) Has No CI Enforcement

**Severity: Minor**
**Requirement traced:** NFR-4

NFR-4 requires all exported functions in `src/` to carry JSDoc comments. The
architecture describes no lint rule, pre-commit hook, or CI check to enforce this.
If a developer ships an exported function without JSDoc, `DriftDetector` will emit an
`ExportedFunction` with an empty `jsdoc` field; the scaffolded or regenerated section
will contain an empty JSDoc body; no error is raised.

**Required resolution:** Add a `eslint-plugin-jsdoc` rule `require-jsdoc` to the ESLint
config for all exported functions in `src/**/*.ts`, run in CI (`npm run lint`).
Document this in Section 6 (Technology Choices) as an enforcement mechanism for NFR-4.

---

### Finding 12 — `redactSecrets` Pattern Inventory Is Undefined

**Severity: Minor**
**Requirement traced:** NFR-2, AC-7

Section 8.5 states that `redactSecrets(text)` "replaces any value matching common secret
patterns (e.g., strings resembling `ghp_*`, `xoxb-*`, `AKIA*`) with `[REDACTED]`." The
word "e.g." means the list is not exhaustive. Confluence API tokens (`ATATT3...`),
generic bearer tokens, and Base64-encoded credentials are not mentioned.

More importantly, structured error logs (JSON to stdout on failure) may include raw
exception messages or HTTP response bodies that contain secrets. Section 8.5 says
`redactSecrets` is applied to "outgoing content (PR description, Confluence payloads,
commit messages)" — it does not say it is applied to error log output.

**Required resolution:**

- Define the complete set of regex patterns for `redactSecrets` in the architecture.
  At minimum: `ghp_[A-Za-z0-9]+`, `ghs_[A-Za-z0-9]+`, `ATATT[A-Za-z0-9]+` (Confluence
  cloud tokens), `Bearer [A-Za-z0-9._\-]+`, and generic base64 blobs longer than 40
  characters.
- Explicitly state that `redactSecrets` is applied to all strings before emitting to
  stdout, including structured error JSON fields.

---

## Summary Table

| # | Component | Risk / Gap | Severity | Recommendation |
|---|---|---|---|---|
| F-1 | ConfluencePublisher + PipelineOrchestrator | NFR-7 violated: Confluence pages updated in Step 7 before PR exists in Step 9; human review cannot gate live publication; PR rejection leaves Confluence permanently altered | **Critical** | Defer Confluence writes to a post-merge second workflow, or use draft/unpublished Confluence versions; never publish before PR approval |
| F-2 | DocLocator (Confluence path) | FR-3 broken: page title filter cannot find functions documented within multi-function pages; entire Confluence support silently returns `not-found` for all functions | **Critical** | Replace title filter with CQL full-text search; validate against real Confluence fixture before implementation |
| F-3 | SectionRegenerator | AC-3 false claim: remark-stringify normalizes the full file; untouched sections are not byte-for-byte preserved | **Major** | Use string-level boundary splice, not full-file AST serialize |
| F-4 | DriftDetector | FR-2 incorrect diff: `base.sha..GITHUB_SHA` includes commits from other PRs that landed during PR lifetime | **Major** | Use `GITHUB_SHA^1..GITHUB_SHA` for merge commit diff |
| F-5 | TriggerValidator | FR-10 unreliable: GitHub API has no body-text PR search; requires full pagination; race condition between concurrent runs | **Major** | Pre-filter by `head` branch prefix `docs/sync-`; document race condition or add locking tag |
| F-6 | GitPublisher / Step 8 | NFR-3 violated: file-write undo registered after the mutation, not before; partially-written files left unregistered on disk-write failure | **Major** | Register each file undo before writing that file |
| F-7 | ConfluencePublisher + R-4 | R-4 fallback to `not-found` silently disables all Confluence updates if format assumptions are wrong; operator cannot distinguish parse failure from genuine not-found | **Major** | Add pre-flight Confluence parse validation; hard-fail on zero headings from a non-empty known page |
| F-8 | DocLocator / Scaffolding | NFR-3 gap: creating `DOCS_DEFAULT_FILE` on disk has no rollback entry in Section 8.2 | **Minor** | Add file-creation rollback; register before creating |
| F-9 | DriftDetector | FR-2 undefined: TypeScript overloads produce duplicate names in `ExportedFunction[]`; behavior unspecified | **Minor** | Define overload-collapse strategy in Section 5.3 |
| F-10 | PipelineOrchestrator + workflow YAML | NFR-1 unenforced: no step timeouts, no `timeout-minutes` in workflow; worst-case Confluence scan may exceed 5 min | **Minor** | Add `timeout-minutes: 5` to workflow; add per-call timeout env vars |
| F-11 | GitPublisher / CI | NFR-4 unenforced: no lint rule requires JSDoc on exported functions | **Minor** | Add `eslint-plugin-jsdoc` `require-jsdoc` rule for exports |
| F-12 | PipelineOrchestrator / error logging | NFR-2 partial: `redactSecrets` coverage is undefined and not applied to error log output | **Minor** | Define full pattern inventory; apply to all stdout output |

---

## Unanswered Questions from Architecture (Section 11)

The following items were flagged by the architect as risks or assumptions and must be
resolved before implementation begins:

**A-1 (Confluence MCP):** The architecture correctly documents that it uses REST API
instead of MCP. No action needed beyond confirming this is acceptable to the product
owner, since FR-3 references "configured Confluence MCP server."

**A-2 (Confluence heading level):** This assumption is load-bearing. If any Confluence
page uses `<h3>` instead of `<h2>` for function headings, those functions are silently
missed. The architecture must either: (a) make the heading level configurable via an
env var, or (b) search all heading levels h1–h4 and return the first match with exact
text content.

**R-4 (Confluence storage format unknown):** Unresolved. Must be resolved with a real
fixture before implementation. Blocked on F-2 and F-7 remediation. Specifically: obtain
a sample page, export its storage format, and verify that the proposed search strategy
(after it is corrected per F-2) correctly locates a heading. The result must be
documented in `docs/architecture.md` before the implementation plan begins.

**R-5 (branch protection on `docs/*`):** The mitigation ("check branch protection rules
in TriggerValidator") must specify exactly which API endpoint is used and what happens if
the check fails (hard stop before any mutation). This is not currently described in any
component section.

---

## Approval Conditions

The following changes must be made to `docs/architecture.md` before implementation
(the `docs/impl-plan.md` phase) can begin:

1. **[Critical — F-1]** Add a new Section describing a two-workflow model or
   draft-publish model for Confluence that satisfies NFR-7's "before publishing" gate.
   The current single-workflow design that publishes Confluence in Step 7 must be
   replaced. Update Section 4 data flow, Section 5.7, and Section 8.2 accordingly.

2. **[Critical — F-2]** Replace the Confluence page-title-filter search strategy in
   Section 4 Step 4 and Section 5.4 with a CQL-based content search. Document the
   specific API endpoint and query syntax. Commit to resolving R-4 with a concrete
   Confluence fixture before the implementation phase closes.

3. **[Major — F-3]** Replace the "parse AST → splice → serialize" approach in Section
   5.6 with a string-boundary-splice approach. Remove or qualify the "byte-for-byte
   identical" claim to accurately describe what the implementation actually guarantees.

4. **[Major — F-4]** Update Section 4 Step 3 and Section 5.3 to use
   `GITHUB_SHA^1..GITHUB_SHA` for the merge-commit diff, not `base.sha..GITHUB_SHA`.
   Add a note that the workflow YAML must use `fetch-depth: 0` checkout.

5. **[Major — F-5]** Update Section 4 Step 2 and Section 5.2 with a `head`-filtered PR
   list query before body inspection. Either document the race condition as accepted
   (with severity assessment) or add a locking mechanism.

6. **[Major — F-6]** Update Section 4 Step 8 to register each file undo *before* the
   corresponding file write. Update Section 5.8 to state this invariant explicitly.

7. **[Major — F-7]** Add a pre-flight Confluence parse validation step to
   `TriggerValidator` (or a new `ConfigValidator` component). Define what "validated"
   means (e.g., heading count > 0 from a known non-empty page). Remove "fallback to
   not-found" as a primary mitigation for R-4.

Minor findings (F-8 through F-12) must be addressed before the first implementation PR
is merged, but do not block the architecture document revision or the implementation
plan.

---

*End of Design Review. The architect must revise `docs/architecture.md` to address
Critical and Major findings, then request human approval of the revised architecture
before `docs/impl-plan.md` is begun.*

---

## Re-Review

**Date:** 2026-08-20
**Reviewer:** Staff Engineer (skeptical re-review)
**Reviewed artifact:** `docs/architecture.md` (Revised — "awaiting design re-review")
**Product-owner constraints applied:** F-1 resolved via Confluence draft versions (Option B); F-2 resolved via direct page-ID lookup (`CONFLUENCE_PAGE_ID=32833537`), no CQL.

### Finding-by-Finding Disposition

| Finding | Severity | Status | Basis |
|---|---|---|---|
| F-1 | Critical | **Resolved** | Two-workflow model implemented: Workflow 1 writes `status: "draft"` only (published page unchanged during review); Workflow 2 fires on `docs/sync-*` PR merge and issues `PUT status: "current"` to publish — satisfying NFR-7's "before publishing" gate. |
| F-2 | Critical | **Resolved** | Title-filter and CQL search eliminated; `DocLocator` now fetches the page by configured ID (`CONFLUENCE_PAGE_ID` env var or `docs/confluence-map.json`), scans XHTML body for `<h2>`/`<h3>` heading elements by text content; heading level configurable via `CONFLUENCE_HEADING_LEVEL` env var. |
| F-3 | Major | **Resolved** | `SectionRegenerator` now uses `remark` only to locate character offsets, then performs `rawFile.slice(0, sectionStart) + newSectionString + rawFile.slice(sectionEnd)`; `remark-stringify` is explicitly not called on unchanged content; `DocSection` carries `sectionStartOffset`/`sectionEndOffset` fields; `regenerator.test.ts` asserts byte-for-byte identity of unchanged regions. |
| F-4 | Major | **Resolved** | Step 3 uses `git diff GITHUB_SHA^1 GITHUB_SHA --name-only -- 'src/**/*.ts'`; `GITHUB_SHA^1` correctly isolates PR-only changes; `fetch-depth: 0` checkout requirement documented in Step 3. |
| F-5 | Major | **Resolved** | `TriggerValidator` paginates open PRs with `per_page=100` and filters client-side to `head.ref` starting with `docs/sync-` before body inspection; this is the correct approach because the GitHub API `head` parameter does not support wildcard prefix matching. Race condition documented and accepted in A-6 with severity rationale ("low-probability; duplicate PRs are harmless and closed manually"). |
| F-6 | Major | **Resolved** | Register-then-mutate invariant stated explicitly in Step 8 (per-file loop: register undo at step 3a, write file at step 3b), in Section 5.8, in Section 8.1, and in the `RollbackEntry` interface JSDoc; `rollback-manager.test.ts` verifies the undo is registered before the failing mutation. |
| F-7 | Major | **Resolved** | Step 2a added: `TriggerValidator` fetches the configured Confluence page, counts heading elements at the configured level, and exits non-zero with `CONFLUENCE_PARSE_VALIDATION_FAILED` if the page body is non-empty and zero headings are found; R-4 updated to "Significantly mitigated by F-7" and requires a real fixture in `test/fixtures/confluence/` before implementation closes. |
| F-8 | Minor | **Resolved** | Table 8.2 now includes the file-creation mutation with `fs.unlink` undo; Step 8 item 4 describes the `fs.existsSync` pre-creation boolean and the register-before-create ordering. |
| F-9 | Minor | **Resolved** | Section 5.3 defines overload deduplication: last declaration (implementation signature) is canonical, overload-only signatures discarded; `ExportedFunction` interface JSDoc states this explicitly. |
| F-10 | Minor | **Resolved** | `timeout-minutes: 5` on the workflow job declared in Step 1; `CONFLUENCE_REQUEST_TIMEOUT_MS` and `GITHUB_REQUEST_TIMEOUT_MS` (default 30 000 ms) applied to all external calls in Sections 5.7 and 5.8; R-2 quantifies worst-case (10 distinct page IDs, all hitting timeout = 10 min raw, but workflow kill at 5 min is the operative bound). |
| F-11 | Minor | **Resolved** | `eslint-plugin-jsdoc` 50.x added to Technology Choices with `require-jsdoc` rule for all exported functions in `src/**/*.ts`; runs as part of `npm run lint` in CI. |
| F-12 | Minor | **Resolved** | Section 8.5 defines a six-pattern inventory (`ghp_`, `ghs_`, `github_pat_`, `ATATT`, `Bearer`, generic Base64 ≥ 40 chars); `redactSecrets` applied at `PipelineOrchestrator` stdout boundary covering all output including structured JSON error fields; per-payload application retained as defense-in-depth. |

### New Concerns Surfaced During Re-Review

The following issues were not present in the original F-1 through F-12 findings. They
emerge from the revised design and must be resolved before or during implementation.
Neither is a blocking concern for architecture approval; both are deferred to
implementation with the conditions below.

#### W-1 — Confluence Draft Rollback Version-Number Conflict (Minor)

**Requirement traced:** NFR-3, AC-8
**Location:** Section 8.2 (undo for `PUT status: "draft"`), Section 8.4

Section 8.2 states the rollback undo for a draft write is:
> "PUT original content with `status: 'current'` and the original version number"

The problem: Confluence Cloud's REST API v2 typically requires the version number in a
PUT body to be exactly `currentVersion + 1`. After the draft write, the stored version
on Confluence is `N + 1`. The undo PUT sends version `N` (the pre-draft version),
which Confluence will reject with HTTP 409 Conflict. The rollback fails silently (the
LIFO-with-continue-on-undo-failure design logs and skips the failed undo), leaving the
draft in place with no cleanup path.

A-7 already flags that the draft API must be validated before implementation closes,
and provides a fallback to Option A (file-based patches) if drafts are not supported.
That fallback is adequate as an escape hatch. However, the correct rollback strategy
for the draft case needs to be defined before implementation begins, because if the
rollback version logic is wrong, AC-8 ("partial Confluence edit shall be left in the
same state as before") is violated whenever a rollback is triggered after a draft write.

**Required implementation action:** Before merging the first implementation PR that
touches `ConfluencePublisher`, verify empirically against the target Confluence Cloud
instance whether: (a) the draft PUT increments the published version number or creates
a separate unpublished revision, and (b) what version number to send in the rollback
PUT to successfully discard the draft. If the answer is a separate unpublished revision,
the rollback must use the draft's version number (not the original), or use a dedicated
"discard draft" API call if one is available. Document the verified behavior in A-7 and
update the rollback undo closure in `ConfluencePublisher`.

#### W-2 — Workflow 2 doc-sync-meta Block Is an Injection Surface (Minor)

**Requirement traced:** NFR-2, NFR-7
**Location:** Section 4 Step 11, Section 5.10

`doc-sync-publish.yml` extracts Confluence page IDs from the `<!-- doc-sync-meta: ... -->`
HTML comment in the merged PR body. Any repository contributor with permission to edit
PR bodies (typically: the PR author, collaborators with write access) can alter the
`confluenceDrafts` array before the PR is merged. If an attacker replaces the legitimate
page ID `32833537` with the ID of a sensitive Confluence page that happens to have a
draft, Workflow 2 will publish that page.

The Step 11 guard — verify `draft` status before publishing — provides partial
protection: it only publishes pages currently in draft status. But a page legitimately
left in draft from a prior failed pipeline run could be targeted.

**Required implementation action:** In `ConfluencePublish` (`src/confluence-publish.ts`),
after parsing `confluenceDrafts`, cross-reference each page ID against a server-side
allowlist derived from `docs/confluence-map.json` or `CONFLUENCE_PAGE_ID` before
issuing any PUT. Page IDs that do not appear in the allowlist must be logged and skipped,
not published. This bounds the blast radius to pages the pipeline is legitimately
configured to manage.

### Updated Summary Table (Re-Review additions only)

| # | Component | Risk / Gap | Severity | Recommendation |
|---|---|---|---|---|
| W-1 | ConfluencePublisher / RollbackManager | Rollback undo sends pre-draft version number; Confluence v2 API may reject with 409, leaving draft unreverted and violating AC-8 | **Minor** | Validate draft API version semantics before first impl PR; update rollback closure to use correct version or dedicated discard-draft call |
| W-2 | ConfluencePublish (Workflow 2) | PR-body doc-sync-meta block can be edited by contributors before merge; injected page IDs could cause Workflow 2 to publish arbitrary Confluence pages | **Minor** | Cross-reference parsed page IDs against the configured allowlist (`confluence-map.json` / `CONFLUENCE_PAGE_ID`) before any PUT; reject unlisted IDs |

### Final Verdict

**APPROVED WITH CONDITIONS — 2026-08-20**

All two Critical findings (F-1, F-2) and all five Major findings (F-3 through F-7) from
the original review are fully resolved in the revised architecture. All five Minor
findings (F-8 through F-12) are also resolved.

Two new Minor concerns (W-1, W-2) were surfaced during this re-review. Neither blocks
the start of implementation; both must be resolved before the first implementation PR
that touches `ConfluencePublisher` or `ConfluencePublish` is merged.

**Implementation may begin (`docs/impl-plan.md` phase is unblocked) subject to:**

1. **[W-1 — before merging any ConfluencePublisher impl PR]** Verify Confluence Cloud
   draft-API version semantics against the target instance; update the rollback undo
   closure in `ConfluencePublisher` to use the correct version number or a dedicated
   discard-draft operation; update A-7 with the verified behavior.

2. **[W-2 — before merging any ConfluencePublish impl PR]** Add a page-ID allowlist
   check in `src/confluence-publish.ts` that rejects any ID not present in
   `docs/confluence-map.json` or `CONFLUENCE_PAGE_ID` before issuing `PUT status: "current"`.

3. **[Pre-existing — R-4, before implementation phase closes]** A real Confluence page
   fixture must be checked into `test/fixtures/confluence/` and the heading-extraction
   unit test must pass against it, as required by the revised R-4.

*End of Re-Review.*
