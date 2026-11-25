import {
  FeeBumpTransaction,
  Keypair,
  Transaction,
  TransactionBuilder,
  rpc,
  xdr,
} from '@stellar/stellar-sdk';

import { InvalidPublicKeyError, InvalidSecretKeyError, SoroWillError } from './errors';
import { NETWORK_CONFIG, type SoroWillNetwork, type SoroWillRpcServer } from './SoroWillClient';
import { RpcEndpointPool } from './rpc';

interface SendTransactionErrorResponse {
  status: string;
  hash?: string;
  diagnosticEventsXdr?: string;
  errorResultXdr?: string;
}

/** The Stellar base fee, in stroops (0.00001 XLM). */
export const BASE_FEE = '100';

/** Default maximum multiple of the base fee allowed for a fee-bump. */
export const DEFAULT_MAX_FEE_MULTIPLIER = 10000;

/**
 * Default age, in milliseconds, after which a {@link FeeEstimate} is
 * considered stale and is re-estimated before submission.
 */
export const DEFAULT_FEE_STALENESS_THRESHOLD_MS = 30_000;

/**
 * A fee-bump fee estimate and the time it was produced. Pass it to
 * {@link submitFeeBump} so the fee can be re-estimated if the network's
 * inclusion-fee baseline may have moved before submission.
 */
export interface FeeEstimate {
  /**
   * The estimated per-operation base fee for the fee-bump, in stroops — the
   * value passed to `TransactionBuilder.buildFeeBumpTransaction`, which
   * multiplies it by the operation count and adds the Soroban resource fee.
   */
  fee: string;
  /** Epoch milliseconds at which the estimate was produced. */
  estimatedAt: number;
}

/** Options for {@link estimateFeeBumpFee}. */
export interface EstimateFeeBumpFeeOptions {
  /** The network to use. */
  network: SoroWillNetwork;
  /** The base64-encoded XDR of the prepared inner transaction. */
  innerTransactionXdr: string;
  /** Optional RPC server to use instead of the network's configured endpoints (e.g. for tests). */
  rpcServer?: SoroWillRpcServer;
  /**
   * Optional bounds applied to the dynamically estimated fee. The estimate is
   * clamped to `[minFee, maxFee]` (in stroops) after network-load adjustment.
   */
  bounds?: FeeEstimationBounds;
}

/**
 * Configurable bounds for smart fee estimation, in stroops.
 *
 * - `minFee` — never bid below this per-operation fee (defaults to {@link BASE_FEE}).
 * - `maxFee` — never bid above this per-operation fee (defaults to
 *   {@link DEFAULT_MAX_FEE_MULTIPLIER} × {@link BASE_FEE}).
 */
export interface FeeEstimationBounds {
  /** Minimum per-operation fee in stroops. */
  minFee?: string | number | bigint;
  /** Maximum per-operation fee in stroops. */
  maxFee?: string | number | bigint;
}

/** Default lower bound for smart fee estimation, in stroops. */
export const DEFAULT_MIN_ESTIMATED_FEE = BASE_FEE;

/** Default upper bound for smart fee estimation, in stroops. */
export const DEFAULT_MAX_ESTIMATED_FEE = String(
  BigInt(BASE_FEE) * BigInt(DEFAULT_MAX_FEE_MULTIPLIER),
);

/** A snapshot of network fee load used to adjust fee estimates. */
export interface NetworkFeeLoad {
  /** p90 Soroban inclusion fee reported by the network, in stroops. */
  sorobanInclusionFeeP90: string;
  /** p90 classic inclusion fee reported by the network, in stroops. */
  inclusionFeeP90: string;
  /** Ratio of the p90 to the p50 Soroban inclusion fee (1 when unknown). */
  loadRatio: number;
  /** Whether the network is considered congested (load ratio above the threshold). */
  congested: boolean;
}

/** Options for {@link estimateSmartFee}. */
export interface EstimateSmartFeeOptions extends EstimateFeeBumpFeeOptions {
  /**
   * Load ratio (p90 / p50) above which the estimate is scaled up as
   * congested. Defaults to {@link DEFAULT_CONGESTION_LOAD_RATIO}.
   */
  congestionLoadRatio?: number;
  /**
   * Multiplier applied to the p90 baseline when the network is congested.
   * Defaults to {@link DEFAULT_CONGESTION_MULTIPLIER}.
   */
  congestionMultiplier?: number;
}

/** Default p90/p50 ratio above which the network is treated as congested. */
export const DEFAULT_CONGESTION_LOAD_RATIO = 2;

/** Default multiplier applied to the p90 baseline under congestion. */
export const DEFAULT_CONGESTION_MULTIPLIER = 1.5;

