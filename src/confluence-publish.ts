/**
 * ConfluencePublish — entry point for Workflow 2.
 *
 * Reads the merged PR body via the GitHub REST API, extracts the
 * `<!-- doc-sync-meta: {...} -->` HTML comment written by Workflow 1
 * (GitPublisher.createPR), and publishes every Confluence draft page
 * listed in `confluenceDrafts` by issuing a `PUT /wiki/api/v2/pages/{id}`
 * with `status: "current"`.
 *
 * W-2 approval condition: every page ID is cross-referenced against the
 * configured allowlist (values from `docs/confluence-map.json` plus
 * `CONFLUENCE_PAGE_ID` env var) before any PUT is issued.  IDs not on the
 * allowlist are logged with `CONFLUENCE_PAGE_NOT_ALLOWLISTED` and skipped.
 *
 * Environment variables consumed by this module:
 * - `GITHUB_TOKEN`: GitHub API authentication token (never logged).
 * - `GITHUB_REPOSITORY`: repository slug in `"owner/repo"` format.
 * - `GITHUB_PR_NUMBER`: integer number of the merged pull request.
 * - `CONFLUENCE_BASE_URL`: Confluence Cloud base URL
 *   (e.g. `"https://example.atlassian.net"`).
 * - `CONFLUENCE_API_TOKEN`: Atlassian Cloud API token used for Basic auth;
 *   encoded as `Basic base64(":" + token)` per Atlassian's headless-auth
 *   scheme.  Never logged (redactSecrets applied to all output).
 * - `CONFLUENCE_REQUEST_TIMEOUT_MS`: timeout in milliseconds for every
 *   Confluence API call (default: `30000`).
 * - `CONFLUENCE_PAGE_ID`: optional additional page ID to include in the
 *   allowlist alongside the values already present in
 *   `docs/confluence-map.json`.
 *
 * @module confluence-publish
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import axios from 'axios';
import { Octokit } from '@octokit/rest';
import { redactSecrets } from './utils/redact-secrets.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Regex that matches the doc-sync-meta HTML comment in a PR body. */
const META_BLOCK_REGEX = /<!--\s*doc-sync-meta:\s*(\{.+?\})\s*-->/s;

/**
 * Structured shape of the JSON payload embedded in the `doc-sync-meta` block.
 *
 * The `confluenceDrafts` field carries the ordered list of Confluence page
 * IDs that were transitioned to `status: "draft"` by Workflow 1 and are
 * now ready to publish.
 */
interface DocSyncMeta {
  /** Confluence page IDs to publish (transition from draft to current). */
  confluenceDrafts?: string[];
  /** The git SHA that triggered Workflow 1. */
  triggerSha?: string;
}

/**
 * Minimal shape of the Confluence page object returned by
 * `GET /wiki/api/v2/pages/{id}`.
 */
interface ConfluencePage {
  /** Publish status: `"current"` for published, `"draft"` for unpublished. */
  status: string;
  /** Current version information. */
  version: { number: number };
  /** Page title (required in PUT payload). */
  title: string;
}

// ---------------------------------------------------------------------------
// Public exports
// ---------------------------------------------------------------------------

/**
 * Entry point for Workflow 2.  Reads the body of the merged pull request,
 * parses the `<!-- doc-sync-meta: {...} -->` block written by Workflow 1,
 * and publishes every Confluence draft page listed in `confluenceDrafts`.
 *
 * Processing pipeline per page ID:
 * 1. Cross-reference against the allowlist (W-2); skip with
 *    `CONFLUENCE_PAGE_NOT_ALLOWLISTED` warning if not present.
 * 2. `GET /wiki/api/v2/pages/{id}` — verify `status === "draft"` before
 *    proceeding; skip with informational log if not draft.
 * 3. `PUT /wiki/api/v2/pages/{id}` with `{ status: "current",
 *    version: { number: currentVersion + 1 } }` — log structured success
 *    result on completion.
 *
 * On fatal errors (missing / malformed meta block) a structured error is
 * written to stderr and the process exits with code 1.
 *
 * @returns Resolves when all eligible draft pages have been processed.
 */
