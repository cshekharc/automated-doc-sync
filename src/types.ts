/**
 * Shared cross-component type definitions for the Automated Documentation
 * Sync pipeline. All five types defined here cross at least two module
 * boundaries; they must remain free of circular imports.
 *
 * @module types
 */

/**
 * A single exported TypeScript function extracted from the diff.
 *
 * Overload handling: if the source file contains multiple declarations with
 * the same name (TypeScript overloads), they are collapsed to a single entry.
 * The {@link ExportedFunction.signature} field holds only the implementation
 * signature (last declaration). Overload-only signatures are not emitted.
 */
export interface ExportedFunction {
  /** Function name as it appears in source — used for exact heading match. */
  name: string;
  /**
   * Full TypeScript implementation signature string.
   * For overloaded functions this is the implementation signature only
   * (last declaration), e.g. `"export function parse(input: string | Buffer): number"`.
   */
  signature: string;
  /** Raw JSDoc comment text with `/** *\/` delimiters stripped. Empty string if absent. */
  jsdoc: string;
  /** Repo-relative path of the source file, e.g. `"src/utils.ts"`. */
  sourceFilePath: string;
  /** Whether the function was added in this commit or is an existing one that changed. */
  changeType: 'added' | 'modified';
}

/**
 * A documentation section found (or not found) for a function.
 *
 * When {@link DocSection.target} is `'not-found'`, all optional fields are
 * absent and {@link DocSection.sectionContent} is an empty string. Consumers
 * must check `target` before accessing any optional field.
 *
 * Character offsets ({@link DocSection.sectionStartOffset} /
 * {@link DocSection.sectionEndOffset}) address the raw file string directly so
 * that `SectionRegenerator` can perform a string-level splice without
 * re-serializing unchanged content (F-3 / AC-3).
 */
export interface DocSection {
  /** Name of the function this section documents. */
  functionName: string;
  /** Where the section was found, or `'not-found'` when no match exists. */
  target: 'markdown' | 'confluence' | 'not-found';
  /** Repo-relative path to the Markdown file. Set when `target === 'markdown'`. */
  markdownFilePath?: string;
  /** Numeric Confluence page ID string. Set when `target === 'confluence'`. */
  confluencePageId?: string;
  /** Confluence page title — for display in PR description only; not used for search. */
  confluencePageTitle?: string;
  /**
   * Version number of the currently published Confluence page.
   * The draft is written at `confluenceVersionNumber + 1`.
   * Set when `target === 'confluence'`.
   */
  confluenceVersionNumber?: number;
  /** Current raw section content (heading + body). Empty string when `target === 'not-found'`. */
  sectionContent: string;
  /**
   * Character offset (in the raw file string / XHTML string) of the first
   * character of the heading line. Used by `SectionRegenerator` for the
   * string-splice replacement:
   * `raw.slice(0, sectionStartOffset) + newContent + raw.slice(sectionEndOffset)`.
   */
  sectionStartOffset?: number;
  /**
   * Exclusive character offset of the first character of the line that begins
   * the next same-or-higher-level heading. The splice removes
   * `raw.slice(sectionStartOffset, sectionEndOffset)` and inserts the
   * regenerated section in its place.
   */
  sectionEndOffset?: number;
}

/**
 * Judgment returned by `DriftComparator` for a single
 * `(ExportedFunction, DocSection)` pair.
 *
 * - `'stale'`     — the section exists but does not match the current signature / JSDoc.
 * - `'current'`   — the section exactly matches the canonical rendering of the function.
 * - `'not-found'` — no documentation section exists for this function in any target.
 */
export type ComparisonResult = 'stale' | 'current' | 'not-found';

/**
 * One undoable operation registered with {@link RollbackManager} before its
 * corresponding mutation is performed.
 *
 * INVARIANT: the `undo` closure **must be pushed onto the rollback stack
 * immediately before — never after — the mutation it undoes** (register-then-
 * mutate invariant, F-6). Closures must capture all state needed to reverse
 * the mutation at registration time (e.g. original file content, version
 * number) rather than reading it lazily during `undo()`.
 */
export interface RollbackEntry {
  /** Human-readable description of the undo operation, used in error logs. */
  description: string;
  /**
   * Executes the undo. Must be idempotent — calling it twice must not cause
   * additional side effects or errors beyond the first invocation.
   */
  undo: () => Promise<void>;
}

/**
 * Final result emitted by `PipelineOrchestrator` as structured JSON on a
 * successful run. When `skipped` is `true` (idempotency early-exit, FR-10),
 * all array fields are empty and `prUrl` is `null`.
 */
export interface PipelineResult {
  /** SHA of the merge commit that triggered the pipeline run (NFR-6). */
  triggerCommitSha: string;
  /** Functions whose existing documentation sections were regenerated. */
  regenerated: Array<{ name: string; target: 'markdown' | 'confluence'; location: string }>;
  /** Newly added functions for which skeleton sections were scaffolded (FR-11). */
  scaffolded: Array<{ name: string; target: 'markdown' | 'confluence'; location: string }>;
  /**
   * Modified or added functions with no matching heading in any documentation
   * target. Listed under "Known Limitations" in the PR description (FR-8).
   */
  notFound: Array<{ name: string; sourceFilePath: string }>;
  /**
   * Confluence page IDs that now hold unpublished drafts. Embedded in the
   * `doc-sync-meta` HTML comment block in the PR body so that Workflow 2
   * (`doc-sync-publish.yml`) can publish them on PR merge (F-1).
   */
  confluenceDraftPageIds: string[];
  /** URL of the opened docs-sync PR, or `null` when `skipped` is `true`. */
  prUrl: string | null;
  /**
   * `true` when the pipeline exited early because a `docs/sync-*` PR for
   * the same trigger SHA already exists (idempotency guard, FR-10).
   */
  skipped: boolean;
}
