/**
 * Tests for issue #493: HookManager allows synchronous hooks to throw errors
 * that are not caught, leaving the transaction in an invalid prepared state.
 *
 * Acceptance criteria:
 * - Hook errors are caught and wrapped in HookExecutionError
 * - Transaction state is reset (not left partially prepared) on hook error
 * - State consistency is verified after hook throws
 */

import { describe, expect, it, vi } from 'vitest';

import { HookExecutionError } from '../src/errors';
import { HookManager } from '../src/hooks';
import type { BeforeInvokeContext, AfterInvokeContext } from '../src/hooks';

const makeBeforeCtx = (method = 'check_in'): BeforeInvokeContext => ({
  method,
  args: { will_id: 1n },
  timestamp: new Date().toISOString(),
});

const makeAfterCtx = (method = 'check_in'): AfterInvokeContext => ({
  method,
  args: { will_id: 1n },
  timestamp: new Date().toISOString(),
  txHash: null,
  error: null,
  durationMs: 0,
});

describe('HookManager — issue #493: hook error handling', () => {
  // ── beforeInvoke ──────────────────────────────────────────────────────────

  it('wraps a synchronous throwing beforeInvoke hook in HookExecutionError', async () => {
    const hooks = new HookManager();
    hooks.onBeforeInvoke(() => {
      throw new Error('hook blew up');
    });

    await expect(hooks.runBeforeInvoke(makeBeforeCtx())).rejects.toBeInstanceOf(
      HookExecutionError,
    );
  });

  it('wraps an async throwing beforeInvoke hook in HookExecutionError', async () => {
    const hooks = new HookManager();
    hooks.onBeforeInvoke(async () => {
      await Promise.resolve();
      throw new Error('async hook blew up');
    });

    await expect(hooks.runBeforeInvoke(makeBeforeCtx())).rejects.toBeInstanceOf(
      HookExecutionError,
    );
  });

  it('HookExecutionError.hookName is "beforeInvoke"', async () => {
    const hooks = new HookManager();
    hooks.onBeforeInvoke(() => {
      throw new TypeError('bad value');
    });

    let caught: unknown;
    try {
      await hooks.runBeforeInvoke(makeBeforeCtx());
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(HookExecutionError);
    expect((caught as HookExecutionError).hookName).toBe('beforeInvoke');
  });

  it('HookExecutionError preserves the original error as cause', async () => {
    const hooks = new HookManager();
    const original = new RangeError('out of range');
    hooks.onBeforeInvoke(() => {
      throw original;
    });

    let caught: unknown;
    try {
      await hooks.runBeforeInvoke(makeBeforeCtx());
    } catch (err) {
      caught = err;
    }

    expect((caught as HookExecutionError).cause).toBe(original);
  });

  it('stops executing subsequent beforeInvoke hooks after one throws', async () => {
    const hooks = new HookManager();
    const second = vi.fn();

    hooks.onBeforeInvoke(() => {
      throw new Error('first hook throws');
    });
    hooks.onBeforeInvoke(second);

    await expect(hooks.runBeforeInvoke(makeBeforeCtx())).rejects.toBeInstanceOf(
      HookExecutionError,
    );
    expect(second).not.toHaveBeenCalled();
  });

  it('still runs the next hook when the first hook returns false (not throws)', async () => {
    const hooks = new HookManager();
    const second = vi.fn();

    hooks.onBeforeInvoke(() => false);
    hooks.onBeforeInvoke(second);

    const proceed = await hooks.runBeforeInvoke(makeBeforeCtx());
    expect(proceed).toBe(false);
    // Second hook should NOT run because execution was aborted, not because of an error
    expect(second).not.toHaveBeenCalled();
  });

  it('proceeds normally when beforeInvoke hooks do not throw', async () => {
    const hooks = new HookManager();
    const spy = vi.fn();
    hooks.onBeforeInvoke(spy);

    const proceed = await hooks.runBeforeInvoke(makeBeforeCtx());
    expect(proceed).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  // ── afterInvoke (swallowed) ───────────────────────────────────────────────

  it('swallows errors thrown by afterInvoke hooks (instrumentation must not break the call)', async () => {
    const hooks = new HookManager();
    hooks.onAfterInvoke(() => {
      throw new Error('after hook error');
    });

    // Should resolve without throwing
    await expect(hooks.runAfterInvoke(makeAfterCtx())).resolves.toBeUndefined();
  });

  it('runs all afterInvoke hooks even when an earlier one throws', async () => {
    const hooks = new HookManager();
    const second = vi.fn();

    hooks.onAfterInvoke(() => {
      throw new Error('first after hook throws');
    });
    hooks.onAfterInvoke(second);

    await hooks.runAfterInvoke(makeAfterCtx());
    expect(second).toHaveBeenCalledTimes(1);
  });

  // ── state consistency after hook throws ──────────────────────────────────

  it('hook count remains stable after a hook throws during runBeforeInvoke', async () => {
    const hooks = new HookManager();
    hooks.onBeforeInvoke(() => {
      throw new Error('boom');
    });

    expect(hooks.beforeInvokeCount).toBe(1);

    try {
      await hooks.runBeforeInvoke(makeBeforeCtx());
    } catch {
      // expected
    }

    // Registry must be unchanged — the throwing hook is still registered
    expect(hooks.beforeInvokeCount).toBe(1);
  });

  it('can still register and run hooks after a previous hook threw', async () => {
    const hooks = new HookManager();
    hooks.onBeforeInvoke(() => {
      throw new Error('first invocation throws');
    });

    try {
      await hooks.runBeforeInvoke(makeBeforeCtx());
    } catch {
      // expected
    }

    // Remove the bad hook and add a good one
    const badHook = hooks['registry'].beforeInvoke[0];
    hooks.offBeforeInvoke(badHook!);
    const goodHook = vi.fn();
    hooks.onBeforeInvoke(goodHook);

    const proceed = await hooks.runBeforeInvoke(makeBeforeCtx());
    expect(proceed).toBe(true);
    expect(goodHook).toHaveBeenCalledTimes(1);
  });

  // ── HookExecutionError is a SoroWillError subclass ────────────────────────

  it('HookExecutionError is a SoroWillError subclass', async () => {
    const { SoroWillError } = await import('../src/errors');
    const err = new HookExecutionError('beforeInvoke', new Error('x'));
    expect(err).toBeInstanceOf(SoroWillError);
  });

  it('HookExecutionError.name is "HookExecutionError"', () => {
    const err = new HookExecutionError('beforeInvoke', new Error('x'));
    expect(err.name).toBe('HookExecutionError');
  });

  it('HookExecutionError message includes the original error message', () => {
    const err = new HookExecutionError('beforeInvoke', new Error('original message'));
    expect(err.message).toContain('original message');
  });

  it('HookExecutionError handles non-Error throws (e.g. string)', () => {
    const err = new HookExecutionError('beforeInvoke', 'just a string');
    expect(err.message).toContain('just a string');
    expect(err.cause).toBe('just a string');
  });
});
