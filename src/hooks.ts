import { HookExecutionError } from './errors';

/**
 * Contains all information about the contract call about to be made.
 */
export interface BeforeInvokeContext {
  /** The contract method name being invoked (e.g. 'create_will'). */
  method: string;
  /** The arguments being passed to the contract method. */
  args: Record<string, unknown>;
  /** ISO-8601 timestamp of when the invocation was initiated. */
  timestamp: string;
}

/**
 * Context object passed to afterInvoke hooks.
 * Contains the result or error of the completed contract call.
 */
export interface AfterInvokeContext {
  /** The contract method name that was invoked. */
  method: string;
  /** The arguments that were passed to the contract method. */
  args: Record<string, unknown>;
  /** ISO-8601 timestamp of when the invocation completed. */
  timestamp: string;
  /** The transaction hash, if the invocation succeeded. */
  txHash: string | null;
  /** The error message, if the invocation failed. */
  error: string | null;
  /** Wall-clock duration of the invocation in milliseconds. */
  durationMs: number;
}

/**
 * A function that runs before a contract call is submitted.
 * Return `false` to abort the invocation, or `void` to proceed.
 */
export type BeforeInvokeHook = (ctx: BeforeInvokeContext) => boolean | void | Promise<boolean | void>;

/**
 * A function that runs after a contract call completes (success or failure).
 */
export type AfterInvokeHook = (ctx: AfterInvokeContext) => void | Promise<void>;

/**
 * Registered hooks for before/after invoke events.
 */
export interface HookRegistry {
  beforeInvoke: BeforeInvokeHook[];
  afterInvoke: AfterInvokeHook[];
}

/**
 * Manages beforeInvoke and afterInvoke hooks for a {@link SoroWillClient}.
 *
 * @example
 * ```ts
 * const hooks = new HookManager();
 *
 * hooks.onBeforeInvoke((ctx) => {
 *   console.log(`Calling ${ctx.method}`, ctx.args);
 * });
 *
 * hooks.onAfterInvoke((ctx) => {
 *   console.log(`${ctx.method} completed in ${ctx.durationMs}ms`);
 * });
 *
 * const client = new SoroWillClient({ network: 'testnet', contractId: '...', hooks });
 * ```
 */
export class HookManager {
  private readonly registry: HookRegistry = {
    beforeInvoke: [],
    afterInvoke: [],
  };
  private isExecutingBeforeInvoke = false;
  private isExecutingAfterInvoke = false;

  /** Register a hook that runs before every contract invocation. */
  onBeforeInvoke(hook: BeforeInvokeHook): void {
    this.registry.beforeInvoke.push(hook);
  }

  /** Register a hook that runs after every contract invocation. */
  onAfterInvoke(hook: AfterInvokeHook): void {
    this.registry.afterInvoke.push(hook);
  }

  /** Remove all occurrences of a previously registered beforeInvoke hook. */
  offBeforeInvoke(hook: BeforeInvokeHook): void {
    let idx = this.registry.beforeInvoke.indexOf(hook);
    while (idx !== -1) {
      this.registry.beforeInvoke.splice(idx, 1);
      idx = this.registry.beforeInvoke.indexOf(hook);
    }
  }

  /** Remove all occurrences of a previously registered afterInvoke hook. */
  offAfterInvoke(hook: AfterInvokeHook): void {
    let idx = this.registry.afterInvoke.indexOf(hook);
    while (idx !== -1) {
      this.registry.afterInvoke.splice(idx, 1);
      idx = this.registry.afterInvoke.indexOf(hook);
    }
  }

  /** Remove all registered hooks. */
  clear(): void {
    this.registry.beforeInvoke.length = 0;
    this.registry.afterInvoke.length = 0;
  }

  /** @internal Run all beforeInvoke hooks. Returns `false` if any hook aborted.
   * If any hook throws or triggers recursive `runBeforeInvoke` execution, the
   * error is wrapped in a `HookExecutionError` and re-thrown immediately. The
   * transaction is not built or submitted when a hook throws — the client
   * state is unchanged.
   */
  async runBeforeInvoke(ctx: BeforeInvokeContext): Promise<boolean> {
    if (this.isExecutingBeforeInvoke || this.isExecutingAfterInvoke) {
      throw new HookExecutionError(
        'beforeInvoke',
        new Error(
          `Recursive beforeInvoke hook execution detected while invoking "${ctx.method}". ` +
            'A hook must not trigger another operation on the same HookManager.',
        ),
      );
    }

    this.isExecutingBeforeInvoke = true;
    try {
      for (const hook of this.registry.beforeInvoke) {
        let result: boolean | void;
        try {
          result = await hook(ctx);
        } catch (err) {
          if (err instanceof HookExecutionError) {
            throw err;
          }
          throw new HookExecutionError('beforeInvoke', err);
        }
        if (result === false) return false;
      }
      return true;
    } finally {
      this.isExecutingBeforeInvoke = false;
    }
  }

  /**
   * @internal Run all afterInvoke hooks. A throwing hook is swallowed rather
   * than propagated — afterInvoke hooks are instrumentation/observability
   * side effects, and a broken one must never convert an otherwise-successful
   * (or already-failed) invocation into a different outcome for the caller.
   * Every hook still runs exactly once, in order, even if an earlier one throws.
   * Re-entrant hook execution from within an `afterInvoke` hook is rejected
   * with a `HookExecutionError` to prevent infinite recursion.
   */
  async runAfterInvoke(ctx: AfterInvokeContext): Promise<void> {
    if (this.isExecutingAfterInvoke || this.isExecutingBeforeInvoke) {
      throw new HookExecutionError(
        'afterInvoke',
        new Error(
          `Recursive afterInvoke hook execution detected while invoking "${ctx.method}". ` +
            'A hook must not trigger another operation on the same HookManager.',
        ),
      );
    }

    this.isExecutingAfterInvoke = true;
    try {
      for (const hook of this.registry.afterInvoke) {
        try {
          await hook(ctx);
        } catch (err) {
          if (err instanceof HookExecutionError) {
            throw err;
          }
          // Intentionally ignored — see method doc.
        }
      }
    } finally {
      this.isExecutingAfterInvoke = false;
    }
  }

  /**
   * Executes registered hooks for the given context (or phase and context)
   * with recursion detection.
   */
  async execute(ctx: BeforeInvokeContext): Promise<boolean>;
  async execute(phase: 'beforeInvoke', ctx: BeforeInvokeContext): Promise<boolean>;
  async execute(phase: 'afterInvoke', ctx: AfterInvokeContext): Promise<void>;
  async execute(
    phaseOrCtx: BeforeInvokeContext | 'beforeInvoke' | 'afterInvoke',
    maybeCtx?: BeforeInvokeContext | AfterInvokeContext,
  ): Promise<boolean | void> {
    if (phaseOrCtx === 'afterInvoke') {
      return this.runAfterInvoke(maybeCtx as AfterInvokeContext);
    }
    if (phaseOrCtx === 'beforeInvoke') {
      return this.runBeforeInvoke(maybeCtx as BeforeInvokeContext);
    }
    return this.runBeforeInvoke(phaseOrCtx);
  }

  /** The number of registered beforeInvoke hooks. */
  get beforeInvokeCount(): number {
    return this.registry.beforeInvoke.length;
  }

  /** The number of registered afterInvoke hooks. */
  get afterInvokeCount(): number {
    return this.registry.afterInvoke.length;
  }
}