/** Resolves configurable fee bounds, validating and ordering them. */
export function resolveFeeEstimationBounds(bounds: FeeEstimationBounds = {}): {
  minFee: bigint;
  maxFee: bigint;
} {
  const minFee =
    bounds.minFee === undefined ? BigInt(DEFAULT_MIN_ESTIMATED_FEE) : BigInt(bounds.minFee);
  const maxFee =
    bounds.maxFee === undefined ? BigInt(DEFAULT_MAX_ESTIMATED_FEE) : BigInt(bounds.maxFee);
  if (minFee < 0n || maxFee < 0n) {
    throw new SoroWillError('Fee estimation bounds must be non-negative');
  }
  if (minFee > maxFee) {
    throw new SoroWillError('Fee estimation minFee must not exceed maxFee');
  }
  return { minFee, maxFee };
}

/** Clamps `fee` to the given inclusive bounds. */
export function clampFeeToBounds(fee: bigint, bounds: FeeEstimationBounds = {}): bigint {
  const { minFee, maxFee } = resolveFeeEstimationBounds(bounds);
  if (fee < minFee) return minFee;
  if (fee > maxFee) return maxFee;
  return fee;
}

/**
 * Derives the current network fee load from a `getFeeStats` response.
 * The load ratio compares the p90 Soroban inclusion fee to the p50, so a
 * congested network (where the top decile bids far above the median) is
 * detected without hard-coding absolute fee values.
 */
export function computeNetworkFeeLoad(
  stats: rpc.Api.GetFeeStatsResponse,
  congestionLoadRatio: number = DEFAULT_CONGESTION_LOAD_RATIO,
): NetworkFeeLoad {
  const p90 = BigInt(stats.sorobanInclusionFee.p90);
  const p50 = BigInt(stats.sorobanInclusionFee.p50);
  const loadRatio = p50 > 0n ? Number(p90) / Number(p50) : 1;
  return {
    sorobanInclusionFeeP90: p90.toString(),
    inclusionFeeP90: BigInt(stats.inclusionFee.p90).toString(),
    loadRatio,
    congested: loadRatio >= congestionLoadRatio,
  };
}

/**
 * Estimate a per-operation fee that adapts to current network load.
 *
 * The estimate starts from the network's p90 Soroban inclusion fee, is scaled
 * up by `congestionMultiplier` when the network is congested, is never lower
 * than the inner transaction's own per-operation inclusion fee, and is finally
 * clamped to the configurable `bounds`.
 *
 * @throws {SoroWillError} If the RPC server does not support `getFeeStats`.
 */
export async function estimateSmartFee(options: EstimateSmartFeeOptions): Promise<FeeEstimate> {
  const config = NETWORK_CONFIG[options.network];
  const pool = new RpcEndpointPool(config.rpcUrls, options.rpcServer);

  const innerTx = TransactionBuilder.fromXDR(
    options.innerTransactionXdr,
    config.networkPassphrase,
  ) as Transaction;

  const stats = await pool.withFailover((server) => {
    if (typeof server.getFeeStats !== 'function') {
      throw new SoroWillError('The configured RPC server does not support getFeeStats');
    }
    return server.getFeeStats();
  });

  const load = computeNetworkFeeLoad(stats, options.congestionLoadRatio);
  const multiplier = options.congestionMultiplier ?? DEFAULT_CONGESTION_MULTIPLIER;

  let fee = BigInt(load.sorobanInclusionFeeP90);
  if (load.congested && multiplier > 1) {
    fee = BigInt(Math.ceil(Number(fee) * multiplier));
  }
  const innerPerOp = getInnerInclusionFeePerOp(innerTx);
  if (fee < innerPerOp) fee = innerPerOp;

  return { fee: clampFeeToBounds(fee, options.bounds).toString(), estimatedAt: Date.now() };
}

/**
 * Error thrown when a fee-bump fee exceeds the configured reasonable maximum.
 */
export class ExorbitantFeeError extends Error {
  constructor(
    public readonly fee: string,
    public readonly maxFee: string,
    public readonly multiplier: number,
  ) {
    super(
      `Fee-bump fee ${fee} stroops exceeds the maximum allowed ${maxFee} stroops ` +
        `(${multiplier}x the base fee of ${BASE_FEE} stroops). ` +
        `Pass a higher maxFeeMultiplier or set it to 0 to disable this check.`,
    );
    this.name = 'ExorbitantFeeError';
  }
}

/** Options for building a fee-bump transaction. */
export interface FeeBumpOptions {
  /** The network to use. */
  network: SoroWillNetwork;
  /** The base64-encoded XDR of the inner (prepared, unsigned) transaction. */
  innerTransactionXdr: string;
  /** The fee source account's public key (the account sponsoring the fee). */
  feeSourcePublicKey: string;
  /**
   * The maximum fee the sponsor is willing to pay, in stroops. Defaults to
   * the inner transaction's fee when omitted.
   */
  fee?: string;
  /**
   * Maximum multiple of base fee allowed for the fee-bump. Defaults to 10.
   */
  maxFeeMultiplier?: number;
}

