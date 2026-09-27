type OperationKey = string;
type OperationResult<T> = Promise<T>;

interface InFlightOperation<T> {
  promise: OperationResult<T>;
  controller: AbortController;
}

/**
 * Shared, process-wide tracker used to deduplicate identical concurrent
 * requests across every SoroWillClient instance (multiple tabs, workers, etc.).
 *
 * A per-client tracker only deduplicates calls made through the same client
 * instance. When two clients issue the same request concurrently they each
 * hold their own tracker and both hit the network. Passing this singleton to
 * `new SoroWillClient({ inFlightTracker: globalInFlightTracker })` (or simply
 * reusing a single SoroWillClient instance) makes the deduplication global.
 */
export const globalInFlightTracker = /* @__PURE__ */ new InFlightTracker();

export class InFlightTracker {
  private readonly inFlight = new Map<OperationKey, InFlightOperation<unknown>>();

  getKey(willId: string | bigint, method: string): OperationKey {
    const id = typeof willId === 'bigint' ? willId.toString() : willId;
    return `${id}:${method}`;
  }

  isInFlight(willId: string | bigint, method: string): boolean {
    return this.inFlight.has(this.getKey(willId, method));
  }

  getInFlightPromise<T>(willId: string | bigint, method: string): OperationResult<T> | undefined {
    const op = this.inFlight.get(this.getKey(willId, method));
    return op?.promise as OperationResult<T> | undefined;
  }

  track<T>(
    willId: string | bigint,
    method: string,
    operation: (signal: AbortSignal) => PromiseLike<T>,
  ): PromiseLike<T> {
    const key = this.getKey(willId, method);

    if (this.inFlight.has(key)) {
      return this.inFlight.get(key)!.promise as PromiseLike<T>;
    }

    const controller = new AbortController();
    const promise = Promise.resolve(operation(controller.signal)).finally(() => {
      this.inFlight.delete(key);
    });

    this.inFlight.set(key, { promise, controller });
    return promise;
  }

  clear(): void {
    for (const { controller } of this.inFlight.values()) {
      controller.abort();
    }
    this.inFlight.clear();
  }

  abort(willId: string | bigint, method: string): void {
    const key = this.getKey(willId, method);
    const op = this.inFlight.get(key);
    if (op) {
      op.controller.abort();
      this.inFlight.delete(key);
    }
  }
}
