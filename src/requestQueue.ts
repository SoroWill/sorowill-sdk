import { RequestQueueOverflowError, RequestTimeoutError } from './errors';

/**
 * Default cap on the number of requests that may be waiting in the queue at
 * once. Requests beyond this limit are rejected with a
 * {@link RequestQueueOverflowError} instead of accumulating without bound (#525).
 */
export const DEFAULT_MAX_QUEUE_SIZE = 1_000;

/**
 * Rate and concurrency controls used by the client's shared RPC request queue.
 *
 * The queue is fair in that it respects both FIFO ordering and request priority:
 * requests are executed in strict FIFO order when they have the same priority.
 * When a request with higher priority is enqueued, it will be executed ahead of
 * lower-priority requests that are already queued, but after any requests that
 * were already being processed.
 */
export interface RequestQueueOptions {
  /** Maximum number of RPC requests in flight at once. Must be an integer >= 1. Defaults to 4. */
  maxConcurrent?: number;
  /**
   * Maximum number of RPC requests started in any rolling one-second window. Defaults to 10.
   *
   * This enforces rate limiting at the RPC server level. High-priority requests
   * may still be delayed if the rate limit has been exhausted.
   */
  requestsPerSecond?: number;
  /**
   * Maximum number of requests allowed to wait in the queue at once. Defaults
   * to 1000. When the queue is full, further {@link RequestQueue.enqueue}
   * calls are rejected with a {@link RequestQueueOverflowError} instead of
   * growing the queue without bound (#525).
   */
  maxQueueSize?: number;
  /**
   * Optional account key. When provided, all {@link RequestQueue} instances
   * created with the same key share a single underlying queue, so operations
   * for a given account are serialized even if multiple clients (or multiple
   * queues) are created for that account in rapid succession.
   */
  account?: string;
  /**
   * Maximum number of times a request that fails with a rate-limit error
   * (HTTP 429 / "too many requests") is retried before the error is surfaced.
   * Defaults to 3. Set to 0 to disable rate-limit retries.
   */
  maxRateLimitRetries?: number;
  /**
   * Base delay in milliseconds for rate-limit retries. The n-th retry waits
   * `2^n * retryBaseDelayMs` (capped by {@link maxBackoffMs}). Defaults to 500.
   */
  retryBaseDelayMs?: number;
  /** Upper bound in milliseconds for a single backoff delay. Defaults to 60 000 (60s). */
  maxBackoffMs?: number;
  /**
   * Default timeout in milliseconds for requests that do not specify an
   * explicit `timeoutMs` in {@link RequestQueue.enqueue}. Prevents stuck
   * requests from permanently holding concurrency slots. Defaults to 30 000 (30s).
   * Set to `0` to disable the default timeout.
   */
  defaultTimeoutMs?: number;
  /**
   * Maximum number of queued requests started per drain tick when the queue is
   * backed up (>= {@link backupThreshold}). Defaults to 10.
   */
  batchSize?: number;
  /**
   * Pending queue depth at which batch-draining and depth warnings activate.
   * Defaults to 50.
   */
  backupThreshold?: number;
  /**
   * Optional callback invoked whenever the pending queue depth reaches or
   * exceeds {@link backupThreshold}.
   */
  onQueueDepthWarning?: (depth: number, maxQueueSize: number) => void;
  /**
   * Priority assigned to requests enqueued without an explicit priority.
   * Defaults to {@link RequestPriority.Normal}. Use this to make a queue
   * critical (e.g. `RequestPriority.High`) or background-only
   * (`RequestPriority.Low`) without changing every call site.
   */
  defaultPriority?: RequestPriority;
  /**
   * Optional custom priority levels. When provided, these replace the built-in
   * {@link RequestPriority} levels: higher numeric values are processed first.
   * Requests enqueued with a priority that is not listed here are rejected with
   * a `RangeError`.
   */
  priorities?: readonly number[];
}

/** Snapshot of {@link RequestQueue} depth and active execution metrics. */
export interface RequestQueueMetrics {
  depth: number;
  active: number;
  maxQueueSize: number;
  maxConcurrent: number;
  isBackedUp: boolean;
}

/** Default cap applied to a single exponential backoff delay (60 seconds). */
export const MAX_BACKOFF_MS = 60_000;