export async function publishConfluenceDrafts(): Promise<void> {
  // -------------------------------------------------------------------------
  // 1. Read merged PR body via GitHub REST API
  // -------------------------------------------------------------------------

  // GITHUB_TOKEN: GitHub API authentication token for Octokit
  const githubToken = process.env['GITHUB_TOKEN'] ?? '';
  // GITHUB_REPOSITORY: repository slug "owner/repo"
  const repoStr = process.env['GITHUB_REPOSITORY'] ?? '/';
  // GITHUB_PR_NUMBER: integer PR number of the merged pull request
  const prNumberStr = process.env['GITHUB_PR_NUMBER'] ?? '';

  const slashIdx = repoStr.indexOf('/');
  const owner = slashIdx >= 0 ? repoStr.slice(0, slashIdx) : repoStr;
  const repo = slashIdx >= 0 ? repoStr.slice(slashIdx + 1) : '';
  const pull_number = parseInt(prNumberStr, 10);

  const octokit = new Octokit({ auth: githubToken });

  const { data: pr } = await octokit.pulls.get({ owner, repo, pull_number });
  const prBody = pr.body ?? '';

  // -------------------------------------------------------------------------
  // 2. Extract and parse the doc-sync-meta block
  // -------------------------------------------------------------------------

  const metaMatch = prBody.match(META_BLOCK_REGEX);
  if (!metaMatch) {
    console.error(
      redactSecrets(
        JSON.stringify({
          level: 'error',
          code: 'DOC_SYNC_META_NOT_FOUND',
          message: 'doc-sync-meta HTML comment block not found in PR body',
        }),
      ),
    );
    process.exit(1);
    return; // guards against execution continuing when process.exit is mocked
  }

  let meta: DocSyncMeta;
  try {
    meta = JSON.parse(metaMatch[1]) as DocSyncMeta;
  } catch {
    console.error(
      redactSecrets(
        JSON.stringify({
          level: 'error',
          code: 'DOC_SYNC_META_MALFORMED',
          message: 'doc-sync-meta block contains invalid JSON',
          raw: metaMatch[1],
        }),
      ),
    );
    process.exit(1);
    return; // guards against execution continuing when process.exit is mocked
  }

  const confluenceDrafts: string[] = meta.confluenceDrafts ?? [];

  // Early exit if there are no draft pages to publish.
  if (confluenceDrafts.length === 0) {
    console.log(
      redactSecrets(
        JSON.stringify({
          level: 'info',
          code: 'NO_CONFLUENCE_DRAFTS',
          message: 'No Confluence draft page IDs found in doc-sync-meta; nothing to publish',
        }),
      ),
    );
    return;
  }

  // -------------------------------------------------------------------------
  // 3. Build the allowlist from docs/confluence-map.json + env var (W-2)
  // -------------------------------------------------------------------------

  const allowlist = new Set<string>();

  const mapPath = join(process.cwd(), 'docs', 'confluence-map.json');
  try {
    const mapContent = await readFile(mapPath, 'utf-8');
    const map = JSON.parse(mapContent) as Record<string, string>;
    for (const [key, value] of Object.entries(map)) {
      // Skip the metadata comment key; only add real page-ID string values
      if (key !== '_comment' && typeof value === 'string') {
        allowlist.add(value);
      }
    }
  } catch {
    console.warn(
      redactSecrets(
        JSON.stringify({
          level: 'warn',
          code: 'CONFLUENCE_MAP_LOAD_FAILED',
          message: 'Could not load docs/confluence-map.json; allowlist will use only CONFLUENCE_PAGE_ID env var',
          mapPath,
        }),
      ),
    );
  }

  // CONFLUENCE_PAGE_ID: optional additional page ID included in the allowlist
  const envPageId = process.env['CONFLUENCE_PAGE_ID'];
  if (envPageId) {
    allowlist.add(envPageId);
  }

  // -------------------------------------------------------------------------
  // 4. Process each draft page ID
  // -------------------------------------------------------------------------

  // CONFLUENCE_BASE_URL: Confluence Cloud base URL
  const baseUrl = (process.env['CONFLUENCE_BASE_URL'] ?? '').replace(/\/$/, '');
  // CONFLUENCE_API_TOKEN: Atlassian Cloud API token for Basic auth (never logged)
  const apiToken = process.env['CONFLUENCE_API_TOKEN'] ?? '';
  // CONFLUENCE_REQUEST_TIMEOUT_MS: timeout in ms for each Confluence API call
  const timeoutMs = parseInt(process.env['CONFLUENCE_REQUEST_TIMEOUT_MS'] ?? '30000', 10);

  // Atlassian headless-auth format: Basic base64(":" + token)
  const authHeader = `Basic ${Buffer.from(`:${apiToken}`).toString('base64')}`;

  for (const pageId of confluenceDrafts) {
    // W-2: allowlist check — skip any page ID not in the configured set
    if (!allowlist.has(pageId)) {
      console.warn(
        redactSecrets(
          JSON.stringify({
            level: 'warn',
            code: 'CONFLUENCE_PAGE_NOT_ALLOWLISTED',
            pageId,
            message: `Page ID "${pageId}" is not in the configured allowlist; skipping`,
          }),
        ),
      );
      continue;
    }

    // GET the current page state to confirm it is still in draft status
    let page: ConfluencePage;
    try {
      const getResp = await axios.get<ConfluencePage>(
        `${baseUrl}/api/v2/pages/${pageId}`,
        {
          headers: { Authorization: authHeader },
          timeout: timeoutMs,
        },
      );
      page = getResp.data;
    } catch (err) {
      console.error(
        redactSecrets(
          JSON.stringify({
            level: 'error',
            code: 'CONFLUENCE_GET_FAILED',
            pageId,
            message: `Failed to GET Confluence page "${pageId}"`,
          }),
        ),
      );
      continue;
    }

    // Only proceed if the page is still a draft
    if (page.status !== 'draft') {
      console.log(
        redactSecrets(
          JSON.stringify({
            level: 'info',
            code: 'CONFLUENCE_PAGE_NOT_DRAFT',
            pageId,
            status: page.status,
            message: `Page "${pageId}" has status "${page.status}" (expected "draft"); skipping`,
          }),
        ),
      );
      continue;
    }

    // PUT to transition the draft to "current" (published)
    const nextVersion = page.version.number + 1;
    try {
      await axios.put(
        `${baseUrl}/api/v2/pages/${pageId}`,
        {
          status: 'current',
          title: page.title,
          version: { number: nextVersion },
        },
        {
          headers: {
            Authorization: authHeader,
            'Content-Type': 'application/json',
          },
          timeout: timeoutMs,
        },
      );

      console.log(
        redactSecrets(
          JSON.stringify({
            level: 'info',
            code: 'CONFLUENCE_PAGE_PUBLISHED',
            pageId,
            version: nextVersion,
            message: `Successfully published Confluence page "${pageId}" at version ${nextVersion}`,
          }),
        ),
      );
    } catch (err) {
      console.error(
        redactSecrets(
          JSON.stringify({
            level: 'error',
            code: 'CONFLUENCE_PUT_FAILED',
            pageId,
            message: `Failed to PUT (publish) Confluence page "${pageId}"`,
          }),
        ),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Script entry point
// ---------------------------------------------------------------------------

// Run publishConfluenceDrafts when this file is invoked directly as a script
// (e.g. `node dist/confluence-publish.js`).  The filename check prevents
// auto-execution when the module is imported by tests or other modules.
const runAsMain =
  process.argv[1] !== undefined &&
  process.argv[1].replace(/\\/g, '/').endsWith('confluence-publish.js');

if (runAsMain) {
  publishConfluenceDrafts().catch((err: unknown) => {
    console.error(
      redactSecrets(err instanceof Error ? err.message : String(err)),
    );
    process.exit(1);
  });
}