/** Options for submitting a signed fee-bump transaction. */
export interface SubmitFeeBumpOptions {
  /** The network to use. */
  network: SoroWillNetwork;
  /** The base64-encoded XDR of the signed fee-bump transaction. */
  feeBumpXdr: string;
  /** The maximum number of attempts to poll for transaction confirmation. Defaults to 30. */
  pollAttempts?: number;
  /** Optional RPC server to use instead of the network's configured endpoints (e.g. for tests). */
  rpcServer?: SoroWillRpcServer;
}

/**
 * Validate that a fee-bump fee is within a reasonable multiple of the base fee.
 *
 * @throws {ExorbitantFeeError} if `fee` exceeds `maxFeeMultiplier` times the base fee.
 */
export function assertReasonableFeeBumpFee(
  fee: string,
  maxFeeMultiplier: number = DEFAULT_MAX_FEE_MULTIPLIER,
): void {
  if (maxFeeMultiplier <= 0) return;

  const feeAmount = BigInt(fee);
  const maxFee = BigInt(BASE_FEE) * BigInt(maxFeeMultiplier);
  if (feeAmount > maxFee) {
    throw new ExorbitantFeeError(fee, maxFee.toString(), maxFeeMultiplier);
  }
}

/**
 * Tracks sequence numbers that were consumed by fee-bump transactions which
 * have already failed. A failed fee-bump may still have consumed its inner
 * transaction's sequence number on the network, so a retry that reuses the
 * same sequence number can be rejected as a duplicate. Callers can consult
 * this set before retrying to decide whether the inner transaction must be
 * rebuilt with a fresh sequence number.
 */
const failedFeeBumpSequenceNumbers = new Set<string>();

/**
 * Record the sequence number of an inner transaction whose fee-bump attempt
 * failed, so that a subsequent retry does not blindly reuse it.
 */
export function trackFailedFeeBumpSequence(sequence: string): void {
  failedFeeBumpSequenceNumbers.add(sequence);
}

/**
 * Returns true when the given sequence number was previously consumed by a
 * failed fee-bump transaction and therefore must not be reused on retry.
 */
export function isFeeBumpSequenceReused(sequence: string): boolean {
  return failedFeeBumpSequenceNumbers.has(sequence);
}

/** Clears the tracked failed fee-bump sequence numbers (primarily for tests). */
export function resetFailedFeeBumpSequences(): void {
  failedFeeBumpSequenceNumbers.clear();
}

/**
 * Estimate the total fee (in stroops) for a transaction that packs
 * `invocationCount` contract invocations.
 *
 * Stellar charges the base fee per operation, so a batch transaction that
 * packs multiple invocations must budget for every operation it contains.
 * Estimating for a single invocation under-counts the fee and causes the
 * transaction to fail with an insufficient-fee error.
 *
 * @param invocationCount - Number of invocations (operations) packed into the transaction.
 * @param baseFee - Base fee per operation in stroops. Defaults to 100 (the network minimum).
 * @returns The total estimated fee in stroops, as a string.
 */
export function estimateBatchFee(invocationCount: number, baseFee: number = 100): string {
  const count = Number.isFinite(invocationCount) && invocationCount > 0 ? Math.floor(invocationCount) : 1;
  const perOp = Number.isFinite(baseFee) && baseFee > 0 ? Math.floor(baseFee) : 100;
  return String(count * perOp);
}

/**
 * A breakdown of a transaction's total fee into its components, all in stroops
 * (1 XLM = 10,000,000 stroops).
 *
 * Stellar charges a transaction fee made up of three parts:
 *
 * - **Base fees** (`baseFee`): the network minimum fee per operation
 *   ({@link BASE_FEE}, 100 stroops) multiplied by the number of operations.
 *   This is the floor every transaction pays for inclusion.
 * - **Priority fees** (`priorityFee`): the per-operation bid above the base fee
 *   that a transaction offers to outbid others for inclusion in a ledger. It is
 *   `(inclusionFeePerOp - baseFeePerOp) * operationCount` and is zero when the
 *   transaction bids only the network minimum.
 * - **Resource fees** (`resourceFee`): the Soroban fee for CPU instructions,
 *   ledger reads/writes and events, taken from the transaction's Soroban
 *   transaction data. It is zero for non-Soroban transactions.
 *
 * `totalFee` is the sum of the three components and equals the transaction's
 * declared fee.
 */