/**
 * Computes the exponential backoff delay for a retry: `2^attempt * baseDelayMs`,
 * capped at `maxBackoffMs`. `attempt` is zero-based (the first retry is attempt 0).
 * When `jitter` is `true`, applies 50%–100% jitter to prevent retry storms.
 */
export function computeBackoffDelay(
  attempt: number,
  baseDelayMs: number,
  maxBackoffMs: number = MAX_BACKOFF_MS,
  jitter: boolean = false,
): number {
  const delay = 2 ** attempt * baseDelayMs;
  const capped = Number.isFinite(delay) ? Math.min(delay, maxBackoffMs) : maxBackoffMs;
  if (!jitter) {
    return capped;
  }
  return Math.floor(capped * (0.5 + Math.random() * 0.5));
}

/**
 * Returns true when `error` signals that the RPC endpoint rate-limited the
 * request (HTTP 429 or a "too many requests" / "rate limit" message).
 */
export function isRateLimitError(error: unknown): boolean {
  if (error === null || error === undefined) return false;
  if (typeof error === 'object') {
    const candidate = error as {
      status?: unknown;
      statusCode?: unknown;
      response?: { status?: unknown };
    };
    if (
      candidate.status === 429 ||
      candidate.statusCode === 429 ||
      candidate.response?.status === 429
    ) {
      return true;
    }
  }
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const lower = text.toLowerCase();
  return lower.includes('too many requests') || lower.includes('rate limit') || /\b429\b/.test(text);
}

/**
 * Error classification for RPC failures: transient errors can be retried,
 * while permanent errors indicate configuration or protocol issues.
 */
export enum ErrorTransience {
  /** Transient: can be retried (timeout, rate limit, temporary network issue). */
  Transient = 'transient',
  /** Permanent: should not be retried (malformed request, authentication, invalid params). */
  Permanent = 'permanent',
}

/**
 * Classifies an RPC error as transient (safe to retry) or permanent.
 *
 * Transient errors (timeouts, rate limits, temporary unavailability) can be
 * retried with backoff. Permanent errors (bad requests, authentication failures,
 * protocol violations) will always fail and should not be retried.
 *
 * @param error - The error to classify.
 * @returns ErrorTransience enum value indicating retry eligibility.
 *
 * @example
 * ```ts
 * try {
 *   const result = await queue.enqueue(async () => rpc.call(...));
 * } catch (error) {
 *   const classification = classifyRpcError(error);
 *   if (classification === ErrorTransience.Transient) {
 *     // Safe to retry with backoff
 *     setTimeout(() => retryQueue.enqueue(...), 1000);
 *   } else {
 *     // Permanent failure, propagate immediately
 *     throw error;
 *   }
 * }
 * ```
 */
export function classifyRpcError(error: unknown): ErrorTransience {
  if (error === null || error === undefined) {
    return ErrorTransience.Permanent;
  }

  // Timeouts are always transient (network/timing issue)
  if (error instanceof RequestTimeoutError) {
    return ErrorTransience.Transient;
  }

  // Rate limits are transient (wait and retry)
  if (isRateLimitError(error)) {
    return ErrorTransience.Transient;
  }

  // HTTP status codes classify error transience
  if (typeof error === 'object') {
    const candidate = error as {
      status?: unknown;
      statusCode?: unknown;
      response?: { status?: unknown };
    };

    const status =
      candidate.status ?? candidate.statusCode ?? candidate.response?.status;

    if (typeof status === 'number') {
      // 5xx server errors are transient (server temporarily unavailable)
      if (status >= 500 && status < 600) {
        return ErrorTransience.Transient;
      }

      // 4xx client errors are permanent (bad request, auth failure, etc.)
      if (status >= 400 && status < 500) {
        return ErrorTransience.Permanent;
      }

      // 3xx redirects and others are permanent
      if (status !== 200 && status !== 201) {
        return ErrorTransience.Permanent;
      }
    }
  }

  // Network-related messages: transient
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const lower = text.toLowerCase();

  const transientPatterns = [
    'econnrefused', // Connection refused
    'econnreset', // Connection reset
    'etimedout', // Timeout
    'ehostunreach', // Host unreachable
    'enetunreach', // Network unreachable
    'temporarily unavailable',
    'temporarily unable',
    'service temporarily unavailable',
  ];

  if (transientPatterns.some((pattern) => lower.includes(pattern))) {
    return ErrorTransience.Transient;
  }

  // Protocol/request errors: permanent
  const permanentPatterns = [
    'parse error', // JSON parsing failed
    'invalid json', // Malformed response
    'invalid request', // Malformed request
    'method not found', // Unknown RPC method
    'unauthorized', // Auth failure
    'forbidden', // Permission denied
    'invalid params', // Bad parameters
    'invalid contract', // Invalid contract ID
  ];

  if (permanentPatterns.some((pattern) => lower.includes(pattern))) {
    return ErrorTransience.Permanent;
  }

  // Default: unknown errors are permanent to avoid infinite retries
  // (safer to surface the error than retry indefinitely)
  return ErrorTransience.Permanent;
}

