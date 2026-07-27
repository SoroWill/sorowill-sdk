import {
  Account,
  BASE_FEE,
  Contract,
  Networks,
  Transaction,
  TransactionBuilder,
  rpc,
  xdr,
  contract as stellarContract,
} from '@stellar/stellar-sdk';

import { ReadCache, type ReadCacheOptions } from './cache';
import {
  unsubscribeFromWillEvents,
  type WillEventSource,
  type WillEventSubscription,
} from './events';
import type {
  BatchOperation,
  BatchResult,
  Beneficiary,
  CreateWillParams,
  PaginatedWillsResult,
  PaginationOptions,
  RequestOptions,
  SoroWillEvent,
  UpdateBeneficiariesParams,
  Will,
} from './types';
import { WillStatus } from './types';
import { getDefaultWalletAdapter, type WalletAdapter, getPublicKey, signTransaction } from './wallet';
import { mapContractError, SoroWillError } from './errors';
import { RequestQueue } from './requestQueue';
import { RpcEndpointPool } from './rpc';
import { buildSep7TxUri, type BuildSep7TxUriOptions } from './sep7';
import { HookManager } from './hooks';
import type { BeforeInvokeContext, AfterInvokeContext } from './hooks';
import { assertPreparedTransactionMatchesIntendedOperation } from './txValidation';

type ScVal = xdr.ScVal;

const { Spec } = stellarContract;

/** An impossible account used to simulate read-only calls without a connected wallet. */
const NULL_ACCOUNT = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

/** Supported Stellar networks. */
export type SoroWillNetwork = 'testnet' | 'mainnet';

interface NetworkConfig {
  rpcUrls: string[];
  networkPassphrase: string;
}

const NETWORK_CONFIG: Record<SoroWillNetwork, NetworkConfig> = {
  testnet: {
    rpcUrls: ['https://soroban-testnet.stellar.org'],
    networkPassphrase: Networks.TESTNET,
  },
  mainnet: {
    rpcUrls: ['https://mainnet.sorobanrpc.com'],
    networkPassphrase: Networks.PUBLIC,
  },
};

export interface RpcRetryOptions {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffFactor: number;
}

export interface SoroWillRpcServer {
  getContractWasmByContractId(contractId: string): Promise<Buffer | Uint8Array>;
  simulateTransaction(transaction: Transaction): Promise<rpc.Api.SimulateTransactionResponse>;
  getAccount(address: string): Promise<Account>;
  prepareTransaction(transaction: Transaction): Promise<Transaction>;
  sendTransaction(transaction: Transaction): Promise<rpc.Api.SendTransactionResponse>;
  pollTransaction(
    hash: string,
    options: { attempts: number },
  ): Promise<rpc.Api.GetTransactionResponse>;
}

interface ContractSpecLike {
  funcArgsToScVals(method: string, args: Record<string, unknown>): ScVal[];
  funcResToNative(method: string, value: ScVal): unknown;
}

type EnvSource = Record<string, string | undefined>;
type FetchImplementation = typeof fetch;

