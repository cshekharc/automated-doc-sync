# Requirements: Automated Documentation Sync Pipeline

**Phase:** 1 — Requirements
**Date:** 2026-08-20
**Status:** Draft — open questions resolved; awaiting human approval

---

## Summary

The Automated Documentation Sync pipeline monitors the main branch for merged
pull requests that modify or introduce exported TypeScript function signatures
or JSDoc doc-comments in `src/`. When such a merge is detected, the system
compares the updated source code against the corresponding sections in local
`docs/*.md` Markdown files and Confluence pages, identifies stale content,
regenerates only the affected section(s), auto-scaffolds skeleton sections for
newly added exported functions, and opens a single consolidated GitHub pull
request containing all changes for human review. Published documentation is
thereby kept in sync with the actual API without any manual authoring step,
and without rewriting content that has not drifted.

---

## Functional Requirements

FR-1. The system shall trigger the documentation-sync workflow when a pull
      request is merged to the main branch of the repository.

FR-2. The system shall parse each TypeScript file changed in the merged PR
      and identify every exported function that either (a) has a modified
      signature or JSDoc doc-comment relative to the base commit, or (b) is
      newly added and was not present in the base commit.

FR-3. For each function identified under FR-2(a), the system shall locate the
      corresponding documentation section by searching for a Markdown heading
      that exactly matches the function name (e.g., the heading `## myFunction`
      for a function named `myFunction`) within `docs/*.md` files and within
      Confluence pages accessible via the configured Confluence MCP server.

FR-4. The system shall compare the located documentation section's content
      against the updated function signature and doc-comment and mark the
      section as stale when a discrepancy is found.

FR-5. The system shall regenerate the content of each stale documentation
      section directly from the updated TypeScript source code (signature +
      JSDoc comment) without altering any other section of the same `docs/*.md`
      file or Confluence page.

FR-6. The system shall create a new git branch named `docs/sync-<timestamp>`
      where `<timestamp>` is the UTC ISO-8601 timestamp of pipeline execution
      (e.g., `docs/sync-20260820T143000Z`), and commit the regenerated and
      scaffolded section changes using a `docs:` conventional-commit message
      that names the affected function(s). No reviewer shall be auto-assigned
      to the opened PR.

FR-7. The system shall open a single consolidated GitHub pull request on the
      new branch whose description lists every function whose section was
      regenerated or scaffolded and, separately, every function that could not
      be matched to an existing doc section under a "Known Limitations" heading.

FR-8. When a modified exported function (FR-2(a)) has no corresponding
      documentation section — no matching Markdown heading in `docs/*.md` and
      no matching heading in any Confluence page — the system shall record that
      function as `Not Found` in the PR description under "Known Limitations"
      and shall not create a new section for it.

FR-9. The system shall not modify any documentation section — in `docs/*.md`
      or in Confluence — that does not correspond to a function changed or
      added in the triggering merge commit.

FR-10. The system shall open exactly one consolidated documentation-sync PR
       per triggering merge commit, regardless of how many exported functions
       were changed or added in that commit. If a documentation-sync PR is
       already open for the same merge commit SHA, the system shall not open a
       duplicate and shall exit successfully.

FR-11. For each newly added exported function (FR-2(b)), the system shall
       auto-scaffold a skeleton documentation section in the most relevant
       `docs/*.md` file (or Confluence page, if one is identified as the
       canonical target), consisting of:
       (a) a Markdown heading that exactly matches the function name,
       (b) the function signature as a TypeScript fenced code block, and
       (c) the full JSDoc comment as body text.

---

## Non-Functional Requirements

NFR-1. **Performance.** The full pipeline (drift detection through PR
        creation) shall complete within 5 minutes of the triggering PR being
        merged to main under normal GitHub Actions runner load.

NFR-2. **Security.** The system shall not write secrets, API tokens, or
        `.env` values to any file in `docs/`, to any Confluence page, to any
        commit, or to any PR description or comment field.

NFR-3. **Reliability.** If any step of the pipeline fails (e.g., GitHub API
        error, Confluence API error, TypeScript parse error), the system shall
        exit with a non-zero status code, emit a structured error log to
        stdout, and not leave a partial branch, a partially modified file, or
        a partial Confluence edit in an inconsistent state.

NFR-4. **Maintainability.** All exported functions in the pipeline's own
        TypeScript source (`src/`) shall carry JSDoc doc-comments so that the
        pipeline can regenerate its own documentation.

NFR-5. **Testability.** Unit tests (Vitest) shall cover the drift-detection,
        section-regeneration, and skeleton-scaffolding logic independently.
        End-to-end tests (Playwright or equivalent API fixture) shall cover
        the full trigger-to-PR flow for both `docs/*.md` and Confluence targets.

NFR-6. **Traceability.** Every documentation-sync PR shall reference the SHA
        of the triggering merge commit in its description.

NFR-7. **Auditability.** Changes to `docs/*.md` files and Confluence pages
        shall never be applied silently. All Markdown changes shall go through
        the generated PR; all Confluence changes shall be visible to the
        reviewer as a diff before publishing, so no update is approved without
        explicit human review.