/**
 * Raised by {@link RequestQueue.enqueueAfter} when a dependency of a queued
 * request rejects, so the dependent request is never executed (#733).
 */
export class RequestDependencyError extends Error {
  /** Zero-based index of the failing dependency in the supplied list. */
  readonly dependencyIndex: number;

  constructor(dependencyIndex: number, cause: unknown) {
    super(
      `Dependency at index ${dependencyIndex} failed; the dependent request was not executed.`,
      { cause },
    );
    this.name = 'RequestDependencyError';
    this.dependencyIndex = dependencyIndex;
  }
}

/**
 * Priority level for requests in the queue. Higher priority requests are
 * processed first; requests with equal priority are processed in FIFO order.
 * Levels are configurable per queue via {@link RequestQueueOptions.priorities}.
 */
export enum RequestPriority {
  /** Low priority for background operations (e.g., UI polling). */
  Low = 0,
  /** Normal priority for regular operations. Default priority. */
  Normal = 1,
  /** High priority for user-initiated operations (e.g., form submissions). */
  High = 2,
}

/** Built-in priority levels, ordered from lowest to highest. */
export const DEFAULT_PRIORITIES: readonly RequestPriority[] = [
  RequestPriority.Low,
  RequestPriority.Normal,
  RequestPriority.High,
];

/** Maximum number of completed request traces kept for debugging. */
export const MAX_REQUEST_TRACES = 100;

/**
 * Lifecycle record for one executed request, returned by
 * {@link RequestQueue.getTraces}.
 */
export interface RequestTrace {
  /** Unique ID generated for the request when it was enqueued. */
  id: string;
  /** Operation type passed to `enqueue`, if any. */
  method: string | undefined;
  priority: RequestPriority;
  /** Epoch ms when the request entered the queue. */
  enqueuedAt: number;
  /** Epoch ms when the request was sent (execution started). */
  sentAt: number;
  /** Epoch ms when the response, error or timeout was received. */
  respondedAt: number;
  /** Time spent waiting in the queue before being sent. */
  queuedMs: number;
  /** Time from being sent until the response was received. */
  roundTripMs: number;
  status: 'success' | 'error';
}

let requestSequence = 0;

/** Generates a request ID that is unique within this process. */
function nextRequestId(): string {
  requestSequence += 1;
  return `req-${Date.now().toString(36)}-${requestSequence.toString(36)}`;
}

interface PendingRequest<T> {
  id: string;
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  timeoutMs: number | undefined;
  signal: AbortSignal | undefined;
  abortListener: (() => void) | undefined;
  priority: RequestPriority;
  enqueuedAt: number;
  method: string | undefined;
}

/**
 * Shared state for a single account. Multiple {@link RequestQueue} instances
 * created for the same account delegate to the same {@link QueueCore}, which
 * guarantees their operations are serialized against one another.
 */
class QueueCore {
  readonly maxConcurrent: number;
  readonly requestsPerSecond: number;
  readonly maxQueueSize: number;
  readonly maxRateLimitRetries: number;
  readonly retryBaseDelayMs: number;
  readonly maxBackoffMs: number;
  readonly defaultTimeoutMs: number;
  readonly batchSize: number;
  readonly backupThreshold: number;
  readonly onQueueDepthWarning: ((depth: number, maxQueueSize: number) => void) | undefined;
  readonly defaultPriority: RequestPriority;
  readonly priorities: readonly number[];
  readonly pending: Array<PendingRequest<unknown>> = [];
  readonly starts: number[] = [];
  /** Most recent completed request traces, oldest first. */
  readonly traces: RequestTrace[] = [];
  active = 0;
  wakeTimer: ReturnType<typeof setTimeout> | undefined;
  draining = false;
  refCount = 0;

