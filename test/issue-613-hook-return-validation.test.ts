/**
 * Tests for issue #613: HookManager doesn't validate hook return values.
 *
 * Acceptance criteria:
 * - Hook return value validation
 * - Clear error for invalid returns
 * - Test covers null/undefined returns
 */

import { describe, expect, it, vi } from 'vitest';

import { HookReturnValueError } from '../src/errors';
import { HookManager } from '../src/hooks';
import type { BeforeInvokeContext, BeforeInvokeHook } from '../src/hooks';

const makeCtx = (): BeforeInvokeContext => ({
  method: 'check_in',
  args: { will_id: 1n },
  timestamp: new Date().toISOString(),
});

describe('HookManager — issue #613: hook return value validation', () => {
  it('treats an undefined return as "proceed"', async () => {
    const hooks = new HookManager();
    hooks.onBeforeInvoke(() => undefined);
    await expect(hooks.runBeforeInvoke(makeCtx())).resolves.toBe(true);
  });

  it('treats an async undefined return as "proceed"', async () => {
    const hooks = new HookManager();
    hooks.onBeforeInvoke(async () => {});
    await expect(hooks.runBeforeInvoke(makeCtx())).resolves.toBe(true);
  });

  it('accepts explicit true and false returns', async () => {
    const proceed = new HookManager();
    proceed.onBeforeInvoke(() => true);
    await expect(proceed.runBeforeInvoke(makeCtx())).resolves.toBe(true);

    const abort = new HookManager();
    abort.onBeforeInvoke(() => false);
    await expect(abort.runBeforeInvoke(makeCtx())).resolves.toBe(false);
  });

  it('rejects a null return with HookReturnValueError', async () => {
    const hooks = new HookManager();
    hooks.onBeforeInvoke((() => null) as unknown as BeforeInvokeHook);
    await expect(hooks.runBeforeInvoke(makeCtx())).rejects.toBeInstanceOf(HookReturnValueError);
  });

  it('rejects an async null return with HookReturnValueError', async () => {
    const hooks = new HookManager();
    hooks.onBeforeInvoke((async () => null) as unknown as BeforeInvokeHook);
    await expect(hooks.runBeforeInvoke(makeCtx())).rejects.toBeInstanceOf(HookReturnValueError);
  });

  it.each([0, 1, 'yes', {}, []])('rejects a non-boolean return (%j)', async (value) => {
    const hooks = new HookManager();
    hooks.onBeforeInvoke((() => value) as unknown as BeforeInvokeHook);
    await expect(hooks.runBeforeInvoke(makeCtx())).rejects.toBeInstanceOf(HookReturnValueError);
  });

  it('exposes the hook name and invalid value with a clear message', async () => {
    const hooks = new HookManager();
    hooks.onBeforeInvoke((() => null) as unknown as BeforeInvokeHook);

    const err = await hooks.runBeforeInvoke(makeCtx()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HookReturnValueError);
    const typed = err as HookReturnValueError;
    expect(typed.hookName).toBe('beforeInvoke');
    expect(typed.returnValue).toBeNull();
    expect(typed.message).toContain('returned an invalid value: null');
    expect(typed.message).toContain('true or undefined');
  });

  it('does not run later hooks after an invalid return', async () => {
    const hooks = new HookManager();
    const later = vi.fn();
    hooks.onBeforeInvoke((() => null) as unknown as BeforeInvokeHook);
    hooks.onBeforeInvoke(later);
    await expect(hooks.runBeforeInvoke(makeCtx())).rejects.toBeInstanceOf(HookReturnValueError);
    expect(later).not.toHaveBeenCalled();
  });

  it('rejects non-function hooks at registration time', () => {
    const hooks = new HookManager();
    expect(() => hooks.onBeforeInvoke(null as unknown as BeforeInvokeHook)).toThrow(TypeError);
    expect(() => hooks.onAfterInvoke(undefined as unknown as () => void)).toThrow(TypeError);
    expect(hooks.beforeInvokeCount).toBe(0);
    expect(hooks.afterInvokeCount).toBe(0);
  });
});
