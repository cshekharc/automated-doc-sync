/**
 * PipelineOrchestrator — entry point for Workflow 1 (doc-sync.yml).
 *
 * Sequences all documentation-sync components in the order defined in
 * architecture §4:
 * 1. {@link RollbackManager} initialisation.
 * 2. {@link validateTrigger} — validates the GitHub merge event, performs
 *    the idempotency check and Confluence pre-flight validation.
 * 3. {@link detectDrift} — extracts changed exported functions from the diff.
 * 4. Per-function: {@link locateMarkdownSection} / {@link locateConfluenceSection}.
 * 5. Per-function: {@link compareDrift} for each (function, section) pair.
 * 6. Markdown update pass: stale sections regenerated; added functions
 *    scaffolded; modified functions with no docs recorded as not-found.
 * 7. Confluence update pass: stale and newly scaffolded sections written as
 *    unpublished drafts via {@link ConfluencePublisher.writeDraft}.
 * 8. {@link GitPublisher.commitAndPush} — commits and pushes the sync branch.
 * 9. {@link GitPublisher.createPR} — opens the documentation review PR.
 * 10. Emits a {@link PipelineResult} JSON object to stdout; all strings are
 *     passed through {@link redactSecrets} to prevent credential leakage (F-12).
 *
 * Environment variables consumed by sub-modules (documented in their
 * respective modules):
 * - `GITHUB_EVENT_PATH`, `GITHUB_SHA`, `GITHUB_REPOSITORY`, `GITHUB_TOKEN`
 * - `CONFLUENCE_BASE_URL`, `CONFLUENCE_API_TOKEN`, `CONFLUENCE_PAGE_ID`
 * - `CONFLUENCE_HEADING_LEVEL`, `CONFLUENCE_REQUEST_TIMEOUT_MS`
 * - `GITHUB_REQUEST_TIMEOUT_MS`, `DOCS_DEFAULT_FILE`
 *
 * @module pipeline
 */

import { readFile } from 'fs/promises';
import { RollbackManager } from './rollback-manager.js';
import { validateTrigger } from './trigger-validator.js';
import { detectDrift } from './drift-detector/index.js';
import {
  locateMarkdownSection,
  locateConfluenceSection,
  resolveScaffoldTarget,
} from './doc-locator/index.js';
import { compareDrift } from './drift-comparator.js';
import {
  regenerateMarkdownSection,
  regenerateConfluenceSection,
  buildScaffoldSection,
  buildConfluenceScaffoldSection,
} from './regenerator/index.js';
import { ConfluencePublisher } from './confluence-publisher/index.js';
import { GitPublisher } from './git-publisher/index.js';
import { redactSecrets } from './utils/redact-secrets.js';
import type { PipelineResult } from './types.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Formats a `Date` as a compact UTC timestamp string suitable for use in a
 * sync branch name, e.g. `"20260820T143000Z"`.
 *
 * @param date - The date to format. Defaults to `new Date()`.
 * @returns Timestamp string in `YYYYMMDDTHHmmssZ` format.
 */