  constructor(
    maxConcurrent: number,
    requestsPerSecond: number,
    maxQueueSize: number,
    maxRateLimitRetries: number,
    retryBaseDelayMs: number,
    maxBackoffMs: number,
    defaultTimeoutMs: number,
    batchSize: number,
    backupThreshold: number,
    onQueueDepthWarning?: (depth: number, maxQueueSize: number) => void,
    defaultPriority: RequestPriority = RequestPriority.Normal,
    priorities: readonly number[] = DEFAULT_PRIORITIES,
  ) {
    this.maxConcurrent = maxConcurrent;
    this.requestsPerSecond = requestsPerSecond;
    this.maxQueueSize = maxQueueSize;
    this.maxRateLimitRetries = maxRateLimitRetries;
    this.retryBaseDelayMs = retryBaseDelayMs;
    this.maxBackoffMs = maxBackoffMs;
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.batchSize = batchSize;
    this.backupThreshold = backupThreshold;
    this.onQueueDepthWarning = onQueueDepthWarning;
    this.defaultPriority = defaultPriority;
    this.priorities = priorities;
  }
}

/**
 * Process-wide registry of shared queue cores keyed by account. This is what
 * makes {@link RequestQueue} effectively a singleton per account: two queues
 * constructed for the same account within milliseconds coordinate through the
 * same core instead of racing each other.
 */
const sharedCores = new Map<string, QueueCore>();

/** FIFO queue that applies concurrency, rate, and timeout limits to asynchronous requests. */
export class RequestQueue {
  private readonly core: QueueCore;
  private readonly account: string | undefined;
  private released = false;

  constructor(options: RequestQueueOptions = {}) {
    // Validate options before applying defaults
    if (options.maxConcurrent !== undefined) {
      if (typeof options.maxConcurrent !== 'number' || !Number.isInteger(options.maxConcurrent) || options.maxConcurrent < 1) {
        throw new RangeError(`maxConcurrent must be a positive integer, received ${options.maxConcurrent}`);
      }
    }
    if (options.requestsPerSecond !== undefined) {
      if (typeof options.requestsPerSecond !== 'number' || !Number.isInteger(options.requestsPerSecond) || options.requestsPerSecond < 1) {
        throw new RangeError(`requestsPerSecond must be a positive integer, received ${options.requestsPerSecond}`);
      }
    }
    if (options.maxQueueSize !== undefined) {
      if (typeof options.maxQueueSize !== 'number' || !Number.isInteger(options.maxQueueSize) || options.maxQueueSize < 1) {
        throw new RangeError(`maxQueueSize must be a positive integer, received ${options.maxQueueSize}`);
      }
    }
    if (options.maxBackoffMs !== undefined) {
      if (typeof options.maxBackoffMs !== 'number' || !Number.isFinite(options.maxBackoffMs) || options.maxBackoffMs > MAX_BACKOFF_MS) {
        throw new RangeError(`maxBackoffMs must be at most ${MAX_BACKOFF_MS}ms, received ${options.maxBackoffMs}`);
      }
    }

    const maxConcurrent = options.maxConcurrent ?? 4;
    const requestsPerSecond = options.requestsPerSecond ?? 10;
    const maxQueueSize = options.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE;
    const maxRateLimitRetries = options.maxRateLimitRetries ?? 3;
    const retryBaseDelayMs = options.retryBaseDelayMs ?? 500;
    const maxBackoffMs = options.maxBackoffMs ?? MAX_BACKOFF_MS;
    const defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
    const batchSize = options.batchSize ?? 10;
    const backupThreshold = options.backupThreshold ?? 50;
    const onQueueDepthWarning = options.onQueueDepthWarning;
    const defaultPriority = options.defaultPriority ?? RequestPriority.Normal;
    const priorities = options.priorities ?? DEFAULT_PRIORITIES;
    if (options.priorities !== undefined) {
      if (!Array.isArray(options.priorities) || options.priorities.length === 0) {
        throw new RangeError('priorities must be a non-empty array of numbers');
      }
      for (const level of options.priorities) {
        if (typeof level !== 'number' || !Number.isFinite(level)) {
          throw new RangeError(`priorities must contain only finite numbers, received ${level}`);
        }
      }
    }
    if (!priorities.includes(defaultPriority)) {
      throw new RangeError(
        `defaultPriority ${defaultPriority} is not one of the configured priorities`,
      );
    }
    this.account = options.account;
    if (this.account !== undefined) {
      let core = sharedCores.get(this.account);
      if (core === undefined) {
        core = new QueueCore(
          maxConcurrent,
          requestsPerSecond,
          maxQueueSize,
          maxRateLimitRetries,
          retryBaseDelayMs,
          maxBackoffMs,
          defaultTimeoutMs,
          batchSize,
          backupThreshold,
          onQueueDepthWarning,
          defaultPriority,
          priorities,
        );
        sharedCores.set(this.account, core);
      }
      core.refCount += 1;
      this.core = core;
    } else {
      this.core = new QueueCore(
        maxConcurrent,
        requestsPerSecond,
        maxQueueSize,
        maxRateLimitRetries,
        retryBaseDelayMs,
        maxBackoffMs,
        defaultTimeoutMs,
        batchSize,
        backupThreshold,
        onQueueDepthWarning,
        defaultPriority,
        priorities,
      );
    }
  }

