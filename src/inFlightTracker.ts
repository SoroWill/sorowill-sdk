type OperationKey = string;
type OperationResult<T> = Promise<T>;

interface InFlightOperation<T> {
  promise: OperationResult<T>;
  controller: AbortController;
}

interface FailedOperation {
  sequence: string;
  failedAt: number;
}

const FAILED_SEQUENCE_TTL_MS = 5 * 60 * 1000;

export class InFlightTracker {
  private readonly inFlight = new Map<OperationKey, InFlightOperation<unknown>>();
  private readonly failedSequences = new Map<OperationKey, FailedOperation>();

  getKey(willId: string | bigint, method: string, clientId?: string): OperationKey {
    const id = typeof willId === 'bigint' ? willId.toString() : willId;
    const scope = clientId ?? '';
    return `${scope}:${id}:${method}`;
  }

  isInFlight(willId: string | bigint, method: string, clientId?: string): boolean {
    return this.inFlight.has(this.getKey(willId, method, clientId));
  }

  getInFlightPromise<T>(
    willId: string | bigint,
    method: string,
    clientId?: string,
  ): OperationResult<T> | undefined {
    const op = this.inFlight.get(this.getKey(willId, method, clientId));
    return op?.promise as OperationResult<T> | undefined;
  }

  /**
   * Records that a feeBump operation failed while holding the given sequence
   * number. A subsequent retry that reuses the same sequence number must not
   * be treated as a fresh in-flight operation, otherwise the retry can race
   * with the still-pending failed transaction and reuse an in-use sequence.
   */
  markFailed(
    willId: string | bigint,
    method: string,
    sequence: string | bigint,
    clientId?: string,
  ): void {
    const key = this.getKey(willId, method, clientId);
    this.failedSequences.set(key, {
      sequence: typeof sequence === 'bigint' ? sequence.toString() : sequence,
      failedAt: Date.now(),
    });
  }

  /**
   * Returns true when the given sequence number was previously used by a
   * failed operation for this key and has not yet been superseded. Callers
   * should advance the sequence number before retrying instead of reusing it.
   */
  isSequenceReused(
    willId: string | bigint,
    method: string,
    sequence: string | bigint,
    clientId?: string,
  ): boolean {
    const key = this.getKey(willId, method, clientId);
    const failed = this.failedSequences.get(key);
    if (!failed) {
      return false;
    }
    if (Date.now() - failed.failedAt > FAILED_SEQUENCE_TTL_MS) {
      this.failedSequences.delete(key);
      return false;
    }
    const seq = typeof sequence === 'bigint' ? sequence.toString() : sequence;
    return failed.sequence === seq;
  }

  /**
   * Clears the failed-sequence record for a key once a retry has advanced
   * past the previously failed sequence number.
   */
  clearFailed(willId: string | bigint, method: string, clientId?: string): void {
    this.failedSequences.delete(this.getKey(willId, method, clientId));
  }

  track<T>(
    willId: string | bigint,
    method: string,
    operation: (signal: AbortSignal) => PromiseLike<T>,
    clientId?: string,
  ): PromiseLike<T> {
    const key = this.getKey(willId, method, clientId);

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
    this.failedSequences.clear();
  }

  abort(willId: string | bigint, method: string, clientId?: string): void {
    const key = this.getKey(willId, method, clientId);
    const op = this.inFlight.get(key);
    if (op) {
      op.controller.abort();
      this.inFlight.delete(key);
    }
  }
}