function formatTimestamp(date: Date = new Date()): string {
  // "2026-08-20T14:30:00.000Z"
  // → remove hyphens → "20260820T14:30:00.000Z"
  // → remove colons  → "20260820T143000.000Z"
  // → strip .mmm     → "20260820T143000Z"
  return date
    .toISOString()
    .replace(/-/g, '')
    .replace(/:/g, '')
    .replace(/\.\d+Z$/, 'Z');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Runs the full documentation-sync pipeline (Workflow 1).
 *
 * Orchestrates all pipeline components in the order defined in architecture §4.
 * Owns the single outer `try/catch`; on any unhandled error the pipeline:
 * 1. Awaits `RollbackManager.rollback()` to undo all registered mutations.
 * 2. Writes a structured `{ error: "..." }` JSON to `process.stderr`, with
 *    all strings passed through {@link redactSecrets} (F-12).
 * 3. Calls `process.exit(1)`.
 *
 * On success the pipeline writes a {@link PipelineResult} JSON to
 * `process.stdout` (all strings through `redactSecrets`) and returns.
 *
 * On idempotency skip: {@link validateTrigger} calls `process.exit(0)` before
 * this function returns. In production this terminates the process immediately
 * and the `catch` block never fires. In tests where `process.exit` is mocked
 * to throw, the pipeline detects the zero-exit signal in the catch block and
 * returns without calling `RollbackManager.rollback`.
 *
 * @returns A `Promise<void>` that resolves on success or never resolves
 *   when the process terminates via `process.exit`.
 */
export async function run(): Promise<void> {
  // Step 1 — Initialise rollback manager.
  const rollback = new RollbackManager();

  try {
    // -------------------------------------------------------------------------
    // Step 2 — Validate trigger and obtain pipeline context.
    // -------------------------------------------------------------------------
    const ctx = await validateTrigger(rollback);
    const { mergeSha, changedFiles } = ctx;

    // -------------------------------------------------------------------------
    // Step 3 — Detect drift in changed TypeScript source files.
    // -------------------------------------------------------------------------
    const driftedFunctions = await detectDrift(changedFiles, mergeSha);

    // Initialise publishers before any mutation.
    const gitPublisher = new GitPublisher();
    const confluencePublisher = new ConfluencePublisher();

    // Create the sync branch before any file mutations so its undo is registered
    // first on the rollback stack (LIFO order ensures the branch is deleted last
    // during rollback, after all file-write undos have been processed).
    const timestamp = formatTimestamp();
    await gitPublisher.createSyncBranch(timestamp, rollback);

    // -------------------------------------------------------------------------
    // Accumulate the pipeline result.
    // -------------------------------------------------------------------------
    const result: PipelineResult = {
      triggerCommitSha: mergeSha,
      regenerated: [],
      scaffolded: [],
      notFound: [],
      confluenceDraftPageIds: [],
      prUrl: null,
      skipped: false,
    };

    /** Function names that were mutated (regenerated or scaffolded). */
    const affectedFunctionNames: string[] = [];

    // -------------------------------------------------------------------------
    // Steps 4–7 — Process each drifted function.
    // -------------------------------------------------------------------------
    for (const fn of driftedFunctions) {
      // Step 4a — Locate the existing Markdown documentation section.
      const markdownSection = await locateMarkdownSection(fn.name);
      // Step 4b — Locate the existing Confluence documentation section.
      const confluenceSection = await locateConfluenceSection(fn.name, fn.sourceFilePath);

      // Step 5 — Compare drift for each section.
      const mdComparison = compareDrift(fn, markdownSection);
      const cfComparison = compareDrift(fn, confluenceSection);

      // -----------------------------------------------------------------------
      // Step 6 — Markdown update pass.
      // -----------------------------------------------------------------------
      if (mdComparison === 'stale') {
        // Stale section: regenerate in-place via raw-string splice.
        const rawFile = await readFile(markdownSection.markdownFilePath!, 'utf-8');
        const updatedContent = regenerateMarkdownSection(rawFile, markdownSection, fn);
        await gitPublisher.writeDocFile(markdownSection.markdownFilePath!, updatedContent, rollback);
        result.regenerated.push({
          name: fn.name,
          target: 'markdown',
          location: markdownSection.markdownFilePath!,
        });
        if (!affectedFunctionNames.includes(fn.name)) {
          affectedFunctionNames.push(fn.name);
        }
      } else if (mdComparison === 'not-found') {
        if (fn.changeType === 'added') {
          // Added function: scaffold a new section at the resolved target path.
          const scaffoldTargetPath = resolveScaffoldTarget(fn.sourceFilePath);
          await gitPublisher.createDefaultDocFile(scaffoldTargetPath, rollback);
          const existingContent = await readFile(scaffoldTargetPath, 'utf-8').catch(() => '');
          const scaffoldContent = buildScaffoldSection(fn);
          // Ensure a newline separator between existing content and the scaffold.
          const separator =
            existingContent.length > 0 && !existingContent.endsWith('\n') ? '\n' : '';
          const updatedContent = existingContent + separator + scaffoldContent;
          await gitPublisher.writeDocFile(scaffoldTargetPath, updatedContent, rollback);
          result.scaffolded.push({
            name: fn.name,
            target: 'markdown',
            location: scaffoldTargetPath,
          });
          if (!affectedFunctionNames.includes(fn.name)) {
            affectedFunctionNames.push(fn.name);
          }
        } else {
          // Modified function with no existing docs: record as not-found.
          result.notFound.push({
            name: fn.name,
            sourceFilePath: fn.sourceFilePath,
          });
        }
      }
      // 'current' → documentation is up to date; no action required.

      // -----------------------------------------------------------------------
      // Step 7 — Confluence update pass.
      // -----------------------------------------------------------------------
      if (cfComparison === 'stale' && confluenceSection.confluencePageId !== undefined) {
        // Stale Confluence section: fetch full XHTML, regenerate, write draft.
        const { body: rawXhtml } = await confluencePublisher.fetchPage(
          confluenceSection.confluencePageId,
        );
        const updatedXhtml = regenerateConfluenceSection(rawXhtml, confluenceSection, fn);
        await confluencePublisher.writeDraft(
          confluenceSection.confluencePageId,
          updatedXhtml,
          confluenceSection.confluenceVersionNumber ?? 0,
          rollback,
        );
        result.regenerated.push({
          name: fn.name,
          target: 'confluence',
          location: confluenceSection.confluencePageId,
        });
        if (!result.confluenceDraftPageIds.includes(confluenceSection.confluencePageId)) {
          result.confluenceDraftPageIds.push(confluenceSection.confluencePageId);
        }
        if (!affectedFunctionNames.includes(fn.name)) {
          affectedFunctionNames.push(fn.name);
        }
      } else if (cfComparison === 'not-found' && fn.changeType === 'added') {
        // Added function with no Confluence section: scaffold if a page is configured.
        // CONFLUENCE_PAGE_ID: fallback page ID for scaffold targets (optional).
        const cfPageId = process.env['CONFLUENCE_PAGE_ID'];
        if (cfPageId) {
          const { body: rawXhtml, version } = await confluencePublisher.fetchPage(cfPageId);
          const scaffoldContent = buildConfluenceScaffoldSection(fn);
          // Append the scaffold section to the end of the existing page XHTML.
          const updatedXhtml = rawXhtml + scaffoldContent;
          await confluencePublisher.writeDraft(cfPageId, updatedXhtml, version, rollback);
          result.scaffolded.push({
            name: fn.name,
            target: 'confluence',
            location: cfPageId,
          });
          if (!result.confluenceDraftPageIds.includes(cfPageId)) {
            result.confluenceDraftPageIds.push(cfPageId);
          }
          if (!affectedFunctionNames.includes(fn.name)) {
            affectedFunctionNames.push(fn.name);
          }
        }
      }
    }

    // -------------------------------------------------------------------------
    // Step 8 — Commit and push the sync branch.
    // -------------------------------------------------------------------------
    await gitPublisher.commitAndPush(affectedFunctionNames, mergeSha);

    // -------------------------------------------------------------------------
    // Step 9 — Open the documentation review pull request.
    // -------------------------------------------------------------------------
    const prUrl = await gitPublisher.createPR(result);
    result.prUrl = prUrl;

    // -------------------------------------------------------------------------
    // Step 10 — Emit PipelineResult as structured JSON to stdout.
    // All strings are passed through redactSecrets (F-12).
    // -------------------------------------------------------------------------
    console.log(redactSecrets(JSON.stringify(result)));
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);

    // In production, process.exit(0) from validateTrigger (idempotency skip)
    // terminates the process immediately and this catch block is never reached.
    // In tests where process.exit is mocked to throw, the pipeline detects a
    // zero-exit signal here and returns without calling rollback — matching the
    // production behaviour where no mutations have been registered at that point.
    if (errMsg === 'process.exit(0)') {
      return;
    }

    await rollback.rollback();
    console.error(redactSecrets(JSON.stringify({ error: errMsg })));
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Script entry-point guard — only call run() when this file is the main script.
// process.argv[1] is the path of the executed file; it ends with "pipeline.js"
// when compiled and run via `node dist/pipeline.js`, or "pipeline.ts" during
// ts-node / tsx execution. Tests import this module directly and their
// argv[1] never matches, so run() is not invoked during testing.
// ---------------------------------------------------------------------------
const _execPath = process.argv[1] ?? '';
if (_execPath.endsWith('pipeline.js') || _execPath.endsWith('pipeline.ts')) {
  run().catch(() => {
    // run() handles all errors internally. This .catch is a last-resort safety
    // net for any unhandled rejection that escapes the internal try/catch.
    process.exit(1);
  });
}
