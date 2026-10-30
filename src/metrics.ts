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
 * Calculate percentile from sorted array
 */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.ceil(sorted.length * p) - 1;
  return sorted[Math.max(0, index)]!;
}