export interface TransactionCostBreakdown {
  /** Total fee in stroops (`baseFee + priorityFee + resourceFee`). */
  totalFee: string;
  /** Base fees in stroops: {@link BASE_FEE} times the operation count. */
  baseFee: string;
  /** Priority fees in stroops: the per-operation bid above the base fee, times the operation count. */
  priorityFee: string;
  /** Soroban resource fee in stroops (0 for non-Soroban transactions). */
  resourceFee: string;
  /** The network minimum base fee per operation, in stroops. */
  baseFeePerOp: string;
  /** The inclusion fee per operation actually bid, in stroops. */
  inclusionFeePerOp: string;
  /** Number of operations in the transaction. */
  operationCount: number;
}

/** Options for {@link computeTransactionCostBreakdown}. */
export interface ComputeTransactionCostBreakdownOptions {
  /** The network the transaction is built for. */
  network: SoroWillNetwork;
  /** The base64-encoded XDR of the transaction (or fee-bump transaction). */
  transactionXdr: string;
  /** Base fee per operation in stroops. Defaults to {@link BASE_FEE}. */
  baseFeePerOp?: string;
}

/** Returns the inner transaction's per-operation inclusion fee (its fee minus any Soroban resource fee). */
function getInnerInclusionFeePerOp(innerTx: Transaction): bigint {
  let resourceFee = 0n;
  try {
    const ext = innerTx.toEnvelope().v1().tx().ext();
    if (ext.switch() === 1) resourceFee = BigInt(ext.sorobanData().resourceFee().toString());
  } catch {
    resourceFee = 0n;
  }
  const ops = BigInt(Math.max(innerTx.operations.length, 1));
  const perOp = (BigInt(innerTx.fee) - resourceFee + ops - 1n) / ops;
  return perOp > 0n ? perOp : 0n;
}

/**
 * Break a transaction's total fee down into base fees, priority fees and
 * Soroban resource fees (see {@link TransactionCostBreakdown}).
 *
 * The transaction's declared fee is split as follows: the Soroban resource fee
 * is read from the transaction's Soroban data, the remainder is the inclusion
 * fee, of which `baseFeePerOp * operationCount` is base fees and anything above
 * that is the priority fee. For fee-bump transactions the inner transaction's
 * fee is broken down.
 *
 * @throws {SoroWillError} If the XDR cannot be parsed as a transaction.
 */
export function computeTransactionCostBreakdown(
  options: ComputeTransactionCostBreakdownOptions,
): TransactionCostBreakdown {
  const config = NETWORK_CONFIG[options.network];
  let parsed: Transaction | FeeBumpTransaction;
  try {
    parsed = TransactionBuilder.fromXDR(options.transactionXdr, config.networkPassphrase) as
      | Transaction
      | FeeBumpTransaction;
  } catch (error) {
    throw new SoroWillError('Unable to parse transaction XDR for cost breakdown', {
      cause: error,
    });
  }

  const innerTx = 'innerTransaction' in parsed ? parsed.innerTransaction : parsed;
  const operationCount = Math.max(innerTx.operations.length, 1);
  const ops = BigInt(operationCount);

  let resourceFee = 0n;
  try {
    const ext = innerTx.toEnvelope().v1().tx().ext();
    if (ext.switch() === 1) resourceFee = BigInt(ext.sorobanData().resourceFee().toString());
  } catch {
    resourceFee = 0n;
  }

  const totalFee = BigInt(innerTx.fee);
  const inclusionFee = totalFee > resourceFee ? totalFee - resourceFee : 0n;
  const inclusionFeePerOp = (inclusionFee + ops - 1n) / ops;

  const baseFeePerOp = BigInt(options.baseFeePerOp ?? BASE_FEE);
  const baseFee = baseFeePerOp * ops;
  const priorityFee = inclusionFee > baseFee ? inclusionFee - baseFee : 0n;

  return {
    totalFee: totalFee.toString(),
    baseFee: baseFee.toString(),
    priorityFee: priorityFee.toString(),
    resourceFee: resourceFee.toString(),
    baseFeePerOp: baseFeePerOp.toString(),
    inclusionFeePerOp: inclusionFeePerOp.toString(),
    operationCount,
  };
}

/**
 * Estimate the fee for fee-bumping `innerTransactionXdr` using the network's
 * current inclusion-fee baseline (the p90 Soroban inclusion fee from
 * `getFeeStats`).
 *
 * The estimate is a per-operation base fee: the larger of the network p90,
 * the network minimum base fee, and the inner transaction's own
 * per-operation inclusion fee (the fee-bump must not bid less than it).
 *
 * Inclusion fees move from ledger to ledger, so an estimate is only valid for
 * a short time. Pass the returned {@link FeeEstimate} to {@link submitFeeBump}
 * to have it re-estimated automatically if it is older than the configured
 * staleness threshold at submission time.
 *
 * @throws {SoroWillError} If the RPC server does not support `getFeeStats`.
 */
