/**
 * RollbackManager — registers and executes undo operations in LIFO order.
 *
 * This module provides the rollback facility used by every mutating component
 * in the pipeline. The register-then-mutate invariant (F-6) requires callers
 * to push an {@link RollbackEntry} onto the stack **immediately before** each
 * mutation, so that the undo closure captures the pre-mutation state.
 *
 * On any pipeline error, `PipelineOrchestrator` calls {@link RollbackManager.rollback}
 * which iterates the stack in LIFO order and invokes each undo. A failing undo
 * is caught, logged, and skipped — it does not abort remaining undos (NFR-3).
 *
 * @module rollback-manager
 */

import { RollbackEntry } from './types.js';

/**
 * Manages a LIFO stack of {@link RollbackEntry} objects that reverse mutations
 * made during a pipeline run.
 *
 * Usage pattern (register-then-mutate, F-6):
 * ```ts
 * rollbackManager.register({ description: 'restore file', undo: async () => { ... } });
 * await fs.writeFile(path, newContent);   // mutation happens AFTER register
 * ```
 */
export class RollbackManager {
  /** Internal LIFO stack of registered undo operations. */
  private readonly stack: RollbackEntry[] = [];

  /**
   * Pushes a rollback entry onto the internal undo stack.
   *
   * This method **must** be called immediately before the corresponding
   * mutation so that the undo closure captures all state necessary to reverse
   * the operation (register-then-mutate invariant, F-6). Undo closures must be
   * idempotent — invoking them twice must not cause additional side effects.
   *
   * @param entry - Describes the undo operation to register.
   */
  register(entry: RollbackEntry): void {
    this.stack.push(entry);
  }

  /**
   * Executes all registered undo operations in LIFO (last-in, first-out) order.
   *
   * Each `undo` closure is `await`-ed individually. If a closure throws or
   * rejects, the error is caught and reported via `console.error` using the
   * entry's `description` for context — the failure does **not** abort
   * remaining undos (NFR-3). All entries on the stack are attempted.
   *
   * @returns A `Promise` that resolves once every undo has been attempted,
   *   regardless of individual failures.
   */
  async rollback(): Promise<void> {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const entry = this.stack[i];
      try {
        await entry.undo();
      } catch (err) {
        console.error(
          `[RollbackManager] undo failed for "${entry.description}":`,
          err,
        );
      }
    }
  }
}
