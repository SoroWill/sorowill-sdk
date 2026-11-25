import { rpc } from '@stellar/stellar-sdk';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { SoroWillRpcServer } from './SoroWillClient';
import { computeBackoffDelay } from './requestQueue';

export const DEFAULT_RPC_TIMEOUT_MS = 30_000;
export const DEFAULT_RPC_TIMEOUT_MAX_ATTEMPTS = 3;
export const DEFAULT_RPC_TIMEOUT_RETRY_BASE_DELAY_MS = 1_000;

/**
 * Base delay applied to an RPC endpoint after it fails a request. The delay
 * doubles for every consecutive failure (exponential backoff) and is capped at
 * {@link DEFAULT_RPC_ENDPOINT_BACKOFF_MAX_MS}. While an endpoint is backing
 * off it is deprioritized — the pool routes requests to other healthy
 * endpoints instead of immediately retrying the failing one.
 */
export const DEFAULT_RPC_ENDPOINT_BACKOFF_BASE_MS = 1_000;

/** Upper bound for the per-endpoint exponential backoff delay. */
export const DEFAULT_RPC_ENDPOINT_BACKOFF_MAX_MS = 30_000;

/**
 * How often endpoint health is re-checked once monitoring has started. Each
 * tick also acts as the recovery attempt for endpoints marked unhealthy.
 */
export const DEFAULT_RPC_HEALTH_CHECK_INTERVAL_MS = 30_000;

/**
 * Validates an RPC endpoint URL at the moment it enters an
 * {@link RpcEndpointPool} (construction or {@link RpcEndpointPool.add}), so
 * that malformed URLs are rejected immediately instead of surfacing as
 * confusing network errors on the first request.
 *
 * Accepted formats: absolute `http://` or `https://` URLs with a hostname,
 * e.g. `https://soroban-testnet.stellar.org`.
 */
function assertValidRpcUrl(rpcUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rpcUrl);
  } catch (cause) {
    throw new Error(
      `Invalid RPC URL: "${rpcUrl}" — must be an absolute http(s) URL, ` +
        `e.g. "https://soroban-testnet.stellar.org"`,
      { cause },
    );
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `Invalid RPC URL: "${rpcUrl}" — only http(s) endpoints are supported ` +
        `(got protocol "${parsed.protocol}")`,
    );
  }

  if (parsed.hostname.length === 0) {
    throw new Error(`Invalid RPC URL: "${rpcUrl}" — URL must include a hostname`);
  }

  return parsed;
}

/**
 * Payloads larger than this (in bytes, measured on the UTF-8 encoded JSON
 * body) are gzip-compressed before being sent to the RPC endpoint.
 */
export const DEFAULT_COMPRESSION_THRESHOLD_BYTES = 1024;

/** Content-Encoding used for compressed RPC payloads. */
export const RPC_COMPRESSION_ENCODING = 'gzip';

/**
 * Cumulative compression statistics, so callers can measure the savings
 * achieved by compressing large RPC payloads.
 */
export interface RpcCompressionStats {
  /** Number of request bodies that were compressed. */
  compressedRequests: number;
  /** Number of request bodies sent uncompressed. */
  uncompressedRequests: number;
  /** Total bytes of the uncompressed request bodies. */
  requestBytesBefore: number;
  /** Total bytes actually sent for those request bodies. */
  requestBytesAfter: number;
  /** Number of responses that were decompressed. */
  decompressedResponses: number;
  /** Number of responses that could not be decompressed and were used as-is. */
  decompressionFallbacks: number;
  /** Total bytes of compressed responses received. */
  responseBytesBefore: number;
  /** Total bytes of responses after decompression. */
  responseBytesAfter: number;
}

/** Result of compressing a request body. */
export interface CompressedPayload {
  /** The body to send (compressed when `compressed` is `true`). */
  body: Uint8Array;
  /** Whether the body was compressed. */
  compressed: boolean;
  /** Size of the original (uncompressed) body in bytes. */
  originalBytes: number;
  /** Size of the returned body in bytes. */
  bytes: number;
}

/**
 * Compresses a JSON request body when it exceeds `thresholdBytes`. Compression
 * is skipped (and the original bytes returned) when the body is small, when
 * compression is disabled, or when compression fails or does not reduce the
 * payload size — so an unsupported or unhelpful compressor never breaks a
 * request.
 */
export function compressRpcPayload(
  body: string | Uint8Array,
  thresholdBytes: number = DEFAULT_COMPRESSION_THRESHOLD_BYTES,
): CompressedPayload {
  const raw = typeof body === 'string' ? new TextEncoder().encode(body) : body;
  const originalBytes = raw.byteLength;

  if (originalBytes <= thresholdBytes) {
    return { body: raw, compressed: false, originalBytes, bytes: originalBytes };
  }

  try {
    const compressed = new Uint8Array(gzipSync(raw));
    if (compressed.byteLength >= originalBytes) {
      return { body: raw, compressed: false, originalBytes, bytes: originalBytes };
    }
    return { body: compressed, compressed: true, originalBytes, bytes: compressed.byteLength };
  } catch {
    return { body: raw, compressed: false, originalBytes, bytes: originalBytes };
  }
}

/**
 * Decompresses a gzip-encoded RPC response body. When decompression is not
 * possible (unsupported encoding, corrupt payload, or a compressor that is
 * unavailable in the current runtime) the original bytes are returned
 * unchanged so the caller can still parse the response.
 */
