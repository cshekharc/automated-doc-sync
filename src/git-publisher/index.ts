/**
 * GitPublisher — creates sync branches, writes documentation files, commits
 * and pushes, and opens GitHub pull requests with the regenerated diff.
 *
 * Environment variables consumed by this module:
 * - `GITHUB_TOKEN`: Personal access token or GitHub App installation token
 *   used to authenticate Octokit requests. Never logged (redactSecrets applied
 *   to all output).
 * - `GITHUB_REPOSITORY`: Repository slug in `"owner/repo"` format, e.g.
 *   `"acme/my-app"`.
 * - `GITHUB_REQUEST_TIMEOUT_MS`: Timeout in milliseconds for GitHub REST API
 *   calls (default: `30000`).
 *
 * Register-then-mutate invariant (F-6 / F-8): every method that mutates state
 * pushes its undo closure onto the supplied {@link RollbackManager} **before**
 * performing the mutation so that the undo captures the correct pre-mutation
 * state.
 *
 * @module git-publisher
 */

import { simpleGit, type SimpleGit } from 'simple-git';
import { Octokit } from '@octokit/rest';
import { writeFile, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import type { RollbackManager } from '../rollback-manager.js';
import type { PipelineResult } from '../types.js';
import { redactSecrets } from '../utils/redact-secrets.js';

/**
 * Publishes documentation changes to a GitHub branch and opens a pull request.
 *
 * Interacts with:
 * - `simple-git` for local git operations (branch creation, commits, pushes).
 * - `@octokit/rest` for GitHub API calls (PR creation).
 * - `fs/promises` for file-system writes.
 *
 * All state-mutating methods accept a {@link RollbackManager} parameter and
 * follow the register-then-mutate invariant (F-6): the undo closure is pushed
 * onto the stack immediately before the corresponding mutation.
 *
 * @example
 * ```typescript
 * const publisher = new GitPublisher();
 * await publisher.createSyncBranch('20260820T143000Z', rollback);
 * await publisher.writeDocFile('docs/api.md', newContent, rollback);
 * await publisher.commitAndPush(['myFunction'], triggerSha);
 * const prUrl = await publisher.createPR(pipelineResult);
 * ```
 */
export class GitPublisher {
  /** simple-git instance used for all local and remote git operations. */
  private readonly git: SimpleGit;

  /** Octokit instance authenticated via GITHUB_TOKEN. */
  private readonly octokit: Octokit;

  /** Owner portion of the `GITHUB_REPOSITORY` env var ("owner/repo"). */
  private readonly owner: string;

  /** Repository name portion of the `GITHUB_REPOSITORY` env var ("owner/repo"). */
  private readonly repoName: string;

  /** Current sync branch name; set by {@link createSyncBranch}. */
  private branchName: string;

  /**
   * Constructs a GitPublisher, reading credentials and repository coordinates
   * from the process environment.
   *
   * - `GITHUB_TOKEN` is passed to Octokit as the `auth` option and is never
   *   included in any log output.
   * - `GITHUB_REPOSITORY` must be formatted as `"owner/repo"`.
   */
  constructor() {
    this.git = simpleGit();

    // GITHUB_TOKEN: personal access token or GitHub App installation token
    const token = process.env['GITHUB_TOKEN'] ?? '';
    this.octokit = new Octokit({ auth: token });

    // GITHUB_REPOSITORY: "owner/repo" format (e.g. "acme/my-app")
    const repoStr = process.env['GITHUB_REPOSITORY'] ?? '/';
    const slashIdx = repoStr.indexOf('/');
    this.owner = slashIdx >= 0 ? repoStr.slice(0, slashIdx) : repoStr;
    this.repoName = slashIdx >= 0 ? repoStr.slice(slashIdx + 1) : '';
    this.branchName = '';
  }

  /**
   * Creates and checks out a new sync branch named `docs/sync-<timestamp>`.
   *
   * Registration sequence (register-then-mutate invariant, F-6):
   * 1. **Registers local branch-deletion undo** before `git checkout -b`.
   * 2. Creates the local branch via `git checkout -b docs/sync-<timestamp>`.
   * 3. **Registers remote branch-deletion undo** before any subsequent push
   *    operation (the undo is pre-registered here so that if a later push
   *    succeeds and the pipeline then fails, the remote branch is cleaned up).
   *
   * @param timestamp - UTC timestamp string appended to the branch name.
   *   Example: `"20260820T143000Z"` → branch `docs/sync-20260820T143000Z`.
   * @param rollback - Shared rollback manager for this pipeline run.
   */
  async createSyncBranch(timestamp: string, rollback: RollbackManager): Promise<void> {
    const branchName = `docs/sync-${timestamp}`;
    this.branchName = branchName;

    // 1. Register local branch-deletion undo BEFORE creating the branch (F-6).
    rollback.register({
      description: `delete local branch ${branchName}`,
      undo: async () => {
        await this.git.deleteLocalBranch(branchName, true);
      },
    });

    // 2. Create and check out the new local branch.
    await this.git.checkoutLocalBranch(branchName);

    // 3. Register remote branch-deletion undo BEFORE any push (F-6).
    rollback.register({
      description: `delete remote branch origin/${branchName}`,
      undo: async () => {
        await this.git.push(['origin', '--delete', branchName]);
      },
    });
  }

  /**
   * Writes `content` to `filePath`, pre-registering a `git checkout HEAD`
   * undo so the file can be restored to its last committed state on rollback.
   *
   * Register-then-mutate invariant (F-6): the undo closure is pushed onto the
   * rollback stack immediately before the file is written. Each file is
   * registered individually (not batched) so the stack reflects the actual
   * mutation order.
   *
   * @param filePath - Absolute or repo-relative path of the documentation file.
   * @param content - New file content to write.
   * @param rollback - Shared rollback manager for this pipeline run.
   */
  async writeDocFile(filePath: string, content: string, rollback: RollbackManager): Promise<void> {
    // Register git-restore undo BEFORE writing the file (F-6).
    rollback.register({
      description: `git checkout HEAD -- ${filePath}`,
      undo: async () => {
        await this.git.checkout(['HEAD', '--', filePath]);
      },
    });

    await writeFile(filePath, content, 'utf-8');
  }

  /**
   * Creates `filePath` as an empty file **only when it does not already exist**.
   *
   * If the file already exists the method returns immediately without
   * registering any undo or touching the file system.
   *
   * Register-then-mutate invariant (F-8): `fs.unlink` undo is pushed onto the
   * rollback stack before the empty file is created, capturing the "absent"
   * pre-mutation state.
   *
   * @param filePath - Absolute or repo-relative path of the new documentation file.
   * @param rollback - Shared rollback manager for this pipeline run.
   */
  async createDefaultDocFile(filePath: string, rollback: RollbackManager): Promise<void> {
    // If the file already exists do nothing — no mutation, no undo needed.
    if (existsSync(filePath)) {
      return;
    }

    // Register file-deletion undo BEFORE creating the file (F-8).
    rollback.register({
      description: `delete newly created file ${filePath}`,
      undo: async () => {
        await unlink(filePath);
      },
    });

    // Create empty file.
    await writeFile(filePath, '', 'utf-8');
  }

  /**
   * Stages all files under `docs/`, creates a commit, and pushes the sync
   * branch to `origin`.
   *
   * Commit message format: `docs: sync documentation for <fn1>, <fn2>, …`
   *
   * The remote branch-deletion undo was pre-registered in
   * {@link createSyncBranch} (register-then-mutate invariant, F-6), so no
   * additional rollback registration is performed here.
   *
   * @param affectedFunctions - Names of functions whose documentation was
   *   updated or scaffolded; used to form the commit message.
   * @param triggerSha - The merge commit SHA that triggered this run; included
   *   in log output only — not placed in the commit message.
   */
  async commitAndPush(affectedFunctions: string[], triggerSha: string): Promise<void> {
    // Stage everything under docs/
    await this.git.add('docs/');

    // Commit with a descriptive message
    const fnList = affectedFunctions.join(', ');
    await this.git.commit(`docs: sync documentation for ${fnList}`);

    console.log(
      redactSecrets(
        `[GitPublisher] pushing branch ${this.branchName} (trigger: ${triggerSha})`,
      ),
    );

    // Push branch to origin with upstream tracking
    await this.git.push('origin', this.branchName, ['--set-upstream']);
  }

  /**
   * Opens a GitHub pull request from the current sync branch targeting `main`.
   *
   * **PR title** (truncated to 72 characters):
   * `docs: sync documentation — <triggerCommitSha>`
   *
   * **PR body** includes:
   * - `Triggered-by: <sha>` line (NFR-6)
   * - `### Regenerated sections` list
   * - `### Scaffolded sections` list
   * - `### Known Limitations` section (notFound items)
   * - `<!-- doc-sync-meta: {"triggerSha":"...","confluenceDrafts":[...]} -->`
   *   HTML comment used by Workflow 2 to publish Confluence drafts on merge.
   *
   * The `reviewers` field is intentionally omitted per FR-6.
   *
   * Reads `GITHUB_REQUEST_TIMEOUT_MS` (default 30 000 ms) and applies it as an
   * `AbortController` signal on the Octokit request.
   *
   * @param result - The completed pipeline result providing metadata for the PR.
   * @returns The HTML URL of the newly created pull request.
   */
  async createPR(result: PipelineResult): Promise<string> {
    // Title: truncated to 72 characters
    const rawTitle = `docs: sync documentation — ${result.triggerCommitSha}`;
    const title = rawTitle.slice(0, 72);

    // Regenerated sections list
    const regeneratedLines =
      result.regenerated.length > 0
        ? result.regenerated
            .map(r => `- \`${r.name}\` (${r.target}: ${r.location})`)
            .join('\n')
        : '_none_';

    // Scaffolded sections list
    const scaffoldedLines =
      result.scaffolded.length > 0
        ? result.scaffolded
            .map(s => `- \`${s.name}\` (${s.target}: ${s.location})`)
            .join('\n')
        : '_none_';

    // Known Limitations list (notFound functions)
    const notFoundLines =
      result.notFound.length > 0
        ? result.notFound
            .map(n => `- \`${n.name}\` (${n.sourceFilePath})`)
            .join('\n')
        : '_none_';

    // doc-sync-meta block (consumed by Workflow 2 / ConfluencePublish)
    const metaJson = JSON.stringify({
      triggerSha: result.triggerCommitSha,
      confluenceDrafts: result.confluenceDraftPageIds,
    });

    const body = [
      `Triggered-by: ${result.triggerCommitSha}`,
      '',
      '### Regenerated sections',
      regeneratedLines,
      '',
      '### Scaffolded sections',
      scaffoldedLines,
      '',
      '### Known Limitations',
      notFoundLines,
      '',
      `<!-- doc-sync-meta: ${metaJson} -->`,
    ].join('\n');

    // GITHUB_REQUEST_TIMEOUT_MS: timeout in ms for this GitHub API call
    const timeoutMs = parseInt(process.env['GITHUB_REQUEST_TIMEOUT_MS'] ?? '30000', 10);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await this.octokit.pulls.create({
        owner: this.owner,
        repo: this.repoName,
        title,
        body,
        base: 'main',
        head: this.branchName,
        // reviewers intentionally omitted per FR-6
        request: { signal: controller.signal as AbortSignal },
      });

      const prUrl = response.data.html_url;
      console.log(redactSecrets(`[GitPublisher] created PR: ${prUrl}`));
      return prUrl;
    } finally {
      clearTimeout(timer);
    }
  }
}
