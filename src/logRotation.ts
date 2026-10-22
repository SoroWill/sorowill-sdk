/**
 * Log rotation and cleanup for DebugLogger (#651)
 *
 * Prevents indefinite log accumulation in long-running clients
 */

/**
 * Manages circular log buffer with automatic rotation
 */
export class RotatingLogBuffer {
  private logs: string[] = [];
  private readonly maxEntries: number;
  private totalBytesWritten = 0;
  private readonly maxTotalBytes: number;

  constructor(maxEntries: number = 10000, maxTotalBytes: number = 50 * 1024 * 1024) {
    this.maxEntries = maxEntries;
    this.maxTotalBytes = maxTotalBytes;
  }

  /**
   * Add a log entry, automatically rotating if needed
   */
  addLog(entry: string): void {
    const entryBytes = Buffer.byteLength(entry, 'utf8');

    // Enforce max entries
    if (this.logs.length >= this.maxEntries) {
      const removed = this.logs.shift();
      if (removed) {
        this.totalBytesWritten -= Buffer.byteLength(removed, 'utf8');
      }
    }

    // Enforce max bytes
    while (this.totalBytesWritten + entryBytes > this.maxTotalBytes && this.logs.length > 0) {
      const removed = this.logs.shift();
      if (removed) {
        this.totalBytesWritten -= Buffer.byteLength(removed, 'utf8');
      }
    }

    this.logs.push(entry);
    this.totalBytesWritten += entryBytes;
  }

  /**
   * Get current logs
   */
  getLogs(): string[] {
    return [...this.logs];
  }

  /**
   * Get logs since a certain point (for streaming)
   */
  getLogsSince(index: number): string[] {
    return this.logs.slice(Math.max(0, index));
  }

  /**
   * Clear all logs
   */
  clear(): void {
    this.logs = [];
    this.totalBytesWritten = 0;
  }

  /**
   * Get current size info
   */
  getStats(): {
    entryCount: number;
    totalBytes: number;
    maxEntries: number;
    maxTotalBytes: number;
    utilizationPercent: number;
  } {
    return {
      entryCount: this.logs.length,
      totalBytes: this.totalBytesWritten,
      maxEntries: this.maxEntries,
      maxTotalBytes: this.maxTotalBytes,
      utilizationPercent: (this.totalBytesWritten / this.maxTotalBytes) * 100,
    };
  }
}

/**
 * Exports logs to a snapshot file
 */
export function exportLogSnapshot(logs: string[]): string {
  const timestamp = new Date().toISOString();
  const header = `=== Log Snapshot ${timestamp} ===\n`;
  const footer = `\n=== End Snapshot ===`;
  return header + logs.join('\n') + footer;
}