interface WebSocketLike {
  close(): void;
  send(data: string): void;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
  onerror: ((event: Event | unknown) => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onopen: ((event: Event | unknown) => void) | null;
}

interface RpcEventRecord {
  contractId?: string;
  id?: string;
  ledger?: number;
  ledgerClosedAt?: string;
  pagingToken?: string;
  topic?: unknown[];
  topics?: unknown[];
  txHash?: string;
  type?: string;
  value?: unknown;
}

/** Options for constructing a read cache scoped to SoroWill reads. */
export interface SoroWillReadCacheOptions {
  ttlMs?: number;
}

/** Event subscription types. */
export type EventSubscriptionTransport = 'polling' | 'websocket';

/** Controls how event subscriptions are established and paged. */
export interface EventSubscriptionOptions {
  cursor?: string;
  pageSize?: number;
  pollIntervalMs?: number;
  transport?: 'auto' | EventSubscriptionTransport;
  onError?: (error: Error) => void;
}

/** Handle for an active event subscription. */
export interface EventSubscription {
  readonly transport: EventSubscriptionTransport;
  readonly closed: boolean;
  close(): void;
}

/** Options for constructing a {@link SoroWillClient}. */
export interface SoroWillClientOptions {
  /** Which Stellar network to connect to. */
  network: SoroWillNetwork;
  /** The deployed SoroWill contract's address. */
  contractId: string;
  /** Optional hook manager for intercepting contract calls. */
  hooks?: HookManager;
  /**
   * The wallet used to read the connected account and sign transactions.
   * Defaults to the Freighter browser extension for backwards compatibility.
   * Supply any {@link WalletAdapter} to use a different Stellar wallet.
   */
  wallet?: WalletAdapter;
  /** Read-cache configuration. Pass `false` to disable caching entirely. */
  readCache?: ReadCacheOptions | false;
  /** Event source used to invalidate cached will reads as external updates arrive. */
  eventSource?: WillEventSource;
  /** Retry settings for transient RPC failures. */
  retry?: Partial<RpcRetryOptions>;
  /** Advanced override for testing or custom transports. */
  rpcServer?: SoroWillRpcServer;
  /** Advanced override for testing or preloaded contract specs. */
  spec?: ContractSpecLike | Promise<ContractSpecLike>;
  /** Optional override for the Soroban RPC endpoint. */
  rpcUrl?: string;
  /** Optional override for the Stellar network passphrase. */
  networkPassphrase?: string;
  /** Optional override for the endpoint used for event polling. */
  eventRpcUrl?: string;
  /** Optional override for the WebSocket event streaming endpoint. */
  eventStreamUrl?: string;
  /** Default polling interval for event subscriptions. */
  defaultPollIntervalMs?: number;
  /** Internal/testing override for the fetch implementation. */
  fetch?: FetchImplementation;
  /** Internal/testing override for WebSocket construction. */
  webSocketFactory?: (url: string) => WebSocketLike;
  /** Default timeout applied to each RPC request. Defaults to 30 seconds. */
  timeoutMs?: number;
  /** Maximum number of RPC requests in flight at once. Defaults to 4. */
  maxConcurrentRequests?: number;
  /** Maximum RPC requests started in a rolling one-second window. Defaults to 10. */
  requestsPerSecond?: number;
  /** Optional list of RPC endpoints to use with automatic failover. */
  rpcUrls?: string[];
}

/** The raw, snake_case shape of a `Will` as decoded straight off the contract spec. */
interface RawWill {
  id: bigint;
  owner: string;
  token: string;
  balance: bigint;
  beneficiaries: Beneficiary[];
  checkin_period_days: bigint;
  grace_period_days: bigint;
  last_checkin: bigint;
  trigger_time: bigint | undefined;
  status: WillStatus;
  guardians: string[];
  guardian_votes: number;
}

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

function mapWill(raw: RawWill): Will {
  return {
    id: raw.id.toString(),
    owner: raw.owner,
    token: raw.token,
    balance: raw.balance.toString(),
    beneficiaries: raw.beneficiaries,
    checkinPeriodDays: Number(raw.checkin_period_days),
    gracePeriodDays: Number(raw.grace_period_days),
    lastCheckin: new Date(Number(raw.last_checkin) * 1000),
    triggerTime: raw.trigger_time === undefined ? null : new Date(Number(raw.trigger_time) * 1000),
    status: raw.status,
    guardians: raw.guardians,
    guardianVotes: raw.guardian_votes,
  };
}

function mapEventRecord(record: RpcEventRecord, fallbackContractId: string): SoroWillEvent {
  const cursor = record.pagingToken ?? record.id ?? '';
  return {
    id: record.id ?? cursor,
    cursor,
    ledger: record.ledger ?? null,
    ledgerClosedAt: record.ledgerClosedAt ? new Date(record.ledgerClosedAt) : null,
    contractId: record.contractId ?? fallbackContractId,
    txHash: record.txHash ?? null,
    type: record.type ?? null,
    topics: record.topics ?? record.topic ?? [],
    value: record.value,
    raw: record,
  };
}

function isPaginationRequested(
  options: PaginationOptions | undefined,
): options is PaginationOptions {
  return options !== undefined && (options.pageSize !== undefined || options.cursor !== undefined);
}

function paginateWills(
  wills: Will[],
  options: PaginationOptions | undefined,
): Will[] | PaginatedWillsResult {
  if (!isPaginationRequested(options)) {
    return wills;
  }
  const start = parseCursor(options.cursor);
  const pageSize = normalizePositiveInteger(options.pageSize, 'pageSize');
  const end = pageSize === null ? wills.length : Math.min(start + pageSize, wills.length);
  return {
    wills: wills.slice(start, end),
    nextCursor: end < wills.length ? String(end) : null,
  };
}

function parseCursor(cursor: string | undefined): number {
  if (cursor === undefined) {
    return 0;
  }
  if (!/^\d+$/.test(cursor)) {
    throw new Error(`Invalid pagination cursor: "${cursor}"`);
  }
  return Number(cursor);
}

function normalizePositiveInteger(value: number | undefined, label: string): number | null {
  if (value === undefined) {
    return null;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function getDefaultEnv(): EnvSource {
  if (typeof process !== 'undefined' && process.env) {
    return process.env as EnvSource;
  }
  return {};
}

// ---------------------------------------------------------------------------
// SoroWillClient
// ---------------------------------------------------------------------------

/**
 * A client for interacting with a deployed SoroWill contract from
 * TypeScript. Read methods (`getWill`, `getWillsByOwner`,
 * `getWillsByBeneficiary`) work without a connected wallet. All other
 * methods sign and submit a transaction via the configured wallet adapter.
 */
export class SoroWillClient {
  private readonly rpcPool: RpcEndpointPool;
  private readonly contract: Contract;
  private readonly networkPassphrase: string;
  private readonly hooks: HookManager;
  private readonly timeoutMs: number;
  private readonly queue: RequestQueue;
  private readonly readCache: ReadCache | undefined;
  private readonly specOverride: ContractSpecLike | Promise<ContractSpecLike> | undefined;
  private readonly eventRpcUrl: string;
  private readonly eventStreamUrl: string;
  private readonly defaultPollIntervalMs: number;
  private readonly fetchImplementation: FetchImplementation | undefined;
  private readonly webSocketFactory: ((url: string) => WebSocketLike) | undefined;
  private readonly eventSubscription?: WillEventSubscription;
  private specPromise: Promise<InstanceType<typeof Spec>> | undefined;

  constructor(options: SoroWillClientOptions) {
    const config = NETWORK_CONFIG[options.network];

    const rpcUrl = options.rpcUrl ?? config.rpcUrls[0]!;
    this.rpcPool = new RpcEndpointPool(options.rpcUrls ?? config.rpcUrls);
    this.contract = new Contract(options.contractId);
    this.networkPassphrase = options.networkPassphrase ?? config.networkPassphrase;
    this.hooks = options.hooks ?? new HookManager();
    // Store wallet adapter for use in sign/getPublicKey. Module-level helpers
    // use the default adapter but this instance reference allows future override.
    const _wallet = options.wallet ?? getDefaultWalletAdapter();
    void _wallet;
    this.specOverride = options.spec;

    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new RangeError('timeoutMs must be greater than zero');
    }

    this.queue = new RequestQueue({
      ...(options.maxConcurrentRequests === undefined
        ? {}
        : { maxConcurrent: options.maxConcurrentRequests }),
      ...(options.requestsPerSecond === undefined
        ? {}
        : { requestsPerSecond: options.requestsPerSecond }),
    });

    const cacheOpts = options.readCache;
    this.readCache =
      cacheOpts === false
        ? undefined
        : new ReadCache({ ttlMs: cacheOpts?.ttlMs ?? 60_000 });

    this.eventRpcUrl = options.eventRpcUrl ?? rpcUrl;
    this.eventStreamUrl =
      options.eventStreamUrl ?? this.deriveDefaultEventStreamUrl(this.eventRpcUrl);
    this.defaultPollIntervalMs =
      normalizePositiveInteger(options.defaultPollIntervalMs, 'defaultPollIntervalMs') ?? 5_000;
    this.fetchImplementation = options.fetch;
    this.webSocketFactory = options.webSocketFactory;

    if (this.readCache && options.eventSource) {
      this.eventSubscription = options.eventSource.subscribe((event) => {
        void this.readCache?.invalidateByWillId(event.willId);
      });
    }
  }

  // -----------------------------------------------------------------------
  // Static factory
  // -----------------------------------------------------------------------

  /**
   * Constructs a client from environment variables.
   *
   * Expected variables:
   * - `SOROWILL_NETWORK`
   * - `SOROWILL_CONTRACT_ID`
   * - `SOROWILL_RPC_URL` (optional)
   * - `SOROWILL_NETWORK_PASSPHRASE` (optional)
   * - `SOROWILL_EVENT_RPC_URL` (optional)
   * - `SOROWILL_EVENT_STREAM_URL` (optional)
   * - `SOROWILL_EVENTS_POLL_INTERVAL_MS` (optional)
   *
   * @throws {Error} If `SOROWILL_NETWORK` is not `"testnet"` or `"mainnet"`.
   * @throws {Error} If `SOROWILL_CONTRACT_ID` is not set.
   */
  static fromEnv(env: EnvSource = getDefaultEnv()): SoroWillClient {
    const network = env.SOROWILL_NETWORK;
    if (network !== 'testnet' && network !== 'mainnet') {
      throw new Error('SOROWILL_NETWORK must be set to "testnet" or "mainnet"');
    }

    const contractId = env.SOROWILL_CONTRACT_ID;
    if (!contractId) {
      throw new Error('SOROWILL_CONTRACT_ID must be set');
    }

    const pollInterval = env.SOROWILL_EVENTS_POLL_INTERVAL_MS
      ? Number(env.SOROWILL_EVENTS_POLL_INTERVAL_MS)
      : undefined;

    const opts: SoroWillClientOptions = { network, contractId };
    if (env.SOROWILL_RPC_URL !== undefined) opts.rpcUrl = env.SOROWILL_RPC_URL;
    if (env.SOROWILL_NETWORK_PASSPHRASE !== undefined) opts.networkPassphrase = env.SOROWILL_NETWORK_PASSPHRASE;
    if (env.SOROWILL_EVENT_RPC_URL !== undefined) opts.eventRpcUrl = env.SOROWILL_EVENT_RPC_URL;
    if (env.SOROWILL_EVENT_STREAM_URL !== undefined) opts.eventStreamUrl = env.SOROWILL_EVENT_STREAM_URL;
    if (pollInterval !== undefined) opts.defaultPollIntervalMs = pollInterval;

    return new SoroWillClient(opts);
  }

  // -----------------------------------------------------------------------
  // Public: state-changing methods
  // -----------------------------------------------------------------------

  /**
   * Locks `params.amount` of `params.token` and creates a new will.
   *
   * @returns The newly created will's ID and the transaction hash.
   * @throws {SoroWillError} If the transaction simulation fails or returns no result.
   * @throws {RequestTimeoutError} If the RPC request exceeds its configured timeout.
   * @throws {WillContractError} Mapped contract-level errors (e.g. InvalidPercentagesError,
   *   TooManyBeneficiariesError, ZeroAmountError).
   * @throws {Error} If the wallet is not connected or fails to sign.
   */
  async createWill(
    params: CreateWillParams,
    options?: RequestOptions,
  ): Promise<{ willId: string; txHash: string }> {
    const owner = await getPublicKey();
    const { txHash, returnValue } = await this.invoke(
      'create_will',
      {
        owner,
        token: params.token,
        amount: BigInt(params.amount),
        beneficiaries: params.beneficiaries,
        checkin_period_days: BigInt(params.checkinPeriodDays),
        grace_period_days: BigInt(params.gracePeriodDays),
        guardians: params.guardians,
      },
      options,
    );
    if (!returnValue) {
      throw new SoroWillError('create_will transaction succeeded but returned no will id');
    }
    const spec = await this.getSpec(options);
    const willId = (spec.funcResToNative('create_will', returnValue) as bigint).toString();
    return { willId, txHash };
  }

  /**
   * Resets the check-in countdown for `willId`.
   *
   * @returns The transaction hash and the new check-in deadline.
   * @throws {SoroWillError} If the transaction simulation fails or returns no result.
   * @throws {RequestTimeoutError} If the RPC request exceeds its configured timeout.
   * @throws {WillNotFoundError} If the will does not exist.
   * @throws {NotOwnerError} If the caller is not the will's owner.
   * @throws {WillNotActiveError} If the will is not in an active state.
   * @throws {CheckinNotDueError} If the check-in deadline has not yet passed.
   * @throws {Error} If the wallet is not connected or fails to sign.
   */
  async checkIn(
    willId: string,
    options?: RequestOptions,
  ): Promise<{ txHash: string; nextDeadline: Date }> {
    const owner = await getPublicKey();
    const will = await this.getWill(willId, options);
    const { txHash, createdAt } = await this.invoke(
      'check_in',
      { will_id: BigInt(willId), owner },
      options,
    );
    return {
      txHash,
      nextDeadline: new Date((createdAt + will.checkinPeriodDays * 86_400) * 1000),
    };
  }

  /**
   * Starts the grace period for `willId` once the check-in deadline has passed.
   *
   * @returns The transaction hash.
   * @throws {SoroWillError} If the transaction simulation/submission fails.
   * @throws {RequestTimeoutError} If the RPC request exceeds its configured timeout.
   * @throws {WillNotFoundError} If the will does not exist.
   * @throws {CheckinNotDueError} If the check-in deadline has not passed.
   * @throws {Error} If the wallet is not connected or fails to sign.
   */
  async triggerWill(willId: string, options?: RequestOptions): Promise<{ txHash: string }> {
    const { txHash } = await this.invoke('trigger_will', { will_id: BigInt(willId) }, options);
    return { txHash };
  }

  /**
   * Cancels an in-progress trigger during the grace period, resetting the countdown.
   *
   * @returns The transaction hash and the new check-in deadline.
   * @throws {SoroWillError} If the transaction simulation/submission fails.
   * @throws {RequestTimeoutError} If the RPC request exceeds its configured timeout.
   * @throws {WillNotFoundError} If the will does not exist.
   * @throws {NotOwnerError} If the caller is not the will's owner.
   * @throws {WillNotTriggeredError} If the will has not been triggered.
   * @throws {GracePeriodExpiredError} If the grace period has already expired.
   * @throws {Error} If the wallet is not connected or fails to sign.
   */
  async emergencyCheckIn(
    willId: string,
    options?: RequestOptions,
  ): Promise<{ txHash: string; nextDeadline: Date }> {
    const owner = await getPublicKey();
    const will = await this.getWill(willId, options);
    const { txHash, createdAt } = await this.invoke(
      'emergency_checkin',
      { will_id: BigInt(willId), owner },
      options,
    );
    return {
      txHash,
      nextDeadline: new Date((createdAt + will.checkinPeriodDays * 86_400) * 1000),
    };
  }

  /**
   * Distributes the will's balance to all beneficiaries once the grace period has elapsed.
   *
   * @returns The transaction hash.
   * @throws {SoroWillError} If the transaction simulation/submission fails.
   * @throws {RequestTimeoutError} If the RPC request exceeds its configured timeout.
   * @throws {WillNotFoundError} If the will does not exist.
   * @throws {WillNotTriggeredError} If the will has not been triggered.
   * @throws {GracePeriodNotExpiredError} If the grace period has not yet expired.
   * @throws {Error} If the wallet is not connected or fails to sign.
   */
  async releaseInheritance(
    willId: string,
    options?: RequestOptions,
  ): Promise<{ txHash: string }> {
    const { txHash } = await this.invoke(
      'release_inheritance',
      { will_id: BigInt(willId) },
      options,
    );
    return { txHash };
  }

  /**
   * Cancels the will and withdraws the full balance back to the owner.
   *
   * @returns The transaction hash and the refunded amount.
   * @throws {SoroWillError} If the transaction simulation/submission fails.
   * @throws {RequestTimeoutError} If the RPC request exceeds its configured timeout.
   * @throws {WillNotFoundError} If the will does not exist.
   * @throws {NotOwnerError} If the caller is not the will's owner.
   * @throws {WillNotActiveError} If the will is not in an active state.
   * @throws {Error} If the wallet is not connected or fails to sign.
   */
  async cancelWill(
    willId: string,
    options?: RequestOptions,
  ): Promise<{ txHash: string; refundAmount: string }> {
    const owner = await getPublicKey();
    const will = await this.getWill(willId, options);
    const { txHash } = await this.invoke(
      'cancel_will',
      { will_id: BigInt(willId), owner },
      options,
    );
    return { txHash, refundAmount: will.balance };
  }

  /**
   * Replaces the beneficiary list for a will before it has been triggered.
   *
   * @returns The transaction hash.
   * @throws {SoroWillError} If the transaction simulation/submission fails.
   * @throws {RequestTimeoutError} If the RPC request exceeds its configured timeout.
   * @throws {WillNotFoundError} If the will does not exist.
   * @throws {NotOwnerError} If the caller is not the will's owner.
   * @throws {WillNotActiveError} If the will is not in an active state.
   * @throws {InvalidPercentagesError} If beneficiary percentages do not sum to 100.
   * @throws {TooManyBeneficiariesError} If too many beneficiaries are supplied.
   * @throws {Error} If the wallet is not connected or fails to sign.
   */
  async updateBeneficiaries(
    params: UpdateBeneficiariesParams,
    options?: RequestOptions,
  ): Promise<{ txHash: string }> {
    const owner = await getPublicKey();
    const { txHash } = await this.invoke(
      'update_beneficiaries',
      { will_id: BigInt(params.willId), owner, beneficiaries: params.beneficiaries },
      options,
    );
    return { txHash };
  }

  /**
   * Adds more of the will's token to its locked balance.
   *
   * @returns The transaction hash.
   * @throws {SoroWillError} If the transaction simulation/submission fails.
   * @throws {RequestTimeoutError} If the RPC request exceeds its configured timeout.
   * @throws {WillNotFoundError} If the will does not exist.
   * @throws {NotOwnerError} If the caller is not the will's owner.
   * @throws {WillNotActiveError} If the will is not in an active state.
   * @throws {ZeroAmountError} If the amount is zero or negative.
   * @throws {Error} If the wallet is not connected or fails to sign.
   */
  async topUp(
    willId: string,
    amount: string,
    options?: RequestOptions,
  ): Promise<{ txHash: string }> {
    const owner = await getPublicKey();
    const { txHash } = await this.invoke(
      'top_up',
      { will_id: BigInt(willId), owner, amount: BigInt(amount) },
      options,
    );
    return { txHash };
  }

  /**
   * Casts a guardian vote to force an early release of `willId`. Once 2 of
   * the will's guardians have voted, the balance is released automatically.
   *
   * @returns The transaction hash.
   * @throws {SoroWillError} If the transaction simulation/submission fails.
   * @throws {RequestTimeoutError} If the RPC request exceeds its configured timeout.
   * @throws {WillNotFoundError} If the will does not exist.
   * @throws {NotGuardianError} If the caller is not a guardian of this will.
   * @throws {AlreadyVotedError} If this guardian has already voted.
   * @throws {Error} If the wallet is not connected or fails to sign.
   */
  async guardianTrigger(
    willId: string,
    options?: RequestOptions,
  ): Promise<{ txHash: string }> {
    const guardian = await getPublicKey();
    const { txHash } = await this.invoke(
      'guardian_trigger',
      { will_id: BigInt(willId), guardian },
      options,
    );
    return { txHash };
  }

  /**
   * Combines contract calls into one atomic transaction and one wallet signature prompt.
   * Arguments use the native names and values accepted by the deployed contract spec.
   *
   * @returns The transaction hash and creation timestamp.
   * @throws {RangeError} If the batch contains zero operations.
   * @throws {SoroWillError} If the transaction simulation/submission fails.
   * @throws {RequestTimeoutError} If the RPC request exceeds its configured timeout.
   * @throws {WillContractError} Mapped contract-level errors from any operation in the batch.
   * @throws {Error} If the wallet is not connected or fails to sign.
   */
  async batch(
    operations: readonly BatchOperation[],
    options?: RequestOptions,
  ): Promise<BatchResult> {
    if (operations.length === 0) {
      throw new RangeError('A batch must contain at least one operation');
    }
    const spec = await this.getSpec(options);
    const contractOperations = operations.map(({ method, args }) =>
      this.contract.call(method, ...spec.funcArgsToScVals(method, args)),
    );

    // Build a multi-operation transaction manually (batch has its own path
    // since buildTransaction handles single operations)
    const publicKey = await getPublicKey();
    const account = await this.rpc(
      () => this.rpcPool.withFailover((server) => server.getAccount(publicKey)),
      options,
    );
    const builder = new TransactionBuilder(account, {
      fee: (BigInt(BASE_FEE) * BigInt(contractOperations.length)).toString(),
      networkPassphrase: this.networkPassphrase,
    });
    for (const op of contractOperations) {
      builder.addOperation(op);
    }
    const builtTx = builder.setTimeout(30).build();

    const prepared = await this.rpc(
      () => this.rpcPool.withFailover((server) => server.prepareTransaction(builtTx)),
      options,
    );

    assertPreparedTransactionMatchesIntendedOperation({
      intendedTransactionXdr: builtTx.toXDR(),
      preparedTransactionXdr: prepared.toXDR(),
      networkPassphrase: this.networkPassphrase,
      context: 'batch',
    });

    const signedTxXdr = await signTransaction(prepared.toXDR(), {
      networkPassphrase: this.networkPassphrase,
    });
    const result = await this.submitSignedTransaction(signedTxXdr, options);
    return { txHash: result.txHash, createdAt: result.createdAt };
  }

  // -----------------------------------------------------------------------
  // Public: low-level transaction building / submission
  // -----------------------------------------------------------------------

  /**
   * Builds (but does not sign or submit) a Stellar transaction for a state-changing
   * contract call. The returned transaction includes the operation and fee, but must
   * still be prepared (`server.prepareTransaction`) and signed before submission.
   *
   * Advanced integrators can use this to inspect the transaction before signing,
   * implement custom multi-signature flows, or batch with other operations outside
   * the SDK's built-in submission pipeline.
   *
   * @param method - The contract function name (e.g. `'create_will'`).
   * @param args - Native named arguments expected by the deployed contract spec.
   * @param sourcePublicKey - Optional override for the source account. Defaults to the connected wallet's public key.
   * @returns An unsigned {@link Transaction} ready for inspection or preparation.
   * @throws {Error} If the wallet is not connected (when no sourcePublicKey is provided).
   * @throws {Error} If the RPC call to fetch the source account fails.
   */
  async buildTransaction(
    method: string,
    args: Record<string, unknown>,
    sourcePublicKey?: string,
  ): Promise<Transaction> {
    return this.buildInvocationTransaction(method, args, sourcePublicKey);
  }

  /**
   * Submits a signed transaction XDR to the network and polls for confirmation.
   * Use this in conjunction with {@link buildTransaction} when you need full control
   * over the signing step (e.g. hardware wallet, multi-sig cosigning, SEP-7 callback).
   *
   * The caller is responsible for calling `server.prepareTransaction()` and signing
   * the transaction before passing it to this method.
   *
   * @param signedXdr - The base64-encoded XDR of the fully signed transaction.
   * @param options - Optional request timeout override.
   * @returns The transaction hash, ledger-close timestamp, and optional return value.
   * @throws {SoroWillError} If the transaction submission returns an error status.
   * @throws {SoroWillError} If the transaction does not reach SUCCESS status after polling.
   * @throws {RequestTimeoutError} If the RPC request exceeds its configured timeout.
   */
  async submitSignedTransaction(
    signedXdr: string,
    options?: RequestOptions,
  ): Promise<{ txHash: string; createdAt: number; returnValue: ScVal | undefined }> {
    const signedTx = TransactionBuilder.fromXDR(
      signedXdr,
      this.networkPassphrase,
    ) as Transaction;

    const sendResponse = await this.rpc(
      () => this.rpcPool.withFailover((server) => server.sendTransaction(signedTx)),
      options,
    );
    if (sendResponse.status === 'ERROR') {
      const errorXdr = sendResponse.errorResult?.toXDR('base64') ?? 'no error result';
      throw new SoroWillError(`SoroWill transaction submission failed: ${errorXdr}`);
    }

    const txResponse = await this.rpc(
      () =>
        this.rpcPool.withFailover((server) =>
          server.pollTransaction(sendResponse.hash, { attempts: 30 }),
        ),
      options,
    );
    if (txResponse.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
      throw new SoroWillError(
        `SoroWill transaction did not succeed: ${txResponse.status}`,
      );
    }

    return {
      txHash: sendResponse.hash,
      createdAt: txResponse.createdAt,
      returnValue: txResponse.returnValue,
    };
  }

  // -----------------------------------------------------------------------
  // Public: SEP-7
  // -----------------------------------------------------------------------

  /**
   * Builds a SEP-7 deep-link URI for a state-changing contract call, so a
   * mobile wallet can sign it outside the browser extension flow.
   *
   * @returns The `web+stellar:tx?...` URI string.
   * @throws {Error} If the RPC call to build the transaction fails.
   */
  async buildSep7SigningUri(
    method: string,
    args: Record<string, unknown>,
    sourcePublicKey: string,
    options: BuildSep7TxUriOptions,
  ): Promise<string> {
    const prepared = await this.prepareInvocation(method, args, undefined, sourcePublicKey);
    return buildSep7TxUri(prepared.toXDR(), {
      ...options,
      networkPassphrase: options.networkPassphrase ?? this.networkPassphrase,
    });
  }

  // -----------------------------------------------------------------------
  // Public: read methods
  // -----------------------------------------------------------------------

  /**
   * Reads the full state of a will. Does not require a connected wallet.
   * Results are cached for the duration of the client's configured TTL.
   *
   * @returns The decoded will state.
   * @throws {SoroWillError} If the simulation fails or returns no result.
   * @throws {RequestTimeoutError} If the RPC request exceeds its configured timeout.
   * @throws {WillContractError} Mapped contract-level errors.
   */
  async getWill(willId: string, options?: RequestOptions): Promise<Will> {
    const raw = await this.readCached<RawWill>(
      `get_will:${willId}`,
      () => this.read<RawWill>('get_will', { will_id: BigInt(willId) }, options),
    );
    return mapWill(raw);
  }

  /**
   * Lists every will owned by `owner`. Does not require a connected wallet.
   * Results are cached for the duration of the client's configured TTL.
   *
   * When `options` includes {@link PaginationOptions}, returns a
   * {@link PaginatedWillsResult} instead of a plain array.
   *
   * @returns A list of wills, or a paginated result when pagination options are provided.
   * @throws {SoroWillError} If the simulation fails or returns no result.
   * @throws {RequestTimeoutError} If the RPC request exceeds its configured timeout.
   */
  async getWillsByOwner(
    owner: string,
    options?: RequestOptions & PaginationOptions,
  ): Promise<Will[] | PaginatedWillsResult> {
    const raw = await this.readCached<RawWill[]>(
      `get_wills_by_owner:${owner}`,
      () => this.read<RawWill[]>('get_wills_by_owner', { owner }, options),
    );
    const wills = raw.map(mapWill);
    return paginateWills(wills, options);
  }

  /**
   * Lists every will `beneficiary` is named in. Does not require a connected wallet.
   * Results are cached for the duration of the client's configured TTL.
   *
   * When `options` includes {@link PaginationOptions}, returns a
   * {@link PaginatedWillsResult} instead of a plain array.
   *
   * @returns A list of wills, or a paginated result when pagination options are provided.
   * @throws {SoroWillError} If the simulation fails or returns no result.
   * @throws {RequestTimeoutError} If the RPC request exceeds its configured timeout.
   */
  async getWillsByBeneficiary(
    beneficiary: string,
    options?: RequestOptions & PaginationOptions,
  ): Promise<Will[] | PaginatedWillsResult> {
    const raw = await this.readCached<RawWill[]>(
      `get_wills_by_beneficiary:${beneficiary}`,
      () => this.read<RawWill[]>('get_wills_by_beneficiary', { beneficiary }, options),
    );
    const wills = raw.map(mapWill);
    return paginateWills(wills, options);
  }

  // -----------------------------------------------------------------------
  // Public: fee preview
  // -----------------------------------------------------------------------

  /**
   * Previews the Soroban resource fee for a state-changing call without
   * signing or submitting a transaction.
   *
   * @returns The minimum resource fee the network will require, in stroops.
   * @throws {SoroWillError} If the simulation fails.
   * @throws {RequestTimeoutError} If the RPC request exceeds its configured timeout.
   */
  async previewFee(
    method: string,
    args: Record<string, unknown>,
    options?: RequestOptions,
  ): Promise<{ resourceFee: string }> {
    const spec = await this.getSpec(options);
    const scArgs = spec.funcArgsToScVals(method, args);
    const operation = this.contract.call(method, ...scArgs);

    const publicKey = await getPublicKey();
    const account = await this.rpc(
      () => this.rpcPool.withFailover((server) => server.getAccount(publicKey)),
      options,
    );
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(30)
      .build();

    const simulation = await this.rpc(
      () => this.rpcPool.withFailover((server) => server.simulateTransaction(tx)),
      options,
    );
    if (rpc.Api.isSimulationError(simulation)) {
      throw new SoroWillError(`SoroWill simulation failed for ${method}: ${simulation.error}`);
    }
    if (!simulation.minResourceFee) {
      throw new SoroWillError(`SoroWill simulation for ${method} returned no resource fee`);
    }
    return { resourceFee: simulation.minResourceFee };
  }

  // -----------------------------------------------------------------------
  // Public: event subscriptions
  // -----------------------------------------------------------------------

  /**
   * Subscribes to real-time contract events emitted by the SoroWill contract.
   *
   * @param listener - Called for each received event.
   * @param options - Transport and polling configuration.
   * @returns A subscription handle that can be used to unsubscribe.
   * @throws {Error} If the requested transport cannot be established.
   */
  async subscribeToEvents(
    listener: (event: SoroWillEvent) => void,
    options: EventSubscriptionOptions = {},
  ): Promise<EventSubscription> {
    const transport = options.transport ?? 'auto';
    const pollIntervalMs = options.pollIntervalMs ?? this.defaultPollIntervalMs;
    const contractId = this.contract.contractId();

    if (transport === 'websocket' || transport === 'auto') {
      try {
        return await this.createWebSocketSubscription(listener, contractId, options);
      } catch {
        if (transport === 'websocket') {
          throw new Error('WebSocket event subscription failed');
        }
      }
    }

    return this.createPollingSubscription(listener, contractId, pollIntervalMs, options);
  }

  /** Unsubscribes from any configured event source and cleans up resources. */
  destroy(): void {
    if (this.eventSubscription) {
      unsubscribeFromWillEvents(this.eventSubscription);
    }
    this.readCache?.clear();
  }

  // -----------------------------------------------------------------------
  // Private: spec loading
  // -----------------------------------------------------------------------

  /** Lazily fetches and caches the contract's spec from its deployed wasm. */
  private async getSpec(
    options?: RequestOptions,
  ): Promise<InstanceType<typeof Spec>> {
    if (!this.specPromise) {
      if (this.specOverride) {
        // If the override is already a Spec instance, use it directly.
        // Otherwise treat it as a ContractSpecLike and bootstrap from wasm.
        this.specPromise = Promise.resolve(this.specOverride).then((override) => {
          if (override instanceof Spec) return override;
          // Fall back to server fetch for contract-spec-like overrides
          return this.rpc(
            () =>
              this.rpcPool.withFailover((server) =>
                server.getContractWasmByContractId(this.contract.contractId()),
              ),
            options,
          ).then((wasm) => Spec.fromWasm(wasm));
        });
      } else {
        this.specPromise = this.rpc(
          () =>
            this.rpcPool.withFailover((server) =>
              server.getContractWasmByContractId(this.contract.contractId()),
            ),
          options,
        ).then((wasm) => Spec.fromWasm(wasm));
      }
    }
    return await this.specPromise;
  }

  // -----------------------------------------------------------------------
  // Private: read simulation (with caching)
  // -----------------------------------------------------------------------

  /** Returns a cached value if available, otherwise loads and caches it. */
  private async readCached<T>(cacheKey: string, load: () => Promise<T>): Promise<T> {
    if (this.readCache) {
      const cached = this.readCache.get<T>(cacheKey);
      if (cached !== undefined) {
        return cached;
      }
    }

    const value = await load();
    this.readCache?.set(cacheKey, value);
    return value;
  }

  /** Simulates a read-only contract call, requiring no connected wallet or signature. */
  private async read<T>(
    method: string,
    args: Record<string, unknown>,
    options?: RequestOptions,
  ): Promise<T> {
    try {
      const spec = await this.getSpec(options);
      const scArgs = spec.funcArgsToScVals(method, args);
      const operation = this.contract.call(method, ...scArgs);

      const account = new Account(NULL_ACCOUNT, '0');
      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(operation)
        .setTimeout(30)
        .build();

      const simulation = await this.rpc(
        () => this.rpcPool.withFailover((server) => server.simulateTransaction(tx)),
        options,
      );
      if (rpc.Api.isSimulationError(simulation)) {
        throw new SoroWillError(`SoroWill simulation failed for ${method}: ${simulation.error}`);
      }
      if (!simulation.result) {
        throw new SoroWillError(`SoroWill simulation for ${method} returned no result`);
      }

      return spec.funcResToNative(method, simulation.result.retval) as T;
    } catch (error) {
      throw mapContractError(error);
    }
  }

  // -----------------------------------------------------------------------
  // Private: invoke (high-level: build → prepare → sign → submitSignedTransaction)
  // -----------------------------------------------------------------------

  /**
   * Builds, signs, and submits a state-changing contract call using the
   * shared {@link buildTransaction} and {@link submitSignedTransaction} primitives.
   */
  private async invoke(
    method: string,
    args: Record<string, unknown>,
    options?: RequestOptions,
  ): Promise<{ txHash: string; createdAt: number; returnValue: ScVal | undefined }> {
    // Run beforeInvoke hooks
    const beforeCtx: BeforeInvokeContext = {
      method,
      args,
      timestamp: new Date().toISOString(),
    };
    const proceed = await this.hooks.runBeforeInvoke(beforeCtx);
    if (!proceed) {
      throw new SoroWillError(`SoroWill invocation aborted by beforeInvoke hook for ${method}`);
    }

    const startTime = Date.now();
    let txHash: string | null = null;
    let error: string | null = null;

    try {
      // 1. Build the transaction
      const builtTx = await this.buildTransaction(method, args);

      // 2. Prepare (simulate) via the RPC pool
      const prepared = await this.rpc(
        () =>
          this.rpcPool.withFailover((server) => server.prepareTransaction(builtTx)),
        options,
      );

      // 3. Validate the prepared transaction hasn't been tampered with
      assertPreparedTransactionMatchesIntendedOperation({
        intendedTransactionXdr: builtTx.toXDR(),
        preparedTransactionXdr: prepared.toXDR(),
        networkPassphrase: this.networkPassphrase,
        context: method,
      });

      // 4. Sign via the configured wallet
      const signedTxXdr = await signTransaction(prepared.toXDR(), {
        networkPassphrase: this.networkPassphrase,
      });

      // 5. Submit via the shared primitive (returns txHash, createdAt, returnValue)
      const result = await this.submitSignedTransaction(signedTxXdr, options);
      txHash = result.txHash;

      // Invalidate read cache for mutations
      if (this.readCache) {
        if (method === 'create_will') {
          this.readCache.clear();
        } else if (args.will_id) {
          this.readCache.invalidateByWillId(String(args.will_id));
        }
      }

      const afterCtx: AfterInvokeContext = {
        method,
        args,
        timestamp: new Date().toISOString(),
        txHash,
        error: null,
        durationMs: Date.now() - startTime,
      };
      await this.hooks.runAfterInvoke(afterCtx);

      return {
        txHash: result.txHash,
        createdAt: result.createdAt,
        returnValue: result.returnValue,
      };
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);

      const afterCtx: AfterInvokeContext = {
        method,
        args,
        timestamp: new Date().toISOString(),
        txHash,
        error,
        durationMs: Date.now() - startTime,
      };
      await this.hooks.runAfterInvoke(afterCtx);

      throw mapContractError(err);
    }
  }

  // -----------------------------------------------------------------------
  // Private: RPC wrapper through queue
  // -----------------------------------------------------------------------

  /** Sends every RPC through the shared FIFO queue with the selected timeout. */
  private rpc<T>(request: () => Promise<T>, options?: RequestOptions): Promise<T> {
    return this.queue.enqueue(request, options?.timeoutMs ?? this.timeoutMs);
  }

  // -----------------------------------------------------------------------
  // Private: transaction building helpers
  // -----------------------------------------------------------------------

  private async buildInvocationTransaction(
    method: string,
    args: Record<string, unknown>,
    sourcePublicKey?: string,
  ): Promise<Transaction> {
    const spec = await this.getSpec();
    const scArgs = spec.funcArgsToScVals(method, args);
    const operation = this.contract.call(method, ...scArgs);

    const publicKey = sourcePublicKey ?? (await getPublicKey());
    const account = await this.rpcPool.withFailover((server) => server.getAccount(publicKey));
    return new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(30)
      .build();
  }

  private async prepareInvocation(
    method: string,
    args: Record<string, unknown>,
    builtTx?: Transaction,
    sourcePublicKey?: string,
  ): Promise<Transaction> {
    const transaction =
      builtTx ?? (await this.buildInvocationTransaction(method, args, sourcePublicKey));
    return this.rpcPool.withFailover((server) => server.prepareTransaction(transaction));
  }

  // -----------------------------------------------------------------------
  // Private: event subscription helpers
  // -----------------------------------------------------------------------

  private deriveDefaultEventStreamUrl(eventRpcUrl: string): string {
    const url = new URL(eventRpcUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = url.pathname.replace(/\/?$/, '/events');
    return url.toString();
  }

  private async createWebSocketSubscription(
    listener: (event: SoroWillEvent) => void,
    contractId: string,
    options: EventSubscriptionOptions,
  ): Promise<EventSubscription> {
    const wsFactory =
      this.webSocketFactory ?? ((url: string) => new WebSocket(url) as WebSocketLike);
    let ws: WebSocketLike | null = null;
    let closed = false;

    const connect = () => {
      ws = wsFactory(this.eventStreamUrl);
      ws.onopen = () => {
        ws?.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'subscribe',
            params: {
              contractIds: [contractId],
              cursor: options.cursor,
              pageSize: options.pageSize,
            },
          }),
        );
      };
      ws.onmessage = (event: { data: string }) => {
        try {
          const parsed = JSON.parse(event.data);
          if (parsed.result?.events) {
            for (const record of parsed.result.events) {
              listener(mapEventRecord(record, contractId));
            }
          }
        } catch {
          // Ignore parse errors for non-JSON messages
        }
      };
      ws.onerror = (err: Event | unknown) => {
        options.onError?.(err instanceof Error ? err : new Error('WebSocket error'));
      };
      ws.onclose = () => {
        closed = true;
      };
    };