export function decompressRpcPayload(
  body: Uint8Array,
  contentEncoding?: string | null,
): { body: Uint8Array; decompressed: boolean } {
  const encoding = (contentEncoding ?? '').trim().toLowerCase();
  if (encoding !== RPC_COMPRESSION_ENCODING && encoding !== 'x-gzip') {
    return { body, decompressed: false };
  }

  try {
    return { body: new Uint8Array(gunzipSync(body)), decompressed: true };
  } catch {
    return { body, decompressed: false };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wraps a promise with a timeout; rejects if the promise doesn't settle within ms. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  if (ms <= 0) {
    return promise;
  }

  const TIMEOUT_SYMBOL = Symbol('timeout');
  return Promise.race<T | typeof TIMEOUT_SYMBOL>([
    promise,
    new Promise<typeof TIMEOUT_SYMBOL>((resolve) => {
      setTimeout(() => resolve(TIMEOUT_SYMBOL), ms);
    }),
  ]).then((result) => {
    if (result === TIMEOUT_SYMBOL) {
      throw new Error(`Request timed out, timeout exceeded ${ms}ms`);
    }
    return result as T;
  });
}

export function isRetryableRpcConnectionError(error: unknown): boolean {
  const CONNECTION_FRAGMENTS = [
    'fetch failed',
    'network error',
    'failed to fetch',
    'econnrefused',
    'etimedout',
    'timeout',
    'socket hang up',
    'enotfound',
    'econnreset',
    'too many requests',
    'rate limit',
    'bad gateway',
    'service unavailable',
    'gateway timeout',
  ];

  // HTTP status codes for rate-limiting and server overload (429, 502, 503,
  // 504) — matched as whole numbers so they don't fire on unrelated digits
  // embedded in a larger number.
  const RETRYABLE_STATUS_CODE = /\b(429|502|503|504)\b/;

  // "connect" as a verb ("could not connect", "failed to connect") is a real
  // connection failure, but the same substring also appears in unrelated
  // application-level wallet state ("wallet not connected", "signer
  // disconnected") — exclude those via the "disconnect"/"connected" forms.
  const CONNECT_VERB = /(?<!dis)connect(?!ed)/i;

  const matches = (text: string): boolean => {
    const lower = text.toLowerCase();
    return (
      CONNECTION_FRAGMENTS.some((fragment) => lower.includes(fragment)) ||
      RETRYABLE_STATUS_CODE.test(text) ||
      CONNECT_VERB.test(text)
    );
  };

  if (error instanceof Error) {
    return matches(error.message);
  }

  // Plain strings (some runtimes throw strings directly)
  if (typeof error === 'string') {
    return matches(error);
  }

  // DOMException and DOMException-like objects ({ name, message })
  if (typeof error === 'object' && error !== null) {
    const obj = error as Record<string, unknown>;
    if (typeof obj['message'] === 'string' && matches(obj['message'])) {
      return true;
    }
    if (typeof obj['name'] === 'string' && matches(obj['name'])) {
      return true;
    }
  }

  return false;
}

/**
 * Detects whether an error is specifically a timeout (as opposed to a generic
 * connection failure). Timeout errors are retried with exponential backoff
 * because a slow-but-healthy RPC endpoint may simply need more time, whereas
 * other connection errors are handled by endpoint failover.
 */
export function isRpcTimeoutError(error: unknown): boolean {
  const TIMEOUT_FRAGMENTS = ['timeout', 'timed out', 'etimedout', 'deadline exceeded'];

  const matches = (text: string): boolean => {
    const lower = text.toLowerCase();
    return TIMEOUT_FRAGMENTS.some((fragment) => lower.includes(fragment));
  };

  if (error instanceof Error) {
    return matches(error.message) || matches(error.name);
  }

  if (typeof error === 'string') {
    return matches(error);
  }

  if (typeof error === 'object' && error !== null) {
    const obj = error as Record<string, unknown>;
    if (typeof obj['message'] === 'string' && matches(obj['message'])) {
      return true;
    }
    if (typeof obj['name'] === 'string' && matches(obj['name'])) {
      return true;
    }
  }

  return false;
}

/**
 * Milliseconds to wait after a failover before opportunistically retrying
 * the originally preferred (first-listed) RPC endpoint again. Without this,
 * a single transient blip on the primary endpoint would pin the pool to
 * whichever backup it failed over to for the rest of the process's lifetime.
 */
const DEFAULT_FAILOVER_COOLDOWN_MS = 60_000;

/**
 * Default number of consecutive failures before an endpoint is quarantined
 * by the circuit breaker.
 */
export const DEFAULT_CIRCUIT_BREAKER_THRESHOLD = 5;

/**
 * Default cooldown (ms) before a quarantined endpoint is eligible to be
 * retried again.
 */
export const DEFAULT_CIRCUIT_BREAKER_COOLDOWN_MS = 30_000;

/**
 * Per-endpoint circuit-breaker state.
 */
interface EndpointCircuitState {
  /** Number of consecutive failures recorded for this endpoint. */
  failureCount: number;
  /** Timestamp (ms) when the endpoint was quarantined, or null if not quarantined. */
  quarantinedAt: number | null;
}

/**
 * Options for configuring the circuit breaker behaviour of
 * {@link RpcEndpointPool}.
 */
export interface CircuitBreakerOptions {
  /**
   * Maximum consecutive failures before an endpoint is quarantined.
   * Defaults to {@link DEFAULT_CIRCUIT_BREAKER_THRESHOLD}.
   */
  threshold?: number;
  /**
   * Cooldown in milliseconds before a quarantined endpoint is eligible to
   * be retried. Defaults to {@link DEFAULT_CIRCUIT_BREAKER_COOLDOWN_MS}.
   */
  cooldownMs?: number;
}

/**
 * Terminal transaction statuses reported by `getTransaction`. A transaction
 * in any of these states has already been resolved on-chain, so a fee-bump
 * must NOT be submitted for it (doing so risks a duplicate operation).
 */