  enqueue<T>(
    run: () => Promise<T>,
    timeoutMs?: number,
    signal?: AbortSignal,
    priority: RequestPriority = this.core.defaultPriority,
    method?: string,
  ): Promise<T> {
    if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
      return Promise.reject(new RangeError('timeoutMs must be greater than zero'));
    }
    if (!this.core.priorities.includes(priority)) {
      return Promise.reject(
        new RangeError(
          `priority ${priority} is not one of the configured priorities (${this.core.priorities.join(', ')})`,
        ),
      );
    }
    if (signal?.aborted) {
      return Promise.reject(signal.reason);
    }
    // Enforce the queue size cap (#525): when requests are produced faster
    // than concurrency + rate limits allow them to start, reject the excess
    // immediately rather than letting the pending list grow without bound.
    if (this.core.pending.length >= this.core.maxQueueSize) {
      return Promise.reject(new RequestQueueOverflowError(this.core.maxQueueSize));
    }
    return new Promise<T>((resolve, reject) => {
      const request: PendingRequest<T> = {
        run,
        resolve,
        reject,
        timeoutMs,
        signal,
        abortListener: undefined,
        priority,
        id: nextRequestId(),
        enqueuedAt: Date.now(),
        method,
      };
      if (signal) {
        request.abortListener = () => {
          // Drop the request from the queue so an aborted request never runs.
          const index = this.core.pending.indexOf(request as PendingRequest<unknown>);
          if (index !== -1) this.core.pending.splice(index, 1);
          this.removeAbortListener(request);
          reject(signal.reason);
        };
        signal.addEventListener('abort', request.abortListener);
      }
      this.core.pending.push(request as PendingRequest<unknown>);
      if (
        this.core.onQueueDepthWarning &&
        this.core.pending.length >= this.core.backupThreshold
      ) {
        try {
          this.core.onQueueDepthWarning(this.core.pending.length, this.core.maxQueueSize);
        } catch {
          // Monitoring callbacks must not break enqueueing
        }
      }
      this.drain();
    });
  }

  /** Returns the current number of requests waiting in the queue. */
  getDepth(): number {
    return this.core.pending.length;
  }

  /** Returns the current number of active in-flight requests. */
  getActiveCount(): number {
    return this.core.active;
  }

  /** Returns a snapshot of queue depth, active count, and backup status. */
  getMetrics(): RequestQueueMetrics {
    const depth = this.core.pending.length;
    return {
      depth,
      active: this.core.active,
      maxQueueSize: this.core.maxQueueSize,
      maxConcurrent: this.core.maxConcurrent,
      isBackedUp: depth >= this.core.backupThreshold,
    };
  }

  /**
   * Enqueues a request that must not start until every dependency has
   * resolved successfully (#733). Dependencies are awaited before the request
   * joins the FIFO queue, so a dependent call can never overtake the call it
   * depends on, even when both were submitted in quick succession.
   *
   * If any dependency rejects, the returned promise rejects with a
   * {@link RequestDependencyError} that names the failing dependency index and
   * carries the original error as `cause`; `run` is never invoked.
   *
   * @param dependencies - Promises (or values) that must resolve first.
   * @param run - The request to execute once all dependencies have resolved.
   */
  enqueueAfter<T>(
    dependencies: ReadonlyArray<unknown>,
    run: () => Promise<T>,
    timeoutMs?: number,
    signal?: AbortSignal,
    priority: RequestPriority = this.core.defaultPriority,
    method?: string,
  ): Promise<T> {
    const waits = dependencies.map((dep, index) =>
      Promise.resolve(dep).catch((cause: unknown) => {
        throw new RequestDependencyError(index, cause);
      }),
    );
    return Promise.all(waits).then(() =>
      this.enqueue(run, timeoutMs, signal, priority, method),
    );
  }

  /**
   * Rejects every request that is queued but not yet started, clearing the
   * pending list. Active (already-started) requests are not affected here —
   * callers should abort those separately via {@link InFlightTracker.clear}.
   *
   * Intended to be called by {@link SoroWillClient.destroy} so that any
   * requests enqueued after unmount/teardown do not run to completion.
   */
  rejectAll(reason: unknown): void {
    if (this.core.wakeTimer !== undefined) {
      clearTimeout(this.core.wakeTimer);
      this.core.wakeTimer = undefined;
    }
    const drained = this.core.pending.splice(0);
    for (const request of drained) {
      this.removeAbortListener(request);
      request.reject(reason);
    }
  }

  /**
   * Releases this queue's reference to the shared per-account core. When the
   * last queue for an account is released, the shared core is dropped so a
   * later client for the same account starts from a clean state.
   */
  release(): void {
    if (this.released) return;
    this.released = true;
    if (this.account === undefined) return;
    const core = sharedCores.get(this.account);
    if (core !== this.core) return;
    core.refCount -= 1;
    if (core.refCount <= 0) {
      sharedCores.delete(this.account);
    }
  }

  /**
   * Returns the lifecycle traces of the most recently executed requests on
   * this queue's account (oldest first, at most {@link MAX_REQUEST_TRACES}).
   * Each trace gives the request ID, operation type, and queued / round-trip
   * timings. Intended for debugging; returned objects are copies.
   */
  getTraces(): RequestTrace[] {
    return this.core.traces.map((trace) => ({ ...trace }));
  }

  /** Returns the trace for a request ID, or `undefined` if it has been dropped or never ran. */
  getTrace(id: string): RequestTrace | undefined {
    const trace = this.core.traces.find((candidate) => candidate.id === id);
    return trace ? { ...trace } : undefined;
  }

  private recordTrace<T>(request: PendingRequest<T>, sentAt: number, succeeded: boolean): void {
    const respondedAt = Date.now();
    this.core.traces.push({
      id: request.id,
      method: request.method,
      priority: request.priority,
      enqueuedAt: request.enqueuedAt,
      sentAt,
      respondedAt,
      queuedMs: sentAt - request.enqueuedAt,
      roundTripMs: respondedAt - sentAt,
      status: succeeded ? 'success' : 'error',
    });
    if (this.core.traces.length > MAX_REQUEST_TRACES) {
      this.core.traces.shift();
    }
  }

  private removeAbortListener(request: { signal: AbortSignal | undefined; abortListener: (() => void) | undefined }): void {
    if (request.signal && request.abortListener) {
      request.signal.removeEventListener('abort', request.abortListener);
    }
  }

  private drain(): void {
    const core = this.core;
    if (core.draining) {
      return;
    }
    core.draining = true;
    try {
      if (core.wakeTimer !== undefined) {
        clearTimeout(core.wakeTimer);
        core.wakeTimer = undefined;
      }
      const now = Date.now();
      while (core.starts[0] !== undefined && core.starts[0] <= now - 1_000) {
        core.starts.shift();
      }

      const isBackedUp = core.pending.length >= core.backupThreshold;
      const maxToStartThisTick = isBackedUp ? core.batchSize : Infinity;
      let startedThisTick = 0;

      while (
        core.active < core.maxConcurrent &&
        core.starts.length < core.requestsPerSecond &&
        startedThisTick < maxToStartThisTick
      ) {
        const request = this.dequeue();
        if (request === undefined) break;
        core.active += 1;
        startedThisTick += 1;
        core.starts.push(Date.now());
        this.removeAbortListener(request);
        void this.execute(request);
      }

      if (core.pending.length > 0 && core.active < core.maxConcurrent) {
        if (startedThisTick >= maxToStartThisTick && core.starts.length < core.requestsPerSecond) {
          // Yield to the event loop between batches when backed up so pending requests keep draining
          core.wakeTimer = setTimeout(() => this.drain(), 0);
        } else if (core.starts[0] !== undefined) {
          const delay = Math.max(1, core.starts[0] + 1_000 - Date.now());
          core.wakeTimer = setTimeout(() => this.drain(), delay);
        }
      }
    } finally {
      core.draining = false;
    }
  }

  /**
   * Selects and removes a request in one synchronous operation. JavaScript runs
   * this to completion before another producer, abort listener, or drain can
   * touch the shared core. Callers use the removal result, not a size check.
   *
   * The highest-priority request is selected first; requests sharing that
   * priority are served in FIFO order (the earliest enqueued wins).
   */
  private dequeue(): PendingRequest<unknown> | undefined {
    const pending = this.core.pending;
    let selectedIndex = -1;
    let selectedPriority = -Infinity;
    for (let i = 0; i < pending.length; i++) {
      const candidate = pending[i]!;
      if (candidate.priority > selectedPriority) {
        selectedIndex = i;
        selectedPriority = candidate.priority;
      }
    }
    return selectedIndex === -1 ? undefined : pending.splice(selectedIndex, 1)[0];
  }

  private async execute<T>(request: PendingRequest<T>): Promise<void> {
    const effectiveTimeoutMs =
      request.timeoutMs !== undefined
        ? request.timeoutMs
        : this.core.defaultTimeoutMs > 0
          ? this.core.defaultTimeoutMs
          : undefined;

    const executeWithRetry = async (attemptNumber: number): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result =
          effectiveTimeoutMs === undefined
            ? await request.run()
            : await Promise.race([
                request.run(),
                new Promise<never>((_, reject) => {
                  timer = setTimeout(
                    () =>
                      reject(
                        new RequestTimeoutError(
                          effectiveTimeoutMs,
                          request.method,
                        ),
                      ),
                    effectiveTimeoutMs,
                  );
                }),
              ]);
        return result;
      } catch (error) {
        // Retry rate-limit errors with exponential backoff
        if (isRateLimitError(error) && attemptNumber < this.core.maxRateLimitRetries) {
          const delay = computeBackoffDelay(attemptNumber, this.core.retryBaseDelayMs, this.core.maxBackoffMs);
          await new Promise((resolve) => setTimeout(resolve, delay));
          return executeWithRetry(attemptNumber + 1);
        }
        throw error;
      } finally {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
      }
    };

    const sentAt = Date.now();
    let succeeded = false;
    try {
      const result = await executeWithRetry(0);
      succeeded = true;
      request.resolve(result);
    } catch (error) {
      request.reject(error);
    } finally {
      this.recordTrace(request, sentAt, succeeded);
      this.removeAbortListener(request);
      this.core.active -= 1;
      this.drain();
    }
  }
}

const sharedQueueMap = new Map<string, RequestQueue>();

export function getSharedRequestQueue(account?: string): RequestQueue {
  const key = account ?? '__default__';
  if (!sharedQueueMap.has(key)) {
    const opts: RequestQueueOptions = account !== undefined ? { account } : {};
    sharedQueueMap.set(key, new RequestQueue(opts));
  }
  return sharedQueueMap.get(key)!;
}

export function releaseSharedRequestQueue(account?: string): void {
  const key = account ?? '__default__';
  const queue = sharedQueueMap.get(key);
  if (queue) {
    queue.release();
    sharedQueueMap.delete(key);
  }
}