export async function estimateFeeBumpFee(options: EstimateFeeBumpFeeOptions): Promise<FeeEstimate> {
  const config = NETWORK_CONFIG[options.network];
  const pool = new RpcEndpointPool(config.rpcUrls, options.rpcServer);

  const innerTx = TransactionBuilder.fromXDR(
    options.innerTransactionXdr,
    config.networkPassphrase,
  ) as Transaction;

  const stats = await pool.withFailover((server) => {
    if (typeof server.getFeeStats !== 'function') {
      throw new SoroWillError('The configured RPC server does not support getFeeStats');
    }
    return server.getFeeStats();
  });

  let fee = BigInt(stats.sorobanInclusionFee.p90);
  const baseFee = BigInt(BASE_FEE);
  if (fee < baseFee) fee = baseFee;
  const innerPerOp = getInnerInclusionFeePerOp(innerTx);
  if (fee < innerPerOp) fee = innerPerOp;

  return { fee: fee.toString(), estimatedAt: Date.now() };
}

/**
 * Returns true when `estimate` is older than `thresholdMs` and should be
 * re-estimated before submission.
 */
export function isFeeEstimateStale(
  estimate: FeeEstimate,
  thresholdMs: number = DEFAULT_FEE_STALENESS_THRESHOLD_MS,
  now: number = Date.now(),
): boolean {
  return now - estimate.estimatedAt > thresholdMs;
}

/**
 * Re-estimate `estimate` if it is stale. The returned estimate's fee is never
 * lower than the original — a fee that has dropped since estimation is still
 * accepted by the network, while one that has risen would cause the
 * submission to be rejected.
 */
export async function refreshFeeEstimateIfStale(
  estimate: FeeEstimate,
  options: EstimateFeeBumpFeeOptions & { feeStalenessThresholdMs?: number },
): Promise<FeeEstimate> {
  if (!isFeeEstimateStale(estimate, options.feeStalenessThresholdMs)) {
    return estimate;
  }

  const fresh = await estimateFeeBumpFee({
    network: options.network,
    innerTransactionXdr: options.innerTransactionXdr,
    ...(options.rpcServer && { rpcServer: options.rpcServer }),
  });
  if (BigInt(fresh.fee) < BigInt(estimate.fee)) {
    return { ...fresh, fee: estimate.fee };
  }
  return fresh;
}

/**
 * Build a fee-bump transaction that wraps an inner transaction,
 * allowing a different account (the fee sponsor) to pay the network fee.
 *
 * The inner transaction must already be prepared via
 * `server.prepareTransaction()`. The fee sponsor only needs to have
 * their account loaded — no Freighter connection is required on the
 * user's side.
 *
 * Before building the envelope this function validates that the inner
 * transaction's sequence number has not yet been consumed on-chain.  If the
 * inner transaction was prepared, cached, and is now being retried after a
 * delay, the sequence may already be spent — in that case
 * {@link StaleTransactionSequenceError} is thrown so the caller can rebuild
 * with a fresh sequence rather than submitting a fee-bump that will fail with
 * `txBAD_SEQ`.
 *
 * @returns The base64-encoded XDR of the fee-bump transaction envelope.
 * @throws {InvalidPublicKeyError} if `feeSourcePublicKey` is not a valid Stellar public key.
 * @throws {ExorbitantFeeError} if `fee` exceeds `maxFeeMultiplier` times the base fee.
 */
export async function buildFeeBumpXdr(options: FeeBumpOptions): Promise<string> {
  const config = NETWORK_CONFIG[options.network];

  if (options.fee) {
    assertReasonableFeeBumpFee(options.fee, options.maxFeeMultiplier ?? DEFAULT_MAX_FEE_MULTIPLIER);
  }

  const { feeSourcePublicKey } = options;
  if (typeof feeSourcePublicKey !== 'string' || !feeSourcePublicKey.startsWith('G')) {
    throw new InvalidPublicKeyError('feeSourcePublicKey');
  }
  let feeSource: Keypair;
  try {
    feeSource = Keypair.fromPublicKey(feeSourcePublicKey);
  } catch (error) {
    throw new InvalidPublicKeyError('feeSourcePublicKey', { cause: error });
  }

  const innerTx = TransactionBuilder.fromXDR(
    options.innerTransactionXdr,
    config.networkPassphrase,
  ) as Transaction;

  const feeBumpTx = TransactionBuilder.buildFeeBumpTransaction(
    feeSource,
    options.fee || innerTx.fee,
    innerTx,
    config.networkPassphrase,
  );

  return feeBumpTx.toXDR();
}

/**
 * Sign a fee-bump transaction with a secret key (the fee sponsor's key).
 * Returns the signed fee-bump transaction XDR.
 * @throws {InvalidSecretKeyError} if the secret key is malformed.
 */
