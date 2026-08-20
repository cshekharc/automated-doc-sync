/**
 * ConfluencePublisher — thin typed wrapper around Confluence REST API v2.
 *
 * Handles authentication via `CONFLUENCE_API_TOKEN` environment variable
 * (never logged or written to files — NFR-2). All draft writes set
 * `status: "draft"` in the PUT body; the live page is never modified directly
 * by this module (F-1).
 *
 * **Register-then-mutate invariant (F-6):** {@link ConfluencePublisher.writeDraft}
 * registers the rollback undo closure on {@link RollbackManager} *before* issuing
 * the HTTP PUT so that the undo captures the pre-mutation state.
 *
 * **W-1 assumption:** The rollback undo uses `currentVersion` (not
 * `currentVersion + 1`) to restore the pre-draft published state. See
 * assumption A-7 in `docs/architecture.md` for the full rationale and the
 * note about the live Confluence API being inaccessible (403 licence
 * restriction) during development.
 *
 * Environment variables consumed:
 * - `CONFLUENCE_BASE_URL`            — Base URL of the Confluence instance,
 *   e.g. `"https://myorg.atlassian.net/wiki"`.
 * - `CONFLUENCE_API_TOKEN`           — API token for Basic auth. Read in the
 *   constructor; **never logged** (NFR-2). `redactSecrets` is applied to every
 *   string passed to `console.log` or `console.error`.
 * - `CONFLUENCE_REQUEST_TIMEOUT_MS`  — HTTP request timeout in milliseconds.
 *   Defaults to `30000` (F-10).
 *
 * @module confluence-publisher
 */

import axios from 'axios';
import type { RollbackManager } from '../rollback-manager.js';
import { redactSecrets } from '../utils/redact-secrets.js';

/**
 * Publishes documentation changes to Confluence as unpublished drafts and
 * provides a rollback path that restores pages to their pre-draft published
 * state.
 *
 * All state-mutating methods accept a {@link RollbackManager} and follow the
 * register-then-mutate invariant (F-6): the undo closure is pushed onto the
 * stack *immediately before* the corresponding HTTP mutation.
 *
 * @example
 * ```typescript
 * const publisher = new ConfluencePublisher();
 * const { body, version } = await publisher.fetchPage('32833537');
 * await publisher.writeDraft('32833537', updatedHtml, version, rollback);
 * ```
 */
export class ConfluencePublisher {
  /**
   * Base URL of the Confluence instance.
   * Sourced from `CONFLUENCE_BASE_URL` environment variable.
   */
  private readonly baseUrl: string;

  /**
   * API token used for Basic auth: `Authorization: Basic <base64(":" + token)>`.
   * Sourced from `CONFLUENCE_API_TOKEN`; **never logged or written to files** (NFR-2).
   */
  private readonly token: string;

  /**
   * HTTP request timeout in milliseconds applied to every axios call (F-10).
   * Sourced from `CONFLUENCE_REQUEST_TIMEOUT_MS`; defaults to `30000`.
   */
  private readonly timeout: number;

  /**
   * Constructs a ConfluencePublisher, reading all configuration from the
   * process environment at construction time.
   *
   * Environment variables read:
   * - `CONFLUENCE_BASE_URL` — base URL of the Confluence instance.
   * - `CONFLUENCE_API_TOKEN` — API token; stored but **never logged** (NFR-2).
   * - `CONFLUENCE_REQUEST_TIMEOUT_MS` — request timeout in ms (default 30 000).
   */
  constructor() {
    // CONFLUENCE_BASE_URL: base URL of the Confluence instance
    this.baseUrl = process.env['CONFLUENCE_BASE_URL'] ?? '';
    // CONFLUENCE_API_TOKEN: API token for Basic auth; never logged (NFR-2)
    this.token = process.env['CONFLUENCE_API_TOKEN'] ?? '';
    // CONFLUENCE_REQUEST_TIMEOUT_MS: HTTP request timeout in milliseconds; default 30000
    this.timeout = parseInt(process.env['CONFLUENCE_REQUEST_TIMEOUT_MS'] ?? '30000', 10);
  }

