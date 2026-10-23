/**
 * Tests for issue #633: HookManager graceful error handling.
 *
 * Verifies that hook execution errors are caught, logged, and rethrown
 * (beforeInvoke) or logged and swallowed (afterInvoke), rather than
 * aborting silently without any log output.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { HookManager } from './hooks';
import { HookExecutionError, HookRecursionError } from './errors';
import type { BeforeInvokeContext, AfterInvokeContext } from './hooks';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeBeforeCtx(method = 'create_will'): BeforeInvokeContext {
  return {
    method,
    args: { will_id: BigInt(1) },
    timestamp: new Date().toISOString(),
  };
}

function makeAfterCtx(method = 'create_will'): AfterInvokeContext {
  return {
    method,
    args: { will_id: BigInt(1) },
    timestamp: new Date().toISOString(),
    txHash: 'abc123',
    error: null,
    durationMs: 42,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('#633 HookManager — graceful error handling', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── beforeInvoke ──────────────────────────────────────────────────────────

  describe('runBeforeInvoke', () => {
    it('wraps a throwing hook in HookExecutionError and rethrows', async () => {
      const manager = new HookManager();
      const cause = new Error('hook exploded');
      manager.onBeforeInvoke(() => {
        throw cause;
      });

      await expect(manager.runBeforeInvoke(makeBeforeCtx())).rejects.toBeInstanceOf(
        HookExecutionError,
      );
    });

    it('sets HookExecutionError.cause to the original error', async () => {
      const manager = new HookManager();
      const cause = new Error('original cause');
      manager.onBeforeInvoke(() => {
        throw cause;
      });

      let caught: HookExecutionError | null = null;
      try {
        await manager.runBeforeInvoke(makeBeforeCtx());
      } catch (err) {
        if (err instanceof HookExecutionError) caught = err;
      }

      expect(caught).not.toBeNull();
      expect(caught!.cause).toBe(cause);
      expect(caught!.hookName).toBe('beforeInvoke');
    });

    it('logs the error to console.error before rethrowing', async () => {
      const manager = new HookManager();
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      manager.onBeforeInvoke(() => {
        throw new Error('hook error');
      });

      await expect(manager.runBeforeInvoke(makeBeforeCtx('check_in'))).rejects.toThrow();

      expect(errorSpy).toHaveBeenCalledOnce();
      // The log must mention the method and contain enough context
      const [logMsg] = errorSpy.mock.calls[0]!;
      expect(String(logMsg)).toContain('check_in');
    });

    it('does not log when the hook succeeds', async () => {
      const manager = new HookManager();
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      manager.onBeforeInvoke(() => true);
      await manager.runBeforeInvoke(makeBeforeCtx());

      expect(errorSpy).not.toHaveBeenCalled();
    });

    it('does not execute subsequent hooks after one throws', async () => {
      const manager = new HookManager();
      const second = vi.fn();

      manager.onBeforeInvoke(() => {
        throw new Error('stop');
      });
      manager.onBeforeInvoke(second);

      vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(manager.runBeforeInvoke(makeBeforeCtx())).rejects.toThrow(HookExecutionError);
      expect(second).not.toHaveBeenCalled();
    });

    it('propagates HookRecursionError unwrapped (not wrapped in HookExecutionError)', async () => {
      const manager = new HookManager();

      // Simulate a recursive call by setting executing=true via a first call that
      // hasn't resolved yet, then fire a second call.
      manager.onBeforeInvoke(async () => {
        // Attempt re-entry
        await manager.runBeforeInvoke(makeBeforeCtx());
      });

      vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(manager.runBeforeInvoke(makeBeforeCtx())).rejects.toBeInstanceOf(
        HookRecursionError,
      );
    });

    it('releases the executing lock after a throw so subsequent calls work', async () => {
      const manager = new HookManager();
      vi.spyOn(console, 'error').mockImplementation(() => {});

      manager.onBeforeInvoke(() => {
        throw new Error('transient');
      });

      // First call throws
      await expect(manager.runBeforeInvoke(makeBeforeCtx())).rejects.toThrow();

      // Remove the bad hook so the second call can succeed
      manager.clear();
      manager.onBeforeInvoke(() => true);

      // Second call must not throw HookRecursionError (lock was released)
      await expect(manager.runBeforeInvoke(makeBeforeCtx())).resolves.toBe(true);
    });

    it('returns false when a hook explicitly returns false', async () => {
      const manager = new HookManager();
      manager.onBeforeInvoke(() => false);
      await expect(manager.runBeforeInvoke(makeBeforeCtx())).resolves.toBe(false);
    });

    it('returns true when all hooks pass', async () => {
      const manager = new HookManager();
      manager.onBeforeInvoke(() => true);
      manager.onBeforeInvoke(() => undefined);
      await expect(manager.runBeforeInvoke(makeBeforeCtx())).resolves.toBe(true);
    });
  });

  // ── afterInvoke ───────────────────────────────────────────────────────────

  describe('runAfterInvoke', () => {
    it('does not throw when an afterInvoke hook throws', async () => {
      const manager = new HookManager();
      manager.onAfterInvoke(() => {
        throw new Error('after hook exploded');
      });

      await expect(manager.runAfterInvoke(makeAfterCtx())).resolves.not.toThrow();
    });

    it('logs the afterInvoke error to console.error', async () => {
      const manager = new HookManager();
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      manager.onAfterInvoke(() => {
        throw new Error('after hook error');
      });

      await manager.runAfterInvoke(makeAfterCtx('release_inheritance'));

      expect(errorSpy).toHaveBeenCalledOnce();
      const [logMsg] = errorSpy.mock.calls[0]!;
      expect(String(logMsg)).toContain('release_inheritance');
    });

    it('runs all subsequent afterInvoke hooks even if one throws', async () => {
      const manager = new HookManager();
      const second = vi.fn();
      vi.spyOn(console, 'error').mockImplementation(() => {});

      manager.onAfterInvoke(() => {
        throw new Error('first fails');
      });
      manager.onAfterInvoke(second);

      await manager.runAfterInvoke(makeAfterCtx());

      expect(second).toHaveBeenCalledOnce();
    });

    it('propagates HookRecursionError unwrapped from afterInvoke', async () => {
      const manager = new HookManager();
      manager.onAfterInvoke(async () => {
        await manager.runAfterInvoke(makeAfterCtx());
      });

      vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(manager.runAfterInvoke(makeAfterCtx())).rejects.toBeInstanceOf(
        HookRecursionError,
      );
    });

    it('releases the executing lock after afterInvoke finishes, even with errors', async () => {
      const manager = new HookManager();
      vi.spyOn(console, 'error').mockImplementation(() => {});

      manager.onAfterInvoke(() => {
        throw new Error('transient');
      });

      await manager.runAfterInvoke(makeAfterCtx());

      // Lock must be released; second call must not throw HookRecursionError
      await expect(manager.runAfterInvoke(makeAfterCtx())).resolves.not.toThrow();
    });
  });
});