export function signFeeBumpXdr(
  feeBumpXdr: string,
  secretKey: string,
  networkPassphrase: string,
): string {
  let keypair: Keypair;
  try {
    keypair = Keypair.fromSecret(secretKey);
  } catch {
    throw new InvalidSecretKeyError('signFeeBumpXdr');
  }

  const feeBump = TransactionBuilder.fromXDR(feeBumpXdr, networkPassphrase);

  const hashed = feeBump.hash();
  const sig = keypair.signDecorated(hashed);
  feeBump.addDecoratedSignature(sig);

  return feeBump.toXDR();
}

/** Renders an XDR value (or array of values) from an RPC response as base64 for error messages. */
function xdrToString(value: unknown): string {
  if (Array.isArray(value)) return value.map(xdrToString).join(', ');
  if (value && typeof (value as { toXDR?: unknown }).toXDR === 'function') {
    return (value as { toXDR: (format: 'base64') => string }).toXDR('base64');
  }
  return String(value);
}

/**
 * Query the network for the current status of a transaction by hash.
 *
 * Returns the RPC transaction status (`SUCCESS`, `FAILED`, or `NOT_FOUND`).
 * Used to avoid submitting a fee-bump for a transaction that has already
 * been included in a ledger.
 */
export async function getTransactionStatus(options: {
  network: SoroWillNetwork;
  hash: string;
}): Promise<rpc.Api.GetTransactionStatus> {
  const config = NETWORK_CONFIG[options.network];
  const rpcUrl = config.rpcUrls[0]!;
  const server = new rpc.Server(rpcUrl, {
    allowHttp: rpcUrl.startsWith('http://'),
  });

  const response = await server.getTransaction(options.hash);
  return response.status;
}

/**
 * Submit a signed fee-bump transaction to the network and wait for confirmation.
 */
export async function submitFeeBumpTransaction(
  options: SubmitFeeBumpOptions,
): Promise<{ txHash: string; createdAt: number }> {
  const config = NETWORK_CONFIG[options.network];
  const pool = new RpcEndpointPool(config.rpcUrls, options.rpcServer);

  const feeBumpTx = TransactionBuilder.fromXDR(
    options.feeBumpXdr,
    config.networkPassphrase,
  ) as Transaction;

  const innerSequence = feeBumpTx.sequence;
  const sendResponse = await pool.withFailover((server) => server.sendTransaction(feeBumpTx));
  if (sendResponse.status === 'ERROR') {
    trackFailedFeeBumpSequence(innerSequence);
    const errorResponse = sendResponse as SendTransactionErrorResponse;
    const diagnosticInfo = errorResponse.diagnosticEventsXdr ?
      ` (diagnostics: ${errorResponse.diagnosticEventsXdr})` : '';
    const errorDetail = errorResponse.errorResultXdr ?
      ` (error: ${errorResponse.errorResultXdr})` : '';
    throw new Error(
      `Fee-bump transaction submission failed${diagnosticInfo}${errorDetail}`,
      { cause: sendResponse }
    );
  }

  if (sendResponse.status === 'TRY_AGAIN_LATER') {
    throw new SoroWillError(
      'Fee-bump transaction was not accepted: the RPC node returned TRY_AGAIN_LATER. Retry later.',
      { cause: sendResponse },
    );
  }

  // PENDING, and DUPLICATE (already submitted), both poll the returned hash.
  const pollAttempts = options.pollAttempts ?? 30;
  const txResponse = await pool.withFailover((server) =>
    server.pollTransaction(sendResponse.hash, { attempts: pollAttempts }),
  );
  if (txResponse.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    trackFailedFeeBumpSequence(innerSequence);
    const failed = txResponse as { resultXdr?: unknown; diagnosticEventsXdr?: unknown };
    const resultDetail = failed.resultXdr ? ` (result: ${xdrToString(failed.resultXdr)})` : '';
    const diagnosticDetail = failed.diagnosticEventsXdr ?
      ` (diagnostics: ${xdrToString(failed.diagnosticEventsXdr)})` : '';
    throw new Error(
      `Fee-bump transaction did not succeed: ${txResponse.status}${resultDetail}${diagnosticDetail}`,
      { cause: txResponse },
    );
  }

  return {
    txHash: sendResponse.hash,
    createdAt: txResponse.createdAt,
  };
}

