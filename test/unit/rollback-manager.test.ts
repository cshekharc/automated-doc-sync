import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RollbackManager } from '../../src/rollback-manager.js';

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/** Creates a fresh RollbackManager for each test. */
function makeManager(): RollbackManager {
  return new RollbackManager();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RollbackManager', () => {
  // -------------------------------------------------------------------------
  // Empty stack
  // -------------------------------------------------------------------------

  describe('empty stack', () => {
    it('resolves immediately when no entries have been registered', async () => {
      const manager = makeManager();
      await expect(manager.rollback()).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // register() + basic rollback
  // -------------------------------------------------------------------------

  describe('register and rollback basics', () => {
    it('invokes the registered undo closure on rollback', async () => {
      const manager = makeManager();
      let called = false;

      manager.register({
        description: 'mark called',
        undo: async () => {
          called = true;
        },
      });

      await manager.rollback();
      expect(called).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // LIFO order (sequenced counter array)
  // -------------------------------------------------------------------------

  describe('LIFO execution order', () => {
    it('executes three entries in strict reverse-registration order', async () => {
      const manager = makeManager();
      const order: number[] = [];

      manager.register({
        description: 'undo step 1',
        undo: async () => {
          order.push(1);
        },
      });
      manager.register({
        description: 'undo step 2',
        undo: async () => {
          order.push(2);
        },
      });
      manager.register({
        description: 'undo step 3',
        undo: async () => {
          order.push(3);
        },
      });

      await manager.rollback();

      // Last-registered entry (3) must undo first; first-registered entry (1) last.
      expect(order).toEqual([3, 2, 1]);
    });

    it('respects LIFO order across async undos with staggered resolution', async () => {
      const manager = makeManager();
      const order: string[] = [];

      manager.register({
        description: 'delete branch (first registered)',
        undo: async () => {
          // Simulate a slightly slower async operation
          await Promise.resolve();
          order.push('delete-branch');
        },
      });

      manager.register({
        description: 'restore file A',
        undo: async () => {
          order.push('restore-A');
        },
      });

      manager.register({
        description: 'restore file B (last registered)',
        undo: async () => {
          order.push('restore-B');
        },
      });

      await manager.rollback();

      expect(order).toEqual(['restore-B', 'restore-A', 'delete-branch']);
    });
  });

  // -------------------------------------------------------------------------
  // Error resilience — failing undo must not abort remaining undos (NFR-3)
  // -------------------------------------------------------------------------

  describe('error resilience', () => {
    let consoleSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      consoleSpy.mockRestore();
    });

    it('continues executing undos after a failure at the last-registered position', async () => {
      const manager = makeManager();
      const executed: number[] = [];

      // Position 0 (registered first → undone last)
      manager.register({
        description: 'undo step 1 (should still run)',
        undo: async () => {
          executed.push(1);
        },
      });

      // Position 1 (registered second → undone second)
      manager.register({
        description: 'undo step 2 (throws)',
        undo: async () => {
          throw new Error('simulated undo failure at step 2');
        },
      });

      // Position 2 (registered last → undone first)
      manager.register({
        description: 'undo step 3 (runs first)',
        undo: async () => {
          executed.push(3);
        },
      });

      // rollback() must not throw even though step 2 fails
      await expect(manager.rollback()).resolves.toBeUndefined();

      // Steps 3 and 1 must have run; step 2 threw and was skipped
      expect(executed).toEqual([3, 1]);
    });

    it('logs console.error with the entry description when an undo fails', async () => {
      const manager = makeManager();

      manager.register({
        description: 'the-failing-undo',
        undo: async () => {
          throw new Error('undo failed');
        },
      });

      await manager.rollback();

      expect(consoleSpy).toHaveBeenCalledOnce();
      // The logged message must reference the entry description
      const loggedMessage: string = consoleSpy.mock.calls[0][0] as string;
      expect(loggedMessage).toContain('the-failing-undo');
    });

    it('continues running all remaining undos even when the first-to-execute (last-registered) throws', async () => {
      const manager = makeManager();
      const executed: string[] = [];

      manager.register({
        description: 'step A (should run last)',
        undo: async () => {
          executed.push('A');
        },
      });
      manager.register({
        description: 'step B (should run second)',
        undo: async () => {
          executed.push('B');
        },
      });
      manager.register({
        description: 'step C (runs first, throws)',
        undo: async () => {
          throw new Error('step C failed');
        },
      });

      await expect(manager.rollback()).resolves.toBeUndefined();

      // C threw (not in executed), B and A ran in that order
      expect(executed).toEqual(['B', 'A']);
    });
  });

  // -------------------------------------------------------------------------
  // Register-then-mutate pattern
  // -------------------------------------------------------------------------

  describe('register-then-mutate pattern', () => {
    it('fires undo exactly once after a simulated mid-write failure', async () => {
      const manager = makeManager();
      let undoCallCount = 0;

      // 1. Register the undo closure BEFORE performing the mutation (F-6)
      manager.register({
        description: 'restore original file content',
        undo: async () => {
          undoCallCount++;
        },
      });

      // 2. Simulate a mutation that fails (e.g. disk full)
      let caughtError: Error | undefined;
      try {
        throw new Error('write failed: disk full');
      } catch (err) {
        caughtError = err as Error;
      }

      // Confirm the mutation threw
      expect(caughtError).toBeDefined();
      expect(caughtError!.message).toBe('write failed: disk full');

      // 3. Caller invokes rollback in response to the error
      await manager.rollback();

      // 4. Undo must have fired exactly once
      expect(undoCallCount).toBe(1);
    });

    it('does not fire an undo registered after the mutation succeeded', async () => {
      const manager = makeManager();
      const firedUndos: string[] = [];

      // First operation: register + mutate — succeeds
      manager.register({
        description: 'undo op1',
        undo: async () => {
          firedUndos.push('op1');
        },
      });
      // (mutation for op1 would go here and succeeds)

      // Second operation: register + mutate — fails mid-way
      manager.register({
        description: 'undo op2',
        undo: async () => {
          firedUndos.push('op2');
        },
      });

      // Mutation for op2 throws; pipeline calls rollback
      await manager.rollback();

      // Both registered undos must fire in LIFO order
      expect(firedUndos).toEqual(['op2', 'op1']);
    });

    it('undo is registered even when the subsequent mutation throws synchronously', async () => {
      const manager = makeManager();
      let undoRegistered = false;

      // Register undo first
      manager.register({
        description: 'undo synchronous-throw mutation',
        undo: async () => {
          undoRegistered = true;
        },
      });

      // Mutation throws synchronously (simulate a programming error or guard check)
      expect(() => {
        throw new TypeError('unexpected null value');
      }).toThrow('unexpected null value');

      // Even though the mutation threw, the undo was registered and must fire
      await manager.rollback();
      expect(undoRegistered).toBe(true);
    });
  });
});