const TERMINAL_TRANSACTION_STATUSES = new Set(['SUCCESS', 'FAILED']);

/**
 * Queries the network for the current status of a submitted transaction.
 *
 * Returns `true` when the transaction has reached a terminal state
 * (`SUCCESS` or `FAILED`) and therefore must not be fee-bumped, and `false`
 * when it is still pending (e.g. `NOT_FOUND`) or its status cannot be
 * determined. Callers that gate a fee-bump on this result should treat an
 * indeterminate status as "still pending" so a genuinely stuck transaction
 * is not left unbumped.
 */
export async function isTransactionResolved(
  server: SoroWillRpcServer,
  transactionHash: string,
): Promise<boolean> {
  try {
    const response = await server.pollTransaction(transactionHash, { attempts: 1 });
    const status = (response as { status?: unknown }).status;
    return typeof status === 'string' && TERMINAL_TRANSACTION_STATUSES.has(status);
  } catch {
    // A lookup failure (e.g. the transaction is not yet indexed) means we
    // cannot confirm resolution, so report it as unresolved and allow the
    // caller to proceed with the bump.
    return false;
  }
}

/** Default number of confirmations (ledgers) required for finality. */
export const DEFAULT_FINALITY_CONFIRMATIONS = 1;

/** Default interval between finality status polls, in milliseconds. */
export const DEFAULT_FINALITY_POLL_INTERVAL_MS = 1_000;

/** Default overall timeout for waiting on finality, in milliseconds. */
export const DEFAULT_FINALITY_TIMEOUT_MS = 60_000;

/**
 * Finality status of a submitted transaction.
 *
 * - `finalized` — the transaction succeeded and is buried under at least the
 *   requested number of confirmations.
 * - `failed` — the transaction reached a terminal `FAILED` state on-chain.
 * - `pending` — the transaction is not yet included in a ledger.
 * - `timeout` — the transaction did not reach finality within the timeout.
 */
export type FinalityStatus = 'finalized' | 'failed' | 'pending' | 'timeout';

/** Result of {@link waitForTransactionFinality}. */
export interface TransactionFinalityResult {
  /** The transaction hash that was checked. */
  hash: string;
  /** Finality status at the time the check settled. */
  status: FinalityStatus;
  /** Number of confirmations observed (0 while pending). */
  confirmations: number;
  /** Number of confirmations that were required. */
  requiredConfirmations: number;
  /** Ledger sequence the transaction was included in, when known. */
  ledger?: number;
  /** Latest ledger sequence observed while polling, when known. */
  latestLedger?: number;
  /** Total time spent waiting, in milliseconds. */
  elapsedMs: number;
}

/** Options for {@link waitForTransactionFinality}. */
export interface WaitForTransactionFinalityOptions {
  /** Transaction hash to check. */
  hash: string;
  /**
   * Number of confirmations (ledgers on top of the inclusion ledger) required
   * before the transaction is considered final. Defaults to
   * {@link DEFAULT_FINALITY_CONFIRMATIONS}.
   */
  confirmations?: number;
  /** Overall timeout in milliseconds. Defaults to {@link DEFAULT_FINALITY_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Delay between status polls in milliseconds. Defaults to {@link DEFAULT_FINALITY_POLL_INTERVAL_MS}. */
  pollIntervalMs?: number;
  /** Optional RPC server override (e.g. a pooled/failover server). */
  server?: SoroWillRpcServer;
  /** Optional abort signal to stop waiting early. */
  signal?: AbortSignal;
}