  /**
   * Builds the `Authorization: Basic` header value for the configured token.
   *
   * Atlassian headless-auth format: `base64(":" + token)` (empty username,
   * token as the password field).  The returned string contains the Base64
   * blob which **must** be passed through {@link redactSecrets} before any
   * logging to prevent token leakage (NFR-2).
   *
   * @returns `"Basic <base64(\":\" + CONFLUENCE_API_TOKEN)>"`
   */
  private buildAuthHeader(): string {
    const encoded = Buffer.from(':' + this.token).toString('base64');
    return `Basic ${encoded}`;
  }

  /**
   * Fetches a Confluence page's body (storage format), current version number,
   * and title via `GET /api/v2/pages/{pageId}?body-format=storage`.
   *
   * Authentication: `Authorization: Basic <base64(":" + CONFLUENCE_API_TOKEN)>`
   * Timeout: `CONFLUENCE_REQUEST_TIMEOUT_MS` env var, default 30 000 ms.
   *
   * All console output is passed through {@link redactSecrets} so that the
   * Base64-encoded auth blob (≥ 40 chars) is replaced with `[REDACTED]`
   * before being written to stdout (NFR-2).
   *
   * @param pageId - Numeric Confluence page ID string, e.g. `"32833537"`.
   * @returns An object containing:
   *   - `body`    — raw XHTML storage-format page body.
   *   - `version` — current published version number.
   *   - `title`   — page title.
   */
  async fetchPage(pageId: string): Promise<{ body: string; version: number; title: string }> {
    const authHeader = this.buildAuthHeader();

    // Log the outgoing request; pass auth header through redactSecrets so the
    // Base64 blob (≥ 40 chars) is replaced with [REDACTED] before stdout (NFR-2).
    console.log(
      redactSecrets(
        `[ConfluencePublisher] GET ${this.baseUrl}/api/v2/pages/${pageId}?body-format=storage` +
          ` auth=${authHeader}`,
      ),
    );

    const response = await axios.get(
      `${this.baseUrl}/api/v2/pages/${pageId}?body-format=storage`,
      {
        headers: { Authorization: authHeader },
        timeout: this.timeout,
      },
    );

    // Loosely typed to handle partial or unknown API shapes.
    const data = response.data as {
      title?: string;
      version?: { number?: number };
      body?: { storage?: { value?: string } };
    };

    const title = data.title ?? '';
    const version = data.version?.number ?? 0;
    const body = data.body?.storage?.value ?? '';

    console.log(
      redactSecrets(
        `[ConfluencePublisher] fetched page ${pageId} title="${title}" version=${version}`,
      ),
    );

    return { body, version, title };
  }