/**
 * High-level helper: build, sign, and submit a fee-bump transaction in one call.
 *
 * @param options.innerTransactionXdr - Prepared inner transaction XDR (unsigned, after `server.prepareTransaction()`).
 * @param options.feeSourceSecretKey - Secret key of the fee sponsor account.
 * @param options.network - Stellar network to use.
 * @param options.pollAttempts - Maximum number of attempts to poll for transaction confirmation. Defaults to 30.
 * @param options.maxFeeMultiplier - Maximum multiple of the base fee allowed. Defaults to 10x. Set to 0 to disable.
 * @param options.feeEstimate - A fee estimate from {@link estimateFeeBumpFee}. When it is older than
 *   `feeStalenessThresholdMs` it is re-estimated against the current network inclusion-fee baseline
 *   before submission. Takes precedence over `fee`.
 * @param options.feeStalenessThresholdMs - Age in milliseconds after which `feeEstimate` is re-estimated.
 *   Defaults to {@link DEFAULT_FEE_STALENESS_THRESHOLD_MS}.
 * @param options.rpcServer - Optional RPC server to use instead of the network's configured endpoints.
 */
export async function submitFeeBump(options: {
  innerTransactionXdr: string;
  feeSourceSecretKey: string;
  network: SoroWillNetwork;
  fee?: string;
  feeEstimate?: FeeEstimate;
  feeStalenessThresholdMs?: number;
  pollAttempts?: number;
  maxFeeMultiplier?: number;
  rpcServer?: SoroWillRpcServer;
}): Promise<{ txHash: string; createdAt: number }> {
  const config = NETWORK_CONFIG[options.network];
  let keypair: Keypair;
  try {
    keypair = Keypair.fromSecret(options.feeSourceSecretKey);
  } catch {
    throw new InvalidSecretKeyError('submitFeeBump');
  }
  const publicKey = keypair.publicKey();

  const innerTx = TransactionBuilder.fromXDR(
    options.innerTransactionXdr,
    config.networkPassphrase,
  ) as Transaction;

  if (isFeeBumpSequenceReused(innerTx.sequence)) {
    throw new Error(
      `Fee-bump retry would reuse sequence number ${innerTx.sequence}, which was already consumed by a failed transaction. Rebuild the inner transaction with a fresh sequence number before retrying.`,
    );
  }

  let fee = options.fee;
  if (options.feeEstimate) {
    const estimate = await refreshFeeEstimateIfStale(options.feeEstimate, {
      network: options.network,
      innerTransactionXdr: options.innerTransactionXdr,
      ...(options.feeStalenessThresholdMs !== undefined && {
        feeStalenessThresholdMs: options.feeStalenessThresholdMs,
      }),
      ...(options.rpcServer && { rpcServer: options.rpcServer }),
    });
    fee = estimate.fee;
  }
  if (!fee) {
    fee = innerTx.fee;
  }

  const feeBumpXdr = await buildFeeBumpXdr({
    network: options.network,
    innerTransactionXdr: options.innerTransactionXdr,
    feeSourcePublicKey: publicKey,
    fee,
    ...(options.maxFeeMultiplier !== undefined && { maxFeeMultiplier: options.maxFeeMultiplier }),
  });

  const signedXdr = signFeeBumpXdr(feeBumpXdr, options.feeSourceSecretKey, config.networkPassphrase);

  const submitOptions: SubmitFeeBumpOptions = {
    network: options.network,
    feeBumpXdr: signedXdr,
  };
  if (options.pollAttempts !== undefined) {
    submitOptions.pollAttempts = options.pollAttempts;
  }
  if (options.rpcServer) {
    submitOptions.rpcServer = options.rpcServer;
  }

  return submitFeeBumpTransaction(submitOptions);
}

/** Options for the auto fee-bump-on-timeout helper. */
export interface AutoFeeBumpOnTimeoutOptions {
  /** The network to use. */
  network: SoroWillNetwork;
  /** The base64-encoded XDR of the prepared inner transaction. */
  innerTransactionXdr: string;
  /** Secret key of the fee sponsor account. */
  feeSourceSecretKey: string;
  /** Milliseconds to wait for a response before attempting a fee bump. */
  timeoutMs: number;
  /** Optional explicit fee for the bump. Defaults to the inner transaction's fee. */
  fee?: string;
  /**
   * Optional fee estimate for the bump. Because the bump is only submitted
   * after `timeoutMs` elapses, a stale estimate is re-estimated first.
   */
  feeEstimate?: FeeEstimate;
  /** Age in milliseconds after which `feeEstimate` is re-estimated. */
  feeStalenessThresholdMs?: number;
  /** Maximum number of attempts to poll for confirmation. Defaults to 30. */
  pollAttempts?: number;
}

/**
 * Submit a transaction and, if no response is received within `timeoutMs`,
 * automatically submit a fee-bump version to speed up inclusion.
 *
 * Before submitting the bump, the original transaction's status is queried
 * on-chain. The bump is only submitted when the original is still pending
 * (i.e. not yet `SUCCESS` or `FAILED`), preventing a duplicate operation
 * when the original merely reported slowly.
 */