/** Minimal RPC surface needed to check finality. */
interface FinalityRpcServer {
  getTransaction(hash: string): Promise<rpc.Api.GetTransactionResponse>;
  getLatestLedger?(): Promise<{ sequence: number }>;
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer, received ${value}`);
  }
}

/**
 * Checks the finality of a transaction once, without waiting.
 *
 * A transaction is `finalized` when it succeeded and the latest ledger is at
 * least `confirmations` ledgers ahead of its inclusion ledger. It is `failed`
 * when the network reports a terminal `FAILED` status, and `pending` when it
 * has not been included yet (or its status cannot be determined).
 */
export async function checkTransactionFinality(
  server: FinalityRpcServer,
  hash: string,
  confirmations: number = DEFAULT_FINALITY_CONFIRMATIONS,
): Promise<TransactionFinalityResult> {
  assertNonNegativeInteger(confirmations, 'confirmations');

  const startedAt = Date.now();
  const base: TransactionFinalityResult = {
    hash,
    status: 'pending',
    confirmations: 0,
    requiredConfirmations: confirmations,
    elapsedMs: 0,
  };

  let response: rpc.Api.GetTransactionResponse;
  try {
    response = await server.getTransaction(hash);
  } catch {
    // Not indexed yet (or a transient lookup failure): treat as pending.
    return base;
  }

  const status = (response as { status?: unknown }).status;
  if (status === rpc.Api.GetTransactionStatus.FAILED) {
    return { ...base, status: 'failed', elapsedMs: Date.now() - startedAt };
  }
  if (status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    return base;
  }

  const ledger = (response as { ledger?: unknown }).ledger;
  const inclusionLedger = typeof ledger === 'number' ? ledger : undefined;

  let latestLedger: number | undefined;
  if (server.getLatestLedger) {
    try {
      latestLedger = (await server.getLatestLedger()).sequence;
    } catch {
      latestLedger = undefined;
    }
  }

  const observed =
    inclusionLedger !== undefined && latestLedger !== undefined
      ? Math.max(0, latestLedger - inclusionLedger)
      : 0;

  const result: TransactionFinalityResult = {
    ...base,
    confirmations: observed,
    elapsedMs: Date.now() - startedAt,
  };
  if (inclusionLedger !== undefined) result.ledger = inclusionLedger;
  if (latestLedger !== undefined) result.latestLedger = latestLedger;

  if (observed >= confirmations) {
    result.status = 'finalized';
  }
  return result;
}

/**
 * Waits until a transaction is finalized (succeeded and buried under
 * `confirmations` ledgers), fails on-chain, or the timeout elapses.
 *
 * Never throws for a transaction that simply does not land in time: the
 * returned {@link TransactionFinalityResult} carries `status: 'timeout'` so
 * callers can decide whether to retry, fee-bump, or surface an error.
 */
export async function waitForTransactionFinality(
  options: WaitForTransactionFinalityOptions,
): Promise<TransactionFinalityResult> {
  const confirmations = options.confirmations ?? DEFAULT_FINALITY_CONFIRMATIONS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_FINALITY_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_FINALITY_POLL_INTERVAL_MS;

  assertNonNegativeInteger(confirmations, 'confirmations');
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new RangeError(`timeoutMs must be a non-negative number, received ${timeoutMs}`);
  }
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new RangeError(`pollIntervalMs must be a positive number, received ${pollIntervalMs}`);
  }

  const server = options.server as FinalityRpcServer | undefined;
  if (!server) {
    throw new Error('waitForTransactionFinality requires an RPC server');
  }

  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let last: TransactionFinalityResult = {
    hash: options.hash,
    status: 'pending',
    confirmations: 0,
    requiredConfirmations: confirmations,
    elapsedMs: 0,
  };

  for (;;) {
    if (options.signal?.aborted) {
      return { ...last, status: 'timeout', elapsedMs: Date.now() - startedAt };
    }

    last = await checkTransactionFinality(server, options.hash, confirmations);
    if (last.status === 'finalized' || last.status === 'failed') {
      return { ...last, elapsedMs: Date.now() - startedAt };
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return { ...last, status: 'timeout', elapsedMs: Date.now() - startedAt };
    }

    await sleep(Math.min(pollIntervalMs, remainingMs));
  }
}

/**
 * Maximum number of recent latency samples kept per endpoint for weighted
 * selection. Older samples are evicted to keep the window current.
 */
export const LATENCY_HISTORY_WINDOW = 10;

export class RpcEndpointPool {
  private readonly servers: SoroWillRpcServer[] = [];
  private readonly rpcUrls: string[] = [];
  private readonly serverOverride: SoroWillRpcServer | undefined;
  private readonly failoverCooldownMs: number;
  private readonly timeoutMs: number;
  private readonly timeoutMaxAttempts: number;
  private readonly timeoutRetryBaseDelayMs: number;
  private readonly circuitBreakerThreshold: number;
  private readonly circuitBreakerCooldownMs: number;
  private readonly endpointBackoffBaseMs: number;
  private readonly endpointBackoffMaxMs: number;
  private activeIndex = 0;
  private lastFailoverAt: number | null = null;
  private readonly circuitStates: EndpointCircuitState[];
  private readonly backoffUntil: number[] = [];
  private readonly consecutiveFailures: number[] = [];
  private readonly latencyHistory: number[][] = [];
  /** Last health-check result per endpoint; `undefined` until first checked. */
  private healthy: Array<boolean | undefined> = [];
  private healthTimer: ReturnType<typeof setInterval> | undefined;
  private readonly compressionThresholdBytes: number;
  private readonly compressionStats: RpcCompressionStats = {
    compressedRequests: 0,
    uncompressedRequests: 0,
    requestBytesBefore: 0,
    requestBytesAfter: 0,
    decompressedResponses: 0,
    decompressionFallbacks: 0,
    responseBytesBefore: 0,
    responseBytesAfter: 0,
  };

  /**
   * @param serverOverride - When provided (e.g. `SoroWillClientOptions.rpcServer`
   * in tests), every endpoint in the pool uses this server instead of
   * constructing a real `rpc.Server` per URL. Without this, `withFailover`
   * would silently bypass an injected test double and hit the real network.
   * @param failoverCooldownMs - How long to keep using a backup endpoint
   * after a failover before opportunistically retrying the primary
   * (first-listed) endpoint again. Defaults to {@link DEFAULT_FAILOVER_COOLDOWN_MS}.
   * @param timeoutMs - Per-request RPC timeout in milliseconds. Defaults to
   * {@link DEFAULT_RPC_TIMEOUT_MS} (30s).
   * @param timeoutMaxAttempts - Maximum attempts (initial try + retries) for
   * timeout errors. Defaults to {@link DEFAULT_RPC_TIMEOUT_MAX_ATTEMPTS}.
   * @param timeoutRetryBaseDelayMs - Base delay for exponential backoff on
   * timeout errors. Defaults to {@link DEFAULT_RPC_TIMEOUT_RETRY_BASE_DELAY_MS}.
   * @param circuitBreaker - Optional circuit breaker configuration. When
   * provided, endpoints that exceed the failure threshold are quarantined
   * and skipped during failover until the cooldown elapses.
   */
  constructor(
    rpcUrls: readonly string[],
    serverOverride?: SoroWillRpcServer,
    failoverCooldownMs: number = DEFAULT_FAILOVER_COOLDOWN_MS,
    timeoutMs: number = DEFAULT_RPC_TIMEOUT_MS,
    timeoutMaxAttempts: number = DEFAULT_RPC_TIMEOUT_MAX_ATTEMPTS,
    timeoutRetryBaseDelayMs: number = DEFAULT_RPC_TIMEOUT_RETRY_BASE_DELAY_MS,
    endpointBackoffBaseMs: number = DEFAULT_RPC_ENDPOINT_BACKOFF_BASE_MS,
    endpointBackoffMaxMs: number = DEFAULT_RPC_ENDPOINT_BACKOFF_MAX_MS,
    circuitBreaker?: CircuitBreakerOptions,
  ) {
    const normalizedRpcUrls = rpcUrls
      .map((rpcUrl) => rpcUrl.trim())
      .filter((rpcUrl) => rpcUrl.length > 0);

    if (normalizedRpcUrls.length === 0) {
      throw new Error('At least one RPC URL must be configured');
    }

    // Reject malformed or non-http(s) URLs immediately rather than letting
    // them surface later as confusing network errors on the first request.
    for (const rpcUrl of normalizedRpcUrls) {
      assertValidRpcUrl(rpcUrl);
    }

    const uniqueRpcUrls = Array.from(new Set(normalizedRpcUrls));

    this.rpcUrls.push(...uniqueRpcUrls);
    this.serverOverride = serverOverride;
    this.failoverCooldownMs = failoverCooldownMs;
    this.timeoutMs = timeoutMs;
    this.timeoutMaxAttempts = Math.max(1, timeoutMaxAttempts);
    this.timeoutRetryBaseDelayMs = timeoutRetryBaseDelayMs;
    this.circuitBreakerThreshold = circuitBreaker?.threshold ?? DEFAULT_CIRCUIT_BREAKER_THRESHOLD;
    this.circuitBreakerCooldownMs = circuitBreaker?.cooldownMs ?? DEFAULT_CIRCUIT_BREAKER_COOLDOWN_MS;
    this.endpointBackoffBaseMs = endpointBackoffBaseMs;
    this.endpointBackoffMaxMs = endpointBackoffMaxMs;
    this.compressionThresholdBytes = DEFAULT_COMPRESSION_THRESHOLD_BYTES;
    this.circuitStates = uniqueRpcUrls.map(() => ({
      failureCount: 0,
      quarantinedAt: null,
    }));
    this.backoffUntil = uniqueRpcUrls.map(() => 0);
    this.consecutiveFailures = uniqueRpcUrls.map(() => 0);
    this.latencyHistory = uniqueRpcUrls.map(() => []);
    this.healthy = uniqueRpcUrls.map(() => undefined);
    this.servers = serverOverride
      ? uniqueRpcUrls.map(() => serverOverride)
      : uniqueRpcUrls.map(
          (rpcUrl) =>
            new rpc.Server(rpcUrl, {
              allowHttp: rpcUrl.startsWith('http://'),
              timeout: timeoutMs,
            }),
        );
  }

  /**
   * Re-promotes the primary (first-listed) endpoint once the cooldown since
   * the last failover has elapsed, giving it a chance to be retried after a
   * transient outage recovers instead of being abandoned permanently.
   */
  private maybeRepromotePrimaryEndpoint(): void {
    if (
      this.activeIndex !== 0 &&
      this.lastFailoverAt !== null &&
      Date.now() - this.lastFailoverAt >= this.failoverCooldownMs
    ) {
      this.activeIndex = 0;
      this.lastFailoverAt = null;
    }
  }

  /** Whether an endpoint is still inside its backoff window. */
  private isEndpointUnderBackoff(index: number): boolean {
    return Date.now() < (this.backoffUntil[index] ?? 0);
  }

  /**
   * Records a retryable failure for an endpoint and schedules its
   * exponential backoff: `base * 2^(consecutiveFailures - 1)`, capped at
   * `endpointBackoffMaxMs`.
   */
  private recordEndpointBackoff(index: number): void {
    const failures = (this.consecutiveFailures[index] ?? 0) + 1;
    this.consecutiveFailures[index] = failures;
    const exponentialDelay = this.endpointBackoffBaseMs * 2 ** (failures - 1);
    this.backoffUntil[index] = Date.now() + Math.min(exponentialDelay, this.endpointBackoffMaxMs);
  }

  /** Clears the backoff state of an endpoint after a successful request. */
  private clearEndpointBackoff(index: number): void {
    this.consecutiveFailures[index] = 0;
    this.backoffUntil[index] = 0;
  }

  /**
   * Records a successful request latency sample for the endpoint at `index`.
   * Keeps at most {@link LATENCY_HISTORY_WINDOW} recent samples per endpoint.
   */
  private recordEndpointLatency(index: number, latencyMs: number): void {
    const history = this.latencyHistory[index];
    if (history === undefined) return;
    history.push(latencyMs);
    if (history.length > LATENCY_HISTORY_WINDOW) {
      history.shift();
    }
  }

  /**
   * Returns the average latency (ms) recorded for the endpoint at `index`,
   * or `Infinity` when no samples exist yet (so unsampled endpoints are
   * deprioritised relative to known-fast ones but still tried).
   */
  getAverageLatency(index: number): number {
    const history = this.latencyHistory[index];
    if (!history || history.length === 0) return Infinity;
    return history.reduce((sum: number, ms: number) => sum + ms, 0) / history.length;
  }

  /**
   * Returns the latency history samples for the endpoint at `index`.
   * Exposed for testing and diagnostics.
   */
  getLatencyHistory(index: number): readonly number[] {
    return this.latencyHistory[index] ?? [];
  }

  /**
   * Returns the number of endpoints in the pool.
   */
  get size(): number {
    return this.servers.length;
  }

  /**
   * Adds a new RPC endpoint to the pool. The URL is validated before being
   * added. If the URL is already in the pool, this is a no-op. Surrounding
   * whitespace is trimmed.
   */
  add(rpcUrl: string): void {
    const normalizedUrl = rpcUrl.trim();

    if (normalizedUrl.length === 0) {
      throw new Error(
        `Invalid RPC URL: "" — must be an absolute http(s) URL, ` +
          `e.g. "https://soroban-testnet.stellar.org"`,
      );
    }

    // Validate the URL format and protocol
    assertValidRpcUrl(normalizedUrl);

    // Skip if already in the pool
    if (this.rpcUrls.includes(normalizedUrl)) {
      return;
    }

    // Add to tracking arrays
    this.rpcUrls.push(normalizedUrl);
    this.circuitStates.push({ failureCount: 0, quarantinedAt: null });
    this.backoffUntil.push(0);
    this.consecutiveFailures.push(0);
    this.latencyHistory.push([]);
    this.healthy.push(undefined);

    // Create server for the new endpoint
    const server = this.serverOverride
      ? this.serverOverride
      : new rpc.Server(normalizedUrl, {
          allowHttp: normalizedUrl.startsWith('http://'),
          timeout: this.timeoutMs,
        });
    this.servers.push(server);
  }

  /**
   * Picks the endpoint a request should be routed to using weighted selection
   * by latency history (#636). Endpoints with lower average latency are
   * preferred. Endpoints that are backing off or quarantined are skipped.
   * Falls back to the active endpoint if every candidate is unavailable.
   */
  private selectEndpointIndex(): number {
    let bestIndex = -1;
    let bestLatency = Infinity;

    // Check if the active endpoint is available (not backed off or quarantined)
    const activeIsAvailable = !this.isEndpointUnderBackoff(this.activeIndex) &&
                              !this.isEndpointQuarantined(this.activeIndex) &&
                              !this.isEndpointUnhealthy(this.activeIndex);
    if (activeIsAvailable) {
      // Prefer the active endpoint when it's available, to maintain sticky
      // routing and to retry endpoints after their backoff expires.
      return this.activeIndex;
    }

    for (let offset = 0; offset < this.servers.length; offset += 1) {
      const index = (this.activeIndex + offset) % this.servers.length;
      if (this.isEndpointUnderBackoff(index)) continue;
      if (this.isEndpointQuarantined(index)) continue;
      if (this.isEndpointUnhealthy(index)) continue;
      const avg = this.getAverageLatency(index);
      if (avg < bestLatency) {
        bestLatency = avg;
        bestIndex = index;
      }
    }

    // If every endpoint is backing off or quarantined, fall back to active
    return bestIndex === -1 ? this.activeIndex : bestIndex;
  }

  /**
   * Runs `operation` against the active endpoint, retrying timeout errors with
   * exponential backoff before falling back to the next endpoint. Non-timeout
   * connection errors skip straight to failover.
   */
  private async runWithTimeoutRetry<T>(
    operation: (server: SoroWillRpcServer, rpcUrl: string) => Promise<T>,
    server: SoroWillRpcServer,
    rpcUrl: string,
  ): Promise<T> {
    let lastError: unknown;

    for (let attempt = 0; attempt < this.timeoutMaxAttempts; attempt += 1) {
      try {
        // Enforce per-endpoint timeout
        return await withTimeout(operation(server, rpcUrl), this.timeoutMs);
      } catch (error) {
        lastError = error;
        const isLastAttempt = attempt === this.timeoutMaxAttempts - 1;
        if (!isRpcTimeoutError(error) || isLastAttempt) {
          throw error;
        }
        await sleep(
          computeBackoffDelay(attempt, this.timeoutRetryBaseDelayMs, this.endpointBackoffMaxMs),
        );
      }
    }

    throw lastError ?? new Error('RPC timeout retries exhausted');
  }

  /**
   * Returns `true` when the endpoint at `index` is currently quarantined by
   * the circuit breaker (i.e. it has exceeded the failure threshold and the
   * cooldown has not yet elapsed).
   */
  private isEndpointQuarantined(index: number): boolean {
    const state = this.circuitStates[index];
    if (state?.quarantinedAt === null) {
      return false;
    }
    if (state !== undefined && Date.now() - state.quarantinedAt >= this.circuitBreakerCooldownMs) {
      // Cooldown elapsed — allow re-entry by clearing quarantine state.
      state.quarantinedAt = null;
      state.failureCount = 0;
      return false;
    }
    return true;
  }

  /**
   * Records a failure for the endpoint at `index`. When the consecutive
   * failure count reaches the circuit breaker threshold, the circuit opens
   * (the endpoint is quarantined) and routing moves to a backup endpoint.
   */
  private recordEndpointFailure(index: number): void {
    const state = this.circuitStates[index];
    if (state === undefined) {
      return;
    }
    state.failureCount += 1;
    if (state.failureCount >= this.circuitBreakerThreshold && state.quarantinedAt === null) {
      state.quarantinedAt = Date.now();
      this.openCircuit(index);
    }
  }

  /**
   * Opens the circuit for the endpoint at `index`: the endpoint is skipped by
   * {@link RpcEndpointPool.selectEndpointIndex} until the cooldown elapses,
   * and the pool fails over to a backup endpoint if one is available.
   */
  private openCircuit(index: number): void {
    if (this.servers.length < 2) {
      return;
    }
    if (this.activeIndex === index) {
      this.lastFailoverAt = Date.now();
      this.activeIndex = (index + 1) % this.servers.length;
    }
  }

  /**
   * Returns the number of consecutive failures recorded for the endpoint at
   * `index`. Exposed for testing and diagnostics.
   */
  getEndpointFailureCount(index: number): number {
    return this.circuitStates[index]?.failureCount ?? 0;
  }

  /**
   * Returns `true` when the circuit for the endpoint at `index` is open
   * (quarantined). Exposed for testing and diagnostics.
   */
  isCircuitOpen(index: number): boolean {
    return this.isEndpointQuarantined(index);
  }

  /**
   * Resets the circuit-breaker state for the endpoint at `index` after a
   * successful call.
   */
  private resetEndpointFailure(index: number): void {
    const state = this.circuitStates[index];
    if (state === undefined) {
      return;
    }
    state.failureCount = 0;
    state.quarantinedAt = null;
  }

  async withFailover<T>(operation: (server: SoroWillRpcServer, rpcUrl: string) => Promise<T>): Promise<T> {
    this.maybeRepromotePrimaryEndpoint();
    let lastError: unknown;
    const maxAttempts = Math.max(this.servers.length, this.timeoutMaxAttempts);

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      // Route to the latency-weighted best available endpoint.
      const index = this.selectEndpointIndex();
      const rpcUrl = this.rpcUrls[index];
      const server = this.servers[index];

      if (!rpcUrl || !server) {
        break;
      }

      // Skip endpoints quarantined by the circuit breaker.
      if (this.isEndpointQuarantined(index)) {
        // Advance past the quarantined endpoint without consuming a real
        // attempt, so the loop can try the next available endpoint.
        if (this.activeIndex === index) {
          this.activeIndex = (index + 1) % this.servers.length;
        }
        continue;
      }

      // If every endpoint is under backoff (or only a single endpoint exists),
      // wait out the exponential backoff window instead of hammering the endpoint.
      if (this.isEndpointUnderBackoff(index)) {
        const remainingMs = Math.max(0, (this.backoffUntil[index] ?? 0) - Date.now());
        const delayMs =
          remainingMs > 0
            ? Math.min(remainingMs, this.endpointBackoffMaxMs)
            : computeBackoffDelay(
                Math.max(0, attempt - 1),
                this.endpointBackoffBaseMs,
                this.endpointBackoffMaxMs,
              );
        await sleep(delayMs);
      }

      const startTime = Date.now();
      try {
        const result = await this.runWithTimeoutRetry(operation, server, rpcUrl);
        const latencyMs = Date.now() - startTime;
        // Success — record latency, reset circuit breaker and backoff.
        this.recordEndpointLatency(index, latencyMs);
        this.resetEndpointFailure(index);
        this.clearEndpointBackoff(index);
        return result;
      } catch (error) {
        lastError = error;
        this.recordEndpointFailure(index);
        this.recordEndpointBackoff(index);
        if (!isRetryableRpcConnectionError(error) || attempt === maxAttempts - 1) {
          throw error;
        }
        // Only advance if no concurrent call has already failed over away from this endpoint.
        if (this.activeIndex === index) {
          this.lastFailoverAt = Date.now();
          this.activeIndex = (index + 1) % this.servers.length;
        }
      }
    }

    throw lastError ?? new Error('RPC failover exhausted every configured endpoint');
  }

  /** `true` when the last health check reported the endpoint at `index` as unhealthy. */
  private isEndpointUnhealthy(index: number): boolean {
    return this.healthy[index] === false;
  }

  /**
   * Returns the last health-check result for the endpoint at `index`, or
   * `undefined` when it has not been checked yet.
   */
  getEndpointHealth(index: number): boolean | undefined {
    return this.healthy[index];
  }

  /**
   * Probes one endpoint with `getHealth()`. An endpoint is healthy only when
   * the call succeeds within the request timeout and reports `healthy`. A
   * server without `getHealth` is treated as unhealthy.
   */
  async checkEndpointHealth(index: number): Promise<boolean> {
    const server = this.servers[index];
    let isHealthy = false;
    if (server && typeof server.getHealth === 'function') {
      try {
        const response = await withTimeout(server.getHealth(), this.timeoutMs);
        isHealthy = (response as { status?: unknown }).status === 'healthy';
      } catch {
        isHealthy = false;
      }
    }
    this.healthy[index] = isHealthy;
    return isHealthy;
  }

  /**
   * Checks every endpoint. If the active endpoint is unhealthy, routing moves
   * to the first endpoint that is healthy, so the SDK fails over without
   * waiting for a request to fail first.
   */
  async runHealthChecks(): Promise<void> {
    await Promise.all(this.servers.map((_, index) => this.checkEndpointHealth(index)));
    if (this.healthy[this.activeIndex] !== false) {
      return;
    }
    const nextHealthy = this.healthy.findIndex((state) => state === true);
    if (nextHealthy !== -1 && nextHealthy !== this.activeIndex) {
      this.activeIndex = nextHealthy;
      this.lastFailoverAt = Date.now();
    }
  }

  /**
   * Starts health monitoring: runs a check immediately (startup check) and
   * then re-checks every `intervalMs`, which also retries endpoints that were
   * previously marked unhealthy. The timer is unref'd so it never keeps a
   * Node process alive. Calling this again restarts the timer.
   *
   * @returns A promise that settles once the startup check has finished.
   */
  startHealthMonitoring(intervalMs: number = DEFAULT_RPC_HEALTH_CHECK_INTERVAL_MS): Promise<void> {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      throw new RangeError(`intervalMs must be a positive number, received ${intervalMs}`);
    }
    this.stopHealthMonitoring();
    const tick = (): Promise<void> => this.runHealthChecks().catch(() => {});
    this.healthTimer = setInterval(() => void tick(), intervalMs);
    (this.healthTimer as { unref?: () => void }).unref?.();
    return tick();
  }

  /** Stops periodic health checks started by {@link RpcEndpointPool.startHealthMonitoring}. */
  stopHealthMonitoring(): void {
    if (this.healthTimer !== undefined) {
      clearInterval(this.healthTimer);
      this.healthTimer = undefined;
    }
  }

  getActiveRpcUrl(): string {
    const rpcUrl = this.rpcUrls[this.activeIndex];
    if (!rpcUrl) {
      throw new Error('No active RPC URL is configured');
    }
    return rpcUrl;
  }

  /**
   * Rotates the active RPC endpoint to the next one in the pool, e.g. after a
   * failover or when the caller wants to proactively switch endpoints.
   *
   * @throws {Error} If the pool is empty (no endpoints configured).
   * @returns The newly active RPC endpoint URL.
   */
  rotate(): string {
    if (this.servers.length === 0) {
      throw new Error(
        'Cannot rotate RPC endpoint pool: no endpoints are configured. Add at least one RPC URL before rotating.',
      );
    }
    this.lastFailoverAt = Date.now();
    this.activeIndex = (this.activeIndex + 1) % this.servers.length;
    return this.getActiveRpcUrl();
  }

  /**
   * Returns the RPC server bound to the pool's *current* active endpoint.
   *
   * Callers that cache a server reference (e.g. `getNetworkFeeStats` on a
   * fresh client instance) would otherwise keep talking to whichever
   * endpoint was active when the reference was captured, detaching from the
   * client's current network context after a network switch or failover.
   * Resolving the server lazily through this accessor keeps fee queries
   * pinned to the live network context.
   */
  /**
   * Probes every configured endpoint's `getHealth()` method in parallel,
   * updating latency history, failure counts, and backoff state. If the
   * currently active endpoint is unhealthy and another endpoint is healthy,
   * automatically fails over to the healthiest (lowest-latency) endpoint.
   */
  async checkEndpointsHealth(): Promise<Array<{ url: string; healthy: boolean; latencyMs?: number }>> {
    const results = await Promise.all(
      this.servers.map(async (server, index) => {
        const url = this.rpcUrls[index]!;
        if (typeof server.getHealth !== 'function') {
          return { url, healthy: true };
        }
        const startTime = Date.now();
        try {
          const res = await withTimeout(server.getHealth(), this.timeoutMs);
          const latencyMs = Date.now() - startTime;
          const healthy = res?.status === 'healthy';
          if (healthy) {
            this.recordEndpointLatency(index, latencyMs);
            this.resetEndpointFailure(index);
            this.clearEndpointBackoff(index);
          } else {
            this.recordEndpointFailure(index);
            this.recordEndpointBackoff(index);
          }
          return { url, healthy, latencyMs };
        } catch {
          this.recordEndpointFailure(index);
          this.recordEndpointBackoff(index);
          return { url, healthy: false };
        }
      }),
    );

    if (results[this.activeIndex] && !results[this.activeIndex]!.healthy) {
      let bestHealthyIndex = -1;
      let bestLatency = Infinity;
      for (let i = 0; i < results.length; i += 1) {
        const entry = results[i];
        if (entry?.healthy) {
          const latency = entry.latencyMs ?? Infinity;
          if (bestHealthyIndex === -1 || latency < bestLatency) {
            bestHealthyIndex = i;
            bestLatency = latency;
          }
        }
      }
      if (bestHealthyIndex !== -1) {
        this.activeIndex = bestHealthyIndex;
        this.lastFailoverAt = Date.now();
      }
    }

    return results;
  }

  getActiveServer(): SoroWillRpcServer {
    this.maybeRepromotePrimaryEndpoint();
    const server = this.servers[this.activeIndex];
    if (!server) {
      throw new Error('No active RPC server is configured');
    }
    return server;
  }

  /**
   * Compresses a JSON-RPC request body when it exceeds the compression
   * threshold, recording the byte savings. Returns the body to send and the
   * headers that describe it.
   */
  prepareRequestPayload(body: string | Uint8Array): {
    body: Uint8Array;
    headers: Record<string, string>;
  } {
    const result = compressRpcPayload(body, this.compressionThresholdBytes);
    this.compressionStats.requestBytesBefore += result.originalBytes;
    this.compressionStats.requestBytesAfter += result.bytes;
    if (result.compressed) {
      this.compressionStats.compressedRequests += 1;
      return {
        body: result.body,
        headers: {
          'Content-Encoding': RPC_COMPRESSION_ENCODING,
          'Content-Type': 'application/json',
        },
      };
    }
    this.compressionStats.uncompressedRequests += 1;
    return { body: result.body, headers: { 'Content-Type': 'application/json' } };
  }

  /**
   * Decompresses a response body according to its `Content-Encoding` header,
   * falling back to the raw bytes when compression is unsupported or the
   * payload cannot be decoded.
   */
  readResponsePayload(
    body: Uint8Array,
    contentEncoding?: string | null,
  ): { body: Uint8Array; decompressed: boolean } {
    const result = decompressRpcPayload(body, contentEncoding);
    if (result.decompressed) {
      this.compressionStats.decompressedResponses += 1;
      this.compressionStats.responseBytesBefore += body.byteLength;
      this.compressionStats.responseBytesAfter += result.body.byteLength;
    } else if ((contentEncoding ?? '').trim().length > 0) {
      this.compressionStats.decompressionFallbacks += 1;
    }
    return result;
  }

  /** Snapshot of the cumulative compression statistics for this pool. */
  getCompressionStats(): RpcCompressionStats {
    return { ...this.compressionStats };
  }

  /**
   * Measures the savings achieved so far. Ratios are `0` when no bytes have
   * been processed yet.
   */
  getCompressionSavings(): {
    requestBytesSaved: number;
    requestSavingsRatio: number;
    responseBytesSaved: number;
    responseSavingsRatio: number;
  } {
    const stats = this.compressionStats;
    const requestBytesSaved = stats.requestBytesBefore - stats.requestBytesAfter;
    const responseBytesSaved = stats.responseBytesAfter - stats.responseBytesBefore;
    return {
      requestBytesSaved,
      requestSavingsRatio:
        stats.requestBytesBefore > 0 ? requestBytesSaved / stats.requestBytesBefore : 0,
      responseBytesSaved,
      responseSavingsRatio:
        stats.responseBytesAfter > 0 ? responseBytesSaved / stats.responseBytesAfter : 0,
    };
  }
}