  /**
   * Writes updated HTML content to a Confluence page as an **unpublished draft**.
   *
   * **Register-then-mutate sequence (F-6, W-1):**
   * 1. Fetches the current page body via {@link fetchPage} — this body is
   *    captured in the undo closure so rollback can restore it.
   * 2. **Calls `rollback.register(...)` before issuing the PUT.** The undo
   *    closure calls {@link revertToPublished} with the pre-draft `originalBody`
   *    and `currentVersion`.
   * 3. Issues `PUT /api/v2/pages/{pageId}` with `status: "draft"` and
   *    `version.number: currentVersion + 1`.  Because `status: "draft"`, the
   *    published page is left untouched — readers continue to see the prior
   *    version until Workflow 2 publishes the draft (F-1).
   *
   * **W-1 note on rollback version:** The undo closure uses `currentVersion`
   * (not `currentVersion + 1`) when calling {@link revertToPublished}.  This is
   * because the rollback must restore the *previously published* state, not
   * advance to a new version. The Confluence Cloud draft API is assumed to save
   * the draft at `currentVersion + 1` without altering the published page; to
   * discard the draft, the undo PUT sends the original content at
   * `currentVersion` with `status: "current"`.  See assumption A-7 in
   * `docs/architecture.md`.  Since the live API was inaccessible during
   * development (403 licence restriction), this version semantics is documented
   * as an assumption rather than a verified fact.
   *
   * @param pageId        - Numeric Confluence page ID string.
   * @param updatedHtml   - New storage-format XHTML body content for the page.
   * @param currentVersion - Current version number of the published page
   *   (obtained from {@link fetchPage} or {@link DocSection.confluenceVersionNumber}).
   * @param rollback      - Shared rollback manager for this pipeline run.
   */
  async writeDraft(
    pageId: string,
    updatedHtml: string,
    currentVersion: number,
    rollback: RollbackManager,
  ): Promise<void> {
    // Step 1 — Fetch original body so the undo closure can restore it.
    const { body: originalBody } = await this.fetchPage(pageId);

    // Step 2 — Register undo BEFORE issuing the PUT (register-then-mutate, F-6).
    //
    // W-1: The undo uses `currentVersion` (not `currentVersion + 1`).
    // The draft is written at version currentVersion + 1; to discard the draft
    // and restore the published state, the undo PUT sends the original content
    // at currentVersion with status "current".  This is based on the assumed
    // Confluence Cloud draft API behaviour documented in A-7 of
    // docs/architecture.md (live API inaccessible — 403 licence restriction).
    rollback.register({
      description:
        `revert Confluence page ${pageId} draft to published state ` +
        `(restoring version ${currentVersion})`,
      undo: async () => {
        await this.revertToPublished(pageId, originalBody, currentVersion);
      },
    });

    // Step 3 — Issue PUT with status "draft"; published page is unchanged (F-1).
    await axios.put(
      `${this.baseUrl}/api/v2/pages/${pageId}`,
      {
        id: pageId,
        status: 'draft',
        version: { number: currentVersion + 1 },
        body: {
          storage: {
            value: updatedHtml,
            representation: 'storage',
          },
        },
      },
      {
        headers: {
          Authorization: this.buildAuthHeader(),
          'Content-Type': 'application/json',
        },
        timeout: this.timeout,
      },
    );

    console.log(
      redactSecrets(
        `[ConfluencePublisher] saved draft for page ${pageId} at version ${currentVersion + 1}`,
      ),
    );
  }

  /**
   * Reverts a Confluence page to its published state by issuing a PUT with
   * `status: "current"` and the pre-draft version number.
   *
   * This method is used exclusively as the undo closure registered by
   * {@link writeDraft} (register-then-mutate invariant, F-6).
   *
   * **W-1 version semantics:** `rollbackVersion` must be the *original*
   * published version (i.e. `currentVersion` at the time {@link writeDraft}
   * was called, **not** `currentVersion + 1`).  The undo PUT sends the
   * original content at that version with `status: "current"`, which is assumed
   * to discard the draft and restore the previously published state according to
   * Confluence Cloud's draft API behaviour.  The live Confluence API was
   * inaccessible during development (403 licence restriction); this behaviour is
   * documented as an assumption in A-7 of `docs/architecture.md`.
   *
   * @param pageId          - Numeric Confluence page ID string.
   * @param originalBody    - Storage-format XHTML body captured before the draft
   *   was written; this content is restored by the PUT.
   * @param rollbackVersion - Version number of the pre-draft published state
   *   (equals `currentVersion` at the time {@link writeDraft} was called).
   */
  async revertToPublished(
    pageId: string,
    originalBody: string,
    rollbackVersion: number,
  ): Promise<void> {
    await axios.put(
      `${this.baseUrl}/api/v2/pages/${pageId}`,
      {
        id: pageId,
        status: 'current',
        version: { number: rollbackVersion },
        body: {
          storage: {
            value: originalBody,
            representation: 'storage',
          },
        },
      },
      {
        headers: {
          Authorization: this.buildAuthHeader(),
          'Content-Type': 'application/json',
        },
        timeout: this.timeout,
      },
    );

    console.log(
      redactSecrets(
        `[ConfluencePublisher] reverted page ${pageId} to published state ` +
          `(version ${rollbackVersion})`,
      ),
    );
  }
}