export async function autoFeeBumpOnTimeout(
  options: AutoFeeBumpOnTimeoutOptions,
): Promise<{ txHash: string; createdAt: number; bumped: boolean }> {
  const config = NETWORK_CONFIG[options.network];
  const rpcUrl = config.rpcUrls[0]!;
  const server = new rpc.Server(rpcUrl, {
    allowHttp: rpcUrl.startsWith('http://'),
  });

  const innerTx = TransactionBuilder.fromXDR(
    options.innerTransactionXdr,
    config.networkPassphrase,
  ) as Transaction;

  const sendResponse = await server.sendTransaction(innerTx);
  if (sendResponse.status === 'ERROR') {
    const errorResponse = sendResponse as SendTransactionErrorResponse;
    const diagnosticInfo = errorResponse.diagnosticEventsXdr ?
      ` (diagnostics: ${errorResponse.diagnosticEventsXdr})` : '';
    const errorDetail = errorResponse.errorResultXdr ?
      ` (error: ${errorResponse.errorResultXdr})` : '';
    throw new Error(
      `Transaction submission failed${diagnosticInfo}${errorDetail}`,
      { cause: sendResponse }
    );
  }

  const originalHash = sendResponse.hash;

  const timeoutResult = await new Promise<'confirmed' | 'timeout'>((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), options.timeoutMs);
    server
      .pollTransaction(originalHash, { attempts: 1 })
      .then((txResponse) => {
        if (txResponse.status === rpc.Api.GetTransactionStatus.SUCCESS) {
          clearTimeout(timer);
          resolve('confirmed');
        }
      })
      .catch(() => {
        /* keep waiting until the timeout fires */
      });
  });

  if (timeoutResult === 'confirmed') {
    await server.getTransaction(originalHash);
    return {
      txHash: originalHash,
      createdAt: Date.now(),
      bumped: false,
    };
  }

  // Timeout elapsed: re-check the original transaction status before bumping.
  const statusResponse = await server.getTransaction(originalHash);
  if (statusResponse.status === rpc.Api.GetTransactionStatus.SUCCESS) {
    return {
      txHash: originalHash,
      createdAt: statusResponse.createdAt,
      bumped: false,
    };
  }
  if (statusResponse.status === rpc.Api.GetTransactionStatus.FAILED) {
    throw new Error(
      `Transaction failed before fee bump: ${originalHash}`,
      { cause: statusResponse },
    );
  }

  // Original is still pending (NOT_FOUND): safe to submit the fee bump.
  const bumpOptions: {
    innerTransactionXdr: string;
    feeSourceSecretKey: string;
    network: SoroWillNetwork;
    fee?: string;
    feeEstimate?: FeeEstimate;
    feeStalenessThresholdMs?: number;
    pollAttempts?: number;
  } = {
    innerTransactionXdr: options.innerTransactionXdr,
    feeSourceSecretKey: options.feeSourceSecretKey,
    network: options.network,
  };
  if (options.fee !== undefined) bumpOptions.fee = options.fee;
  if (options.feeEstimate !== undefined) bumpOptions.feeEstimate = options.feeEstimate;
  if (options.feeStalenessThresholdMs !== undefined) {
    bumpOptions.feeStalenessThresholdMs = options.feeStalenessThresholdMs;
  }
  if (options.pollAttempts !== undefined) bumpOptions.pollAttempts = options.pollAttempts;

  const bumped = await submitFeeBump(bumpOptions);
  return { txHash: bumped.txHash, createdAt: bumped.createdAt, bumped: true };
}

export class StaleTransactionSequenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaleTransactionSequenceError';
  }
}

export function validateInnerTransactionSequence(
  innerTransactionXdr: string,
  expectedSequence: string | bigint,
): void {
  try {
    const envelope = xdr.TransactionEnvelope.fromXDR(innerTransactionXdr, 'base64');
    let tx: xdr.Transaction;

    if (envelope.switch() === xdr.EnvelopeType.envelopeTypeTx()) {
      tx = envelope.v1()!.tx();
    } else if (envelope.switch() === xdr.EnvelopeType.envelopeTypeTxFeeBump()) {
      tx = envelope.feeBump()!.tx().innerTx().v1()!.tx();
    } else {
      throw new Error('Unsupported transaction envelope type');
    }

    const actualSequence = tx.seqNum().toString();
    const expected = typeof expectedSequence === 'bigint' ? expectedSequence.toString() : expectedSequence;

    if (actualSequence !== expected) {
      throw new StaleTransactionSequenceError(
        `Transaction sequence mismatch: expected ${expected}, got ${actualSequence}`,
      );
    }
  } catch (error) {
    if (error instanceof StaleTransactionSequenceError) {
      throw error;
    }
    throw new Error(`Failed to validate transaction sequence: ${error instanceof Error ? error.message : String(error)}`);
  }
}