    connect();

    return {
      transport: 'websocket',
      get closed() {
        return closed;
      },
      close() {
        closed = true;
        ws?.close();
      },
    };
  }

  private async createPollingSubscription(
    listener: (event: SoroWillEvent) => void,
    contractId: string,
    pollIntervalMs: number,
    options: EventSubscriptionOptions,
  ): Promise<EventSubscription> {
    let closed = false;
    let cursor: string | undefined = options.cursor;
    const fetchImpl = this.fetchImplementation ?? fetch;

    const poll = async () => {
      if (closed) return;

      try {
        const params: Record<string, unknown> = {
          jsonrpc: '2.0',
          id: 1,
          method: 'getEvents',
          params: {
            filters: [{ contractIds: [contractId] }],
            pagination: {
              cursor,
              limit: options.pageSize ?? 100,
            },
          },
        };

        const response = await fetchImpl(this.eventRpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(params),
        });

        const body = await response.json();
        const events: RpcEventRecord[] = body.result?.events ?? [];
        for (const record of events) {
          listener(mapEventRecord(record, contractId));
        }

        if (body.result?.nextCursor) {
          cursor = body.result.nextCursor;
        }
      } catch (err) {
        options.onError?.(err instanceof Error ? err : new Error(String(err)));
      }

      if (!closed) {
        setTimeout(poll, pollIntervalMs);
      }
    };

    setTimeout(poll, 0);

    return {
      transport: 'polling',
      get closed() {
        return closed;
      },
      close() {
        closed = true;
      },
    };
  }
}
