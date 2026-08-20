/**
 * TriggerValidator — validates the incoming GitHub webhook event, performs
 * an idempotency check, a branch-protection pre-check, and a Confluence
 * pre-flight parse validation before the documentation sync pipeline runs.
 *
 * Performs these steps in order:
 * 1. Validates that the event is a merged pull request (FR-1).
 * 2. Idempotency check — scans open `docs/sync-*` PRs for a matching
 *    `Triggered-by:` SHA; exits 0 if found (FR-10, F-5).
 * 3. Branch protection pre-check on `main` — logs a warning when push
 *    restrictions are detected; does not exit (R-5).
 * 4. Confluence pre-flight parse validation — counts headings in the
 *    configured page; exits 1 if the body is non-empty but has no headings
 *    (Step 2a, F-7).
 * 5. Fetches the list of `.ts` files changed in the merge commit and
 *    returns a `TriggerContext` for downstream pipeline stages.
 *
 * Environment variables consumed:
 * - `GITHUB_EVENT_PATH`         — path to the GitHub Actions event JSON file.
 * - `GITHUB_SHA`                — SHA of the merge commit.
 * - `GITHUB_REPOSITORY`         — repository slug `"owner/repo"`.
 * - `GITHUB_TOKEN`              — personal access token for Octokit; **never logged** (NFR-2).
 * - `CONFLUENCE_PAGE_ID`        — (optional) Confluence page ID for pre-flight check.
 * - `CONFLUENCE_HEADING_LEVEL`  — (optional) heading level to count; defaults to `"h2"`.
 *
 * All console output is passed through {@link redactSecrets} to prevent
 * credential leakage in CI logs (NFR-2, F-12).
 *
 * @module trigger-validator
 */

import { readFileSync } from 'fs';
import { Octokit } from '@octokit/rest';
import type { RollbackManager } from './rollback-manager.js';
import { ConfluencePublisher } from './confluence-publisher/index.js';
import { redactSecrets } from './utils/redact-secrets.js';

/**
 * Context object returned by {@link validateTrigger} after all pre-flight
 * checks pass successfully.
 */
export interface TriggerContext {
  /**
   * SHA of the merge commit that triggered the workflow.
   * Sourced from `GITHUB_SHA`.
   */
  mergeSha: string;
  /**
   * Parent SHA of the merge commit, formatted as `mergeSha + "^1"`.
   * Passed to `DriftDetector` as the base ref for `git diff`.
   */
  baseSha: string;
  /**
   * Repository-relative paths of TypeScript source files changed in the
   * merge commit; filtered to files matching `src/**\/*.ts`.
   */
  changedFiles: string[];
  /**
   * Repository owner parsed from `GITHUB_REPOSITORY` (`"owner/repo"` format).
   */
  owner: string;
  /**
   * Repository name parsed from `GITHUB_REPOSITORY` (`"owner/repo"` format).
   */
  repo: string;
}

/**
 * Validates the incoming GitHub event and runs all pre-flight checks required
 * before the documentation sync pipeline makes any mutations.
 *
 * Validation steps performed in order:
 * 1. **Merge event check** — reads `GITHUB_EVENT_PATH`, verifies
 *    `pull_request.merged === true`; calls `process.exit(1)` with a structured
 *    `{ error: "NOT_A_MERGED_PR" }` log if not (FR-1).
 * 2. **Idempotency check** — paginates open PRs via Octokit, filters to those
 *    whose `head.ref` starts with `"docs/sync-"`, and checks their bodies for
 *    `"Triggered-by: <GITHUB_SHA>"`. Calls `process.exit(0)` with a structured
 *    `{ skipped: true, reason: "DUPLICATE_PR" }` log if a duplicate is found
 *    (FR-10, F-5).
 * 3. **Branch protection pre-check** — calls
 *    `GET /repos/{owner}/{repo}/branches/main/protection` via Octokit; logs a
 *    warning when push restrictions are detected (does **not** exit — R-5).
 * 4. **Confluence pre-flight validation** — instantiates `ConfluencePublisher`
 *    and calls `fetchPage(CONFLUENCE_PAGE_ID)`; counts headings at
 *    `CONFLUENCE_HEADING_LEVEL` (default `"h2"`). Calls `process.exit(1)` with
 *    `{ error: "CONFLUENCE_PARSE_VALIDATION_FAILED" }` when the body is
 *    non-empty and the heading count is zero (Step 2a, F-7).
 *    Skips (with a warning) when `CONFLUENCE_PAGE_ID` is not set.
 * 5. **Changed-file list** — fetches `GET /repos/{owner}/{repo}/commits/<SHA>`
 *    via Octokit and filters the returned files to `src/**\/*.ts` paths.
 *
 * @param rollback - Shared {@link RollbackManager} for the pipeline run.
 *   Reserved for validation steps that may require undo capability in future
 *   extensions; not used in the current implementation since all steps here
 *   are read-only.
 * @returns A {@link TriggerContext} containing the merge SHA, base SHA,
 *   filtered changed-file list, repository owner, and repository name.
 */
