/**
 * Operation metrics and telemetry for SoroWillClient (#649)
 *
 * Provides visibility into operation latency, error rates, and performance
 * without requiring external monitoring tools.
 */

/**
 * Metrics for a single operation execution
 */
export interface OperationMetrics {
  name: string;
  startTimeMs: number;
  endTimeMs: number;
  durationMs: number;
  success: boolean;
  error?: string;
  retries?: number;
}

/**
 * Aggregated metrics across multiple operations
 */
export interface AggregatedMetrics {
  operationName: string;
  totalCount: number;
  successCount: number;
  errorCount: number;
  errorRate: number;
  latencyMs: {
    min: number;
    max: number;
    mean: number;
    p50: number;
    p95: number;
    p99: number;
  };
}

/**
 * Collects operation metrics for telemetry
 */
export class MetricsCollector {
  private operations: OperationMetrics[] = [];
  private readonly maxHistorySize: number;

  constructor(maxHistorySize: number = 1000) {
    this.maxHistorySize = maxHistorySize;
  }

  /**
   * Record a completed operation
   */
  recordOperation(metrics: OperationMetrics): void {
    this.operations.push(metrics);
    if (this.operations.length > this.maxHistorySize) {
      this.operations = this.operations.slice(-this.maxHistorySize);
    }
  }

  /**
   * Get aggregated metrics for an operation
   */
  getMetrics(operationName: string): AggregatedMetrics | null {
    const ops = this.operations.filter((op) => op.name === operationName);
    if (ops.length === 0) return null;

    const durations = ops.map((op) => op.durationMs).sort((a, b) => a - b);
    const successCount = ops.filter((op) => op.success).length;
    const errorCount = ops.length - successCount;

    return {
      operationName,
      totalCount: ops.length,
      successCount,
      errorCount,
      errorRate: errorCount / ops.length,
      latencyMs: {
        min: Math.min(...durations),
        max: Math.max(...durations),
        mean: durations.reduce((a, b) => a + b, 0) / durations.length,
        p50: percentile(durations, 0.5),
        p95: percentile(durations, 0.95),
        p99: percentile(durations, 0.99),
      },
    };
  }

  /**
   * Get all operation names being tracked
   */
  getOperationNames(): string[] {
    return Array.from(new Set(this.operations.map((op) => op.name)));
  }

  /**
   * Clear all metrics
   */
  clear(): void {
    this.operations = [];
  }

  /**
   * Get raw operation history
   */
  getHistory(operationName?: string): OperationMetrics[] {
    if (!operationName) return [...this.operations];
    return this.operations.filter((op) => op.name === operationName);
  }
}

/**
 * Per-operation counters tracked by {@link MetricsCollector}.
 *
 * Only counts and error codes are retained — never arguments, addresses,
 * contract IDs, XDR or RPC payloads.
 */
export interface OperationCounters {
  operationName: string;
  totalCount: number;
  successCount: number;
  errorCount: number;
  errorRate: number;
  /** Error code -> occurrence count. */
  errorCodes: Record<string, number>;
}

/**
 * Privacy-respecting analytics payload sent by {@link MetricsReporter}.
 */
export interface AnalyticsSnapshot {
  /** SDK version reporting the snapshot, when known. */
  sdkVersion?: string;
  /** ISO timestamp of when the snapshot was produced. */
  timestamp: string;
  /** Random per-session identifier; not tied to any wallet or user. */
  sessionId: string;
  operations: OperationCounters[];
}

/** Options for {@link MetricsReporter}. */
export interface MetricsReporterOptions {
  /** Server endpoint that accepts the batched snapshot as JSON. */
  endpoint: string;
  /**
   * Opt-in switch. Analytics are disabled unless this is explicitly `true`.
   * @default false
   */
  enabled?: boolean;
  /** Flush interval in milliseconds. @default 60000 */
  flushIntervalMs?: number;
  /** Maximum operations per batch. @default 100 */
  maxBatchSize?: number;
  /** SDK version included in the payload. */
  sdkVersion?: string;
  /** Transport override, mainly for tests. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Called when a flush fails; errors are never thrown to callers. */
  onError?: (error: unknown) => void;
}

/**
 * Opt-in batched reporter for {@link MetricsCollector} counters.
 *
 * Disabled by default: nothing is collected or sent unless `enabled: true`.
 * Payloads contain only operation names, counts and error codes.
 */
export class MetricsReporter {
  private readonly collector: MetricsCollector;
  private readonly options: Required<
    Pick<MetricsReporterOptions, 'endpoint' | 'enabled' | 'flushIntervalMs' | 'maxBatchSize'>
  > &
    MetricsReporterOptions;
  private readonly sessionId: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;

  constructor(collector: MetricsCollector, options: MetricsReporterOptions) {
    this.collector = collector;
    this.options = {
      enabled: false,
      flushIntervalMs: 60_000,
      maxBatchSize: 100,
      ...options,
    };
    this.sessionId = generateSessionId();
    if (this.options.enabled) this.start();
  }

  /** Whether reporting is currently enabled. */
  get isEnabled(): boolean {
    return this.options.enabled === true;
  }

  /** Start the periodic flush timer (no-op when disabled). */
  start(): void {
    if (!this.isEnabled || this.timer) return;
    this.timer = setInterval(() => {
      void this.flush();
    }, this.options.flushIntervalMs);
    // Do not keep the Node.js event loop alive because of analytics.
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** Stop the periodic flush timer. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Build the current snapshot without sending it. */
  buildSnapshot(): AnalyticsSnapshot {
    const operations = this.collector
      .getOperationNames()
      .slice(0, this.options.maxBatchSize)
      .map((name) => {
        const aggregated = this.collector.getMetrics(name);
        const errorCodes: Record<string, number> = {};
        for (const op of this.collector.getHistory(name)) {
          if (op.success || !op.error) continue;
          errorCodes[op.error] = (errorCodes[op.error] ?? 0) + 1;
        }
        return {
          operationName: name,
          totalCount: aggregated?.totalCount ?? 0,
          successCount: aggregated?.successCount ?? 0,
          errorCount: aggregated?.errorCount ?? 0,
          errorRate: aggregated?.errorRate ?? 0,
          errorCodes,
        };
      });

    return {
      ...(this.options.sdkVersion ? { sdkVersion: this.options.sdkVersion } : {}),
      timestamp: new Date().toISOString(),
      sessionId: this.sessionId,
      operations,
    };
  }

  /**
   * Send the current snapshot to the configured endpoint.
   * Resolves to `true` when the batch was accepted.
   */
  async flush(): Promise<boolean> {
    if (!this.isEnabled || this.flushing) return false;
    const snapshot = this.buildSnapshot();
    if (snapshot.operations.length === 0) return false;

    const fetchImpl = this.options.fetchImpl ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function') return false;

    this.flushing = true;
    try {
      const response = await fetchImpl(this.options.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(snapshot),
      });
      return response.ok;
    } catch (error) {
      this.options.onError?.(error);
      return false;
    } finally {
      this.flushing = false;
    }
  }
}

/**
 * Generate a random, non-identifying session identifier.
 */
function generateSessionId(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    return cryptoApi.randomUUID();
  }
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Calculate percentile from sorted array
 */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.ceil(sorted.length * p) - 1;
  return sorted[Math.max(0, index)]!;
}
