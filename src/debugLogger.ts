/**
 * Determines whether debug logging should be active based on environment.
 *
 * Logging is active when ALL of the following are true:
 *  1. The `enabled` flag passed to the constructor is `true`.
 *  2. The runtime is NOT in production mode. Production mode is detected when
 *     `process.env.NODE_ENV` is `"production"` (Node.js) or
 *     `import.meta.env?.MODE` is `"production"` (Vite / browser bundlers).
 *
 * The production guard is a safety net: even if a caller accidentally passes
 * `debug: true` to `SoroWillClient` in a production build, no logs will be
 * emitted. Production logging must be routed through a proper observability
 * pipeline — not the browser console.
 *
 * To enable debug logs in a Node.js environment you can also set the
 * `SOROWILL_DEBUG` environment variable to any non-empty value. This is
 * useful in CI scripts and automated tests where passing a constructor flag
 * is not convenient.
 */
function resolveEnabled(explicitFlag: boolean): boolean {
  // Check for SOROWILL_DEBUG env var (Node.js) as an alternative activation path.
  const envFlag =
    typeof process !== 'undefined' &&
    typeof process.env !== 'undefined' &&
    Boolean(process.env['SOROWILL_DEBUG']);

  const active = explicitFlag || envFlag;
  if (!active) return false;

  // Production guard — suppress even if explicitly enabled.
  const isProduction = isProductionEnvironment();
  return !isProduction;
}

/** Returns `true` when running in a known production environment. */
function isProductionEnvironment(): boolean {
  // Node.js / server-side check.
  if (
    typeof process !== 'undefined' &&
    typeof process.env !== 'undefined' &&
    process.env['NODE_ENV'] === 'production'
  ) {
    return true;
  }

  // Vite / browser bundler check (import.meta.env is replaced at build time).
  if (
    typeof globalThis !== 'undefined' &&
    typeof import.meta !== 'undefined' &&
    typeof import.meta.env !== 'undefined' &&
    (import.meta.env as Record<string, unknown>)['MODE'] === 'production'
  ) {
    return true;
  }

  return false;
}

interface DebugLog {
  timestamp: string;
  level: 'operation-build' | 'simulation' | 'submission' | 'poll' | 'success' | 'error';
  method: string;
  willId?: string | undefined;
  details: Record<string, unknown>;
}

export class DebugLogger {
  /**
   * Whether this logger is currently active.
   *
   * Resolved at construction time from the explicit `enabled` flag, the
   * `SOROWILL_DEBUG` environment variable, and the production-mode guard.
   * Callers may check this property to avoid building expensive log payloads
   * that would otherwise be thrown away immediately.
   */
  readonly isActive: boolean;

  constructor(enabled: boolean) {
    this.isActive = resolveEnabled(enabled);
  }

  logOperationBuild(method: string, willId?: string, details?: Record<string, unknown>): void {
    if (!this.isActive) return;

    const log: DebugLog = {
      timestamp: new Date().toISOString(),
      level: 'operation-build',
      method,
      willId,
      details: details || {},
    };

    this.log(log);
  }

  logSimulation(
    method: string,
    willId?: string,
    minResourceFee?: string,
    details?: Record<string, unknown>,
  ): void {
    if (!this.isActive) return;

    const log: DebugLog = {
      timestamp: new Date().toISOString(),
      level: 'simulation',
      method,
      willId,
      details: {
        minResourceFee,
        ...details,
      },
    };

    this.log(log);
  }

  logSubmission(method: string, willId?: string, txHash?: string): void {
    if (!this.isActive) return;

    const log: DebugLog = {
      timestamp: new Date().toISOString(),
      level: 'submission',
      method,
      willId,
      details: { txHash },
    };

    this.log(log);
  }

  logPoll(method: string, willId?: string, attempt?: number, maxAttempts?: number): void {
    if (!this.isActive) return;

    const log: DebugLog = {
      timestamp: new Date().toISOString(),
      level: 'poll',
      method,
      willId,
      details: { attempt, maxAttempts },
    };

    this.log(log);
  }

  logSuccess(method: string, willId?: string, txHash?: string, durationMs?: number): void {
    if (!this.isActive) return;

    const log: DebugLog = {
      timestamp: new Date().toISOString(),
      level: 'success',
      method,
      willId,
      details: { txHash, durationMs },
    };

    this.log(log);
  }

  logError(method: string, willId?: string, error?: string | Error): void {
    if (!this.isActive) return;

    const errorMessage = error instanceof Error ? error.message : String(error);
    // Stack traces are only captured when debug logging is enabled (checked above).
    const stack = error instanceof Error ? error.stack : undefined;

    const log: DebugLog = {
      timestamp: new Date().toISOString(),
      level: 'error',
      method,
      willId,
      details: { error: errorMessage, stack },
    };

    this.log(log);
  }

  private log(log: DebugLog): void {
    // Structured, JSON-serializable output covering multiple log levels
    // (not just warn/error), so console.log is intentional here.
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(log));
  }
}