export async function validateTrigger(rollback: RollbackManager): Promise<TriggerContext> {
  // Suppress unused-parameter warning: rollback is reserved for future
  // validation steps that require undo support.
  void rollback;

  // ---------------------------------------------------------------------------
  // Step 1 — Validate merge event (FR-1)
  // ---------------------------------------------------------------------------

  // GITHUB_EVENT_PATH: filesystem path to the GitHub Actions event JSON file
  const eventPath = process.env['GITHUB_EVENT_PATH'] ?? '';
  const rawEvent = readFileSync(eventPath, 'utf-8');
  const eventData = JSON.parse(rawEvent) as Record<string, unknown>;
  const prData = eventData['pull_request'] as Record<string, unknown> | undefined;

  if (prData?.['merged'] !== true) {
    console.error(redactSecrets(JSON.stringify({ error: 'NOT_A_MERGED_PR' })));
    process.exit(1);
  }

  // GITHUB_SHA: SHA of the merge commit that triggered the workflow
  const mergeSha = process.env['GITHUB_SHA'] ?? '';

  // GITHUB_REPOSITORY: repository slug "owner/repo" (e.g. "acme/my-app")
  const repoStr = process.env['GITHUB_REPOSITORY'] ?? '/';
  const slashIdx = repoStr.indexOf('/');
  const owner = slashIdx >= 0 ? repoStr.slice(0, slashIdx) : repoStr;
  const repo = slashIdx >= 0 ? repoStr.slice(slashIdx + 1) : '';

  // GITHUB_TOKEN: personal access token or GitHub App installation token; never logged (NFR-2)
  const token = process.env['GITHUB_TOKEN'] ?? '';
  const octokit = new Octokit({ auth: token });

  // ---------------------------------------------------------------------------
  // Step 2 — Idempotency check (FR-10, F-5)
  // ---------------------------------------------------------------------------

  let idempotencyPage = 1;
  while (true) {
    const { data: openPrs } = await octokit.pulls.list({
      owner,
      repo,
      state: 'open',
      per_page: 100,
      page: idempotencyPage,
    });

    // Filter client-side to the small subset of docs/sync-* PRs (F-5)
    for (const openPr of openPrs) {
      if (
        openPr.head.ref.startsWith('docs/sync-') &&
        openPr.body?.includes(`Triggered-by: ${mergeSha}`)
      ) {
        const existingPrUrl = openPr.html_url;
        console.log(
          redactSecrets(
            JSON.stringify({ skipped: true, reason: 'DUPLICATE_PR', existingPrUrl }),
          ),
        );
        process.exit(0);
      }
    }

    if (openPrs.length < 100) break;
    idempotencyPage++;
  }

  // ---------------------------------------------------------------------------
  // Step 3 — Branch protection pre-check (R-5)
  // ---------------------------------------------------------------------------

  try {
    const { data: protection } = await octokit.repos.getBranchProtection({
      owner,
      repo,
      branch: 'main',
    });

    const protData = protection as unknown as { restrictions?: unknown };
    if (protData.restrictions) {
      console.log(
        redactSecrets(
          JSON.stringify({
            warning: 'BRANCH_PROTECTION_RESTRICTIONS',
            message:
              'Branch protection restrictions detected on main; docs/sync-* branches may be affected',
          }),
        ),
      );
    }
  } catch {
    // Branch protection may not be configured or credentials lack the required
    // permission — not a hard error; log and continue.
    console.log(
      redactSecrets(
        JSON.stringify({
          warning: 'BRANCH_PROTECTION_CHECK_SKIPPED',
          message:
            'Branch protection check skipped (not configured or insufficient permissions)',
        }),
      ),
    );
  }

  // ---------------------------------------------------------------------------
  // Step 4 — Pre-flight Confluence parse validation (Step 2a, F-7)
  // ---------------------------------------------------------------------------

  // CONFLUENCE_PAGE_ID: Confluence page ID for pre-flight validation (optional)
  const confluencePageId = process.env['CONFLUENCE_PAGE_ID'];

  if (confluencePageId) {
    const publisher = new ConfluencePublisher();
    const { body } = await publisher.fetchPage(confluencePageId);

    // CONFLUENCE_HEADING_LEVEL: heading level to count; defaults to "h2"
    const headingLevel = process.env['CONFLUENCE_HEADING_LEVEL'] ?? 'h2';
    const headingRegex = new RegExp(`<${headingLevel}[^>]*>`, 'gi');
    const headingCount = (body.match(headingRegex) ?? []).length;

    if (body.length > 0 && headingCount === 0) {
      console.error(
        redactSecrets(JSON.stringify({ error: 'CONFLUENCE_PARSE_VALIDATION_FAILED' })),
      );
      process.exit(1);
    }
  } else {
    console.log(
      redactSecrets(
        JSON.stringify({
          warning: 'CONFLUENCE_PAGE_ID_NOT_SET',
          message: 'CONFLUENCE_PAGE_ID not configured; skipping pre-flight Confluence validation',
        }),
      ),
    );
  }

  // ---------------------------------------------------------------------------
  // Step 5 — Get changed files
  // ---------------------------------------------------------------------------

  const { data: commit } = await octokit.repos.getCommit({
    owner,
    repo,
    ref: mergeSha,
  });

  const changedFiles = (commit.files ?? [])
    .map(f => f.filename ?? '')
    .filter(f => f.startsWith('src/') && f.endsWith('.ts'));

  return {
    mergeSha,
    baseSha: `${mergeSha}^1`,
    changedFiles,
    owner,
    repo,
  };
}