---

## Out of Scope

- Automatically approving or merging the generated documentation PR without
  human review.
- Detecting drift that originates from manual edits to `docs/` files or
  Confluence pages rather than from source-code changes (code-change-triggered
  flow only).
- Updating documentation for non-exported (internal/private) functions.
- Reformatting, linting, or restructuring entire doc files or Confluence pages
  beyond the stale or newly scaffolded section.
- Changes to non-TypeScript files in `src/` (e.g., JSON configs, shell
  scripts).
- Publishing to GitHub Pages or any documentation site other than local
  `docs/*.md` and Confluence.

---

## Resolved Decisions

The following questions were raised during initial drafting and answered by
the product owner before Phase 1 was approved. They are recorded here for
traceability.

| # | Question | Decision |
|---|---|---|
| OQ-1 | Section-mapping mechanism | Exact Markdown heading match: `## functionName`. Incorporated into FR-3. |
| OQ-2 | Multi-function PR behaviour | One consolidated PR per triggering commit. Incorporated into FR-10. |
| OQ-3 | New-function handling | Auto-scaffold a skeleton section. Incorporated into FR-2(b) and FR-11. |
| OQ-4 | Branch naming and reviewer | Branch: `docs/sync-<timestamp>`. No auto-reviewer assignment. Incorporated into FR-6. |
| OQ-5 | Confluence scope | Confluence IS in scope alongside `docs/*.md`. Incorporated throughout. |

---

## Acceptance Criteria

**AC-1** (covers FR-1, FR-2)
Given a pull request has been merged to the `main` branch,
And the merged PR contains at least one change to an exported TypeScript
  function's signature or JSDoc doc-comment in `src/`, or adds a new exported
  function,
When the pipeline workflow is triggered,
Then the system shall identify every modified function and every newly added
  exported function, classifying each as a drift-detection or scaffold
  candidate before proceeding.

**AC-2** (covers FR-3, FR-4)
Given a modified exported function has been identified as a drift-detection
  candidate,
When the system scans `docs/*.md` files and accessible Confluence pages,
Then it shall locate the section whose heading exactly matches the function
  name (e.g., `## myFunction`) and mark it stale when its content does not
  reflect the updated signature and doc-comment,
Or record the function as `Not Found` when no matching heading exists in
  either target.

**AC-3** (covers FR-5, FR-9)
Given one or more stale doc sections have been identified,
When the system regenerates those sections,
Then every regenerated section shall accurately reflect the current function
  signature and JSDoc comment from `src/`,
And every other section and line in the same `docs/*.md` file or Confluence
  page shall remain byte-for-byte identical to the pre-sync version.

**AC-4** (covers FR-6, FR-7, FR-10)
Given at least one stale or newly scaffolded section exists,
When the pipeline completes,
Then exactly one new git branch named `docs/sync-<timestamp>` shall have been
  created with a `docs:` conventional commit containing all regenerated and
  scaffolded changes,
And exactly one GitHub pull request shall be opened on that branch with no
  auto-assigned reviewer and with a description listing each affected function
  and the SHA of the triggering merge commit.

**AC-5** (covers FR-8)
Given a merged PR modifies an exported function for which no heading matching
  its name exists in `docs/*.md` or in any accessible Confluence page,
When the pipeline completes,
Then no new documentation section shall have been created for that function,
And the function name shall appear under "Known Limitations" in the doc-sync
  PR description (or in the pipeline's error log if no PR was opened).

**AC-6** (covers FR-10 — idempotency)
Given a documentation-sync PR is already open for merge commit SHA `abc123`,
When the pipeline is triggered again for the same commit SHA `abc123`,
Then no second pull request shall be opened,
And the pipeline shall exit successfully after detecting the existing PR.

**AC-7** (covers NFR-2)
Given the pipeline has write access to a GitHub repository and to Confluence
  via configured tokens,
When a documentation-sync PR is created and any Confluence pages are updated,
Then the PR branch, commit message, PR title, PR description, and all
  Confluence edit payloads shall contain no secrets, API tokens, or values
  matching the pattern of common secret formats (as enforced by the
  `secret-scan.sh` pre-tool hook).

**AC-8** (covers NFR-3)
Given the GitHub API or Confluence API is unreachable when the pipeline
  attempts an operation,
When the API call fails,
Then the pipeline shall log a structured error to stdout with a non-zero exit
  code,
And the repository working tree, any in-progress branch, and any partial
  Confluence edit shall be left in the same state they were in before the
  pipeline run began.

**AC-9** (covers FR-11)
Given a merged PR adds a new exported TypeScript function that has no
  existing heading in `docs/*.md` or in any accessible Confluence page,
When the pipeline completes,
Then a skeleton documentation section shall have been created containing:
  (a) a Markdown heading that exactly matches the function name,
  (b) the function signature as a TypeScript fenced code block, and
  (c) the full JSDoc comment as body text,
And this new section shall be included in the consolidated doc-sync PR.
