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

import { ReadCache, createReadCacheKey, type ReadCacheOptions } from './cache';
import { unsubscribeFromWillEvents, type WillEventSource, type WillEventSubscription } from './events';
import { mapContractError, SoroWillError, WalletNetworkMismatchError } from './errors';
import { HookManager } from './hooks';
import type { AfterInvokeContext, BeforeInvokeContext } from './hooks';
import { RequestQueue } from './requestQueue';
import {
  ReadCache,
  type ReadCacheOptions,
} from './cache';
import {
  SoroWillError,
  SoroWillRestoreRequiredError,
  mapContractError,
} from './errors';
import {
  unsubscribeFromWillEvents,
  type WillEventSource,
  type WillEventSubscription,
} from './events';
import { HookManager } from './hooks';
import type { BeforeInvokeContext, AfterInvokeContext } from './hooks';
import { RequestQueue } from './requestQueue';
import { RpcEndpointPool } from './rpc';
import { buildSep7TxUri, type BuildSep7TxUriOptions } from './sep7';
import { assertPreparedTransactionMatchesIntendedOperation } from './txValidation';
import type {
  BatchOperation,
  BatchResult,
  Beneficiary,
  CreateWillParams,
  EventSubscription,
  EventSubscriptionOptions,
  PaginatedWillsResult,
  PaginationOptions,
  RequestOptions,
  SoroWillEvent,
  UpdateBeneficiariesParams,
  Will,
} from './types';
import { WillStatus } from './types';
import { getPublicKey, signTransaction, type WalletAdapter, type WalletConnection } from './wallet';
import { getPublicKey, signTransaction, type WalletAdapter } from './wallet';
import {
  freighterAdapter,
  getDefaultWalletAdapter,
  getPublicKey,
  signTransaction,
  type WalletAdapter,
} from './wallet';
import { mapContractError, SoroWillError } from './errors';
import { RequestQueue } from './requestQueue';
import { RpcEndpointPool } from './rpc';
import { buildSep7TxUri, type BuildSep7TxUriOptions } from './sep7';
import { HookManager } from './hooks';
import type { BeforeInvokeContext, AfterInvokeContext } from './hooks';
import { assertPreparedTransactionMatchesIntendedOperation } from './txValidation';

type ScVal = xdr.ScVal;

const { Spec } = stellarContract;

type ScVal = xdr.ScVal;

/** An impossible account used to simulate read-only calls without a connected wallet. */
const NULL_ACCOUNT = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

/** Supported Stellar networks. */
export type SoroWillNetwork = 'testnet' | 'mainnet';

interface NetworkConfig {
  rpcUrl: string;
  networkPassphrase: string;
}

const NETWORK_CONFIG: Record<SoroWillNetwork, NetworkConfig> = {
  testnet: {
    rpcUrl: 'https://soroban-testnet.stellar.org',
    networkPassphrase: Networks.TESTNET,
  },
  mainnet: {
    rpcUrl: 'https://mainnet.sorobanrpc.com',
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

export interface SoroWillReadCacheOptions extends Pick<ReadCacheOptions, 'ttlMs'> {}

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
   * Defaults to the Freighter browser extension. Supply any {@link WalletAdapter}
   * — e.g. `createAlbedoAdapter()` — to use a different Stellar wallet.
   * Defaults to the Freighter browser extension for backwards compatibility.
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
  /**
   * Advanced override for testing or preloaded contract specs.
   *
   * By injecting a pre-built spec you can write snapshot tests that lock in
   * the exact `ScVal` / XDR encoding produced by `funcArgsToScVals` for each
   * state-changing method. This guards against silent encoding regressions
   * introduced by a future `@stellar/stellar-sdk` upgrade — the spec object
   * is what drives argument encoding, so swapping it in tests lets you assert
   * the exact serialised shape without making real RPC calls.
   *
   * @example
   * ```ts
   * import { contract } from '@stellar/stellar-sdk';
   *
   * const spec = new contract.Spec(rawSpecXdrEntries);
   *
   * // In your snapshot test:
   * const scVals = spec.funcArgsToScVals('create_will', { owner: 'G...', ... });
   * expect(scVals.map((v) => v.toXDR('base64'))).toMatchSnapshot();
   *
   * // And in the client under test:
   * const client = new SoroWillClient({ network: 'testnet', contractId: 'C...', spec });
   * ```
   *
   * See `CONTRIBUTING.md` → *ScVal / XDR snapshot tests* for the full
   * workflow, including how to intentionally update snapshots when a
   * dependency upgrade legitimately changes encoding.
   */
  spec?: ContractSpecLike | Promise<ContractSpecLike>;
  /**
   * Optional pre-serialized contract spec. Accepts any format the Stellar
   * SDK {@link Spec} constructor supports: a `Buffer`, base64 XDR string,
   * array of `xdr.ScSpecEntry`, or array of base64-encoded entry strings.
   *
   * When provided, the client skips the `getContractWasmByContractId`
   * round-trip on first call and constructs the `Spec` directly from this
   * data. Falls back to the existing lazy-fetch behavior when not
   * provided, so this is fully backwards compatible.
   *
   * **Tradeoff**: Faster first call, but the caller is responsible for
   * keeping the bundled spec in sync with the deployed contract. Use
   * this only when you control the spec artifact (e.g. from the contracts
   * repo's spec-publishing pipeline, issue #97).
   */
  specJson?: Buffer | string | unknown[];
  /** Optional override for the Soroban RPC endpoint. */
  rpcUrl?: string;
  /** Optional list of RPC endpoints to use with automatic failover. */
  rpcUrls?: string[];
  /** Optional override for the Stellar network passphrase. */
  networkPassphrase?: string | undefined;
  /** Optional override for the endpoint used for event polling. */
  eventRpcUrl?: string | undefined;
  /** Optional override for the WebSocket event streaming endpoint. */
  eventStreamUrl?: string | undefined;
  /** Default polling interval for event subscriptions. */
  defaultPollIntervalMs?: number;
  /**
   * Optional override for the `fetch` implementation used by event-polling
   * requests inside the SDK.
   *
   * **When to use this:**
   * - Injecting a polyfill in environments where a global `fetch` is not
   *   available (older Node versions, some React Native runtimes).
   * - Adding custom headers or proxy logic to outbound HTTP requests.
   * - Providing a mock in unit tests without patching the global.
   *
   * **Important:** This option only affects the SDK's own HTTP calls (event
   * polling). The underlying `@stellar/stellar-sdk` `rpc.Server` uses its own
   * fetch binding, which cannot be overridden through this option. If you need
   * a custom fetch for all Soroban RPC traffic, install a global fetch
   * polyfill (e.g. `node-fetch` v3, or `cross-fetch`) before constructing the
   * client:
   *
   * ```ts
   * import fetch from 'node-fetch';
   * globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
   * ```
   *
   * @example
   * ```ts
   * import fetch from 'node-fetch';
   *
   * const client = new SoroWillClient({
   *   network: 'testnet',
   *   contractId: 'C...',
   *   fetch: fetch as unknown as typeof globalThis.fetch,
   * });
   * ```
   */
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
  /**
   * Maximum number of poll attempts for transaction finality.
   * Defaults to 30. Increase under mainnet congestion.
   */
  pollAttempts?: number;
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

const DEFAULT_RETRY_OPTIONS: RpcRetryOptions = {
  maxAttempts: 3,
  initialDelayMs: 250,
  maxDelayMs: 2_000,
  backoffFactor: 2,
};

const DEFAULT_POLL_ATTEMPTS = 30;

interface SimulatedCallResult {
  result?: {
    retval: ScVal;
  };
  minResourceFee?: string;
}

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

function getMutationWillIds(_method: string, args: Record<string, unknown>): string[] {
  if (typeof args.will_id === 'bigint') {
    return [args.will_id.toString()];
  }

  return [];
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

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** Cache keys for a read result, so a later mutation can invalidate just the affected wills. */
function getWillIdsFromReadResult(
  method: string,
  args: Record<string, unknown>,
  result: unknown,
): string[] {
  if (method === 'get_will' && typeof args.will_id === 'bigint') {
    return [args.will_id.toString()];
  }

  if (Array.isArray(result)) {
    return result
      .filter((item): item is RawWill => Boolean(item) && typeof item === 'object' && 'id' in item)
      .map((item) => item.id.toString());
  }

  return [];
}

function getMutationWillIds(args: Record<string, unknown>): string[] {
  return typeof args.will_id === 'bigint' ? [args.will_id.toString()] : [];
}

/**
 * A client for interacting with a deployed SoroWill contract from
 * TypeScript. Read methods (`getWill`, `getWillsByOwner`,
 * `getWillsByBeneficiary`) work without a connected wallet. All other
 * methods sign and submit a transaction via the configured wallet adapter.
 *
 * The contract spec (WASM) is lazily fetched and cached in memory on first
 * use. If the contract is redeployed with a new WASM while a client instance
 * is still alive, call {@link refreshSpec} to invalidate the cached spec so
 * subsequent calls encode/decode against the updated interface.
 */
export class SoroWillClient {
  private readonly server: SoroWillRpcServer;
  private readonly rpcPool: RpcEndpointPool;
  private readonly contract: Contract;
  private readonly networkPassphrase: string;
  private readonly hooks: HookManager;
  private readonly readCache: ReadCache | undefined;
  private readonly specOverride: ContractSpecLike | Promise<ContractSpecLike> | undefined;
  private readonly queue: RequestQueue;
  private readonly timeoutMs: number;
  private readonly wallet: WalletAdapter;
  private readonly retryOptions: RpcRetryOptions;
  private readonly pollAttempts: number;
  private readonly specOverride: ContractSpecLike | Promise<ContractSpecLike> | undefined;
  private readonly specJsonOverride: Buffer | string | unknown[] | undefined;
  private specPromise: Promise<ContractSpecLike> | undefined;
  private readonly eventSubscription?: WillEventSubscription;
  private specPromise: Promise<ContractSpecLike> | undefined;

  constructor(options: SoroWillClientOptions) {
    const config = NETWORK_CONFIG[options.network];
    const rpcUrl: string = options.rpcUrl ?? config.rpcUrls[0] ?? '';
    this.server =
      options.rpcServer ??
      new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith('http://') });
    this.rpcPool = new RpcEndpointPool(options.rpcUrls ?? config.rpcUrls);
    this.contract = new Contract(options.contractId);
    this.networkPassphrase = options.networkPassphrase ?? config.networkPassphrase;
    this.hooks = options.hooks ?? new HookManager();
    this.readCache = options.readCache === false ? undefined : new ReadCache(options.readCache);
    this.specOverride = options.spec;
    this.specJsonOverride = options.specJson;

    if (this.readCache && options.eventSource) {
      this.eventSubscription = options.eventSource.subscribe((event) => {
        void this.readCache?.invalidateByWillId(event.willId);
      });
    }
  }

  /** Locks `params.amount` of `params.token` and creates a new will. */
  async createWill(params: CreateWillParams): Promise<{ willId: string; txHash: string }> {
    const owner = await this.wallet.getPublicKey();
  private readonly eventSubscription?: WillEventSubscription;
  private readonly rpcPool: RpcEndpointPool;
  private readonly eventRpcUrl: string;
  private readonly eventStreamUrl: string;
  private readonly defaultPollIntervalMs: number;
  private readonly fetchImplementation: FetchImplementation | undefined;
  private readonly webSocketFactory: ((url: string) => WebSocketLike) | undefined;
  private readonly hooks: HookManager;
  private readonly wallet: WalletAdapter;
  private readonly queue: RequestQueue;
  private readonly timeoutMs: number;
  private readonly retryOptions: RpcRetryOptions;
  private readonly readCache: ReadCache | undefined;
  private readonly specOverride: ContractSpecLike | Promise<ContractSpecLike> | undefined;
  private readonly eventSubscription?: WillEventSubscription;
  private specPromise: Promise<ContractSpecLike> | undefined;

  constructor(options: SoroWillClientOptions) {
    const config = NETWORK_CONFIG[options.network];
    const rpcUrl = options.rpcUrl ?? config.rpcUrls[0]!;

    this.server =
      options.rpcServer ??
      new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith('http://') });
    this.contract = new Contract(options.contractId);
    this.networkPassphrase = options.networkPassphrase ?? config.networkPassphrase;
    this.hooks = options.hooks ?? new HookManager();
    this.wallet = options.wallet ?? getDefaultWalletAdapter();
    this.retryOptions = { ...DEFAULT_RETRY_OPTIONS, ...options.retry };
    this.pollAttempts = options.pollAttempts ?? DEFAULT_POLL_ATTEMPTS;
    if (!Number.isInteger(this.pollAttempts) || this.pollAttempts <= 0) {
      throw new RangeError('pollAttempts must be a positive integer');
    }
    this.specOverride = options.spec;

    this.rpcPool = new RpcEndpointPool(options.rpcUrls ?? config.rpcUrls);
    this.eventRpcUrl = options.eventRpcUrl ?? rpcUrl;
    this.eventStreamUrl =
      options.eventStreamUrl ?? this.deriveDefaultEventStreamUrl(this.eventRpcUrl);
    this.defaultPollIntervalMs =
      normalizePositiveInteger(options.defaultPollIntervalMs, 'defaultPollIntervalMs') ?? 5_000;
    this.fetchImplementation = options.fetch;
    this.webSocketFactory = options.webSocketFactory;
    this.hooks = options.hooks ?? new HookManager();
    this.wallet = options.wallet ?? { getPublicKey, signTransaction };
    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new RangeError('timeoutMs must be greater than zero');
    }
    this.queue = new RequestQueue({
      maxConcurrent: options.maxConcurrentRequests ?? 4,
      requestsPerSecond: options.requestsPerSecond ?? 10,
    });
      ...(options.maxConcurrentRequests === undefined
        ? {}
        : { maxConcurrent: options.maxConcurrentRequests }),
      ...(options.requestsPerSecond === undefined
        ? {}
        : { requestsPerSecond: options.requestsPerSecond }),
    });
    this.retryOptions = { ...DEFAULT_RETRY_OPTIONS, ...options.retry };
    this.readCache = options.readCache === false ? undefined : new ReadCache(options.readCache ?? {});
    this.specOverride = options.spec;
    this.readCache = options.readCache === false ? undefined : new ReadCache(options.readCache);

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

    return new SoroWillClient({
      network,
      contractId,
      rpcUrl: env.SOROWILL_RPC_URL,
      networkPassphrase: env.SOROWILL_NETWORK_PASSPHRASE,
      eventRpcUrl: env.SOROWILL_EVENT_RPC_URL,
      eventStreamUrl: env.SOROWILL_EVENT_STREAM_URL,
      defaultPollIntervalMs: pollInterval,
    });
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
    const owner = await this.wallet.getPublicKey();
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
    const spec = await this.getSpec();
    const willId = (spec.funcResToNative('create_will', returnValue) as bigint).toString();
    return { willId, txHash };
  }

  /** Resets the check-in countdown for `willId`. */
  async checkIn(willId: string, options?: RequestOptions): Promise<{ txHash: string; nextDeadline: Date }> {
    const owner = await this.wallet.getPublicKey();
    const will = await this.getWill(willId, options);
    const { txHash, createdAt } = await this.invoke('check_in', { will_id: BigInt(willId), owner }, options);
    return { txHash, nextDeadline: new Date((createdAt + will.checkinPeriodDays * 86_400) * 1000) };
  async checkIn(
    willId: string,
    options?: RequestOptions,
  ): Promise<{ txHash: string; nextDeadline: Date }> {
    const owner = await getPublicKey();
    // checkin_period_days is a stored will property not returned by the
    // contract's check_in function, so a separate getWill() read is
    // unavoidable in order to compute the nextDeadline return value.
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

  /** Cancels an in-progress trigger during the grace period, resetting the countdown. */
  async emergencyCheckIn(
    willId: string,
    options?: RequestOptions,
  ): Promise<{ txHash: string; nextDeadline: Date }> {
    const owner = await this.wallet.getPublicKey();
    const owner = await getPublicKey();
    // checkin_period_days is a stored will property not returned by the
    // contract's emergency_checkin function, so a separate getWill() read is
    // unavoidable in order to compute the nextDeadline return value.
    const will = await this.getWill(willId, options);
    const { txHash, createdAt } = await this.invoke(
      'emergency_checkin',
      { will_id: BigInt(willId), owner },
      options,
    );
    return { txHash, nextDeadline: new Date((createdAt + will.checkinPeriodDays * 86_400) * 1000) };
  }

  /** Distributes the will's balance to all beneficiaries once the grace period has elapsed. */
  async releaseInheritance(willId: string, options?: RequestOptions): Promise<{ txHash: string }> {
    const { txHash } = await this.invoke('release_inheritance', { will_id: BigInt(willId) }, options);
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

  /** Cancels the will and withdraws the full balance back to the owner. */
  async cancelWill(willId: string, options?: RequestOptions): Promise<{ txHash: string; refundAmount: string }> {
    const owner = await this.wallet.getPublicKey();
    const will = await this.getWill(willId, options);
    const { txHash } = await this.invoke('cancel_will', { will_id: BigInt(willId), owner }, options);
  async cancelWill(
    willId: string,
    options?: RequestOptions,
  ): Promise<{ txHash: string; refundAmount: string }> {
    const owner = await getPublicKey();
    const { txHash, returnValue } = await this.invoke('cancel_will', {
      will_id: BigInt(willId),
      owner,
    }, options);
    // cancel_will returns the refunded balance on success. Decode it from the
    // transaction return value to avoid an extra getWill() round-trip.
    if (returnValue) {
      const spec = await this.getSpec(options);
      const refundAmount = spec.funcResToNative('cancel_will', returnValue) as bigint;
      return { txHash, refundAmount: refundAmount.toString() };
    }
    // Fallback for older contract versions that don't return the balance.
    const will = await this.getWill(willId, options);
    return { txHash, refundAmount: will.balance };
  }

  /** Replaces the beneficiary list for a will before it has been triggered. */
  async updateBeneficiaries(
    params: UpdateBeneficiariesParams,
    options?: RequestOptions,
  ): Promise<{ txHash: string }> {
    const owner = await this.wallet.getPublicKey();
    const owner = await getPublicKey();
    const { txHash } = await this.invoke(
      'update_beneficiaries',
      { will_id: BigInt(params.willId), owner, beneficiaries: params.beneficiaries },
      options,
    );
    return { txHash };
  }

  /** Adds more of the will's token to its locked balance. */
  async topUp(willId: string, amount: string, options?: RequestOptions): Promise<{ txHash: string }> {
    const owner = await this.wallet.getPublicKey();
    const { txHash } = await this.invoke(
      'top_up',
      { will_id: BigInt(willId), owner, amount: BigInt(amount) },
      options,
    );
  async topUp(
    willId: string,
    amount: string,
    options?: RequestOptions,
  ): Promise<{ txHash: string }> {
    const owner = await getPublicKey();
    const { txHash } = await this.invoke('top_up', {
      will_id: BigInt(willId),
      owner,
      amount: BigInt(amount),
    }, options);
    return { txHash };
  }

  /** Reads the full state of a will. Does not require a connected wallet. */
  async getWill(willId: string, options?: RequestOptions): Promise<Will> {
    const raw = await this.readCached(
      `get_will:${willId}`,
      () => this.read<RawWill>('get_will', { will_id: BigInt(willId) }, options),
    );
    const raw = await this.read<RawWill>('get_will', { will_id: BigInt(willId) }, options);
    return mapWill(raw);
  }

  /** Lists every will owned by `owner`. Does not require a connected wallet. */
  async getWillsByOwner(owner: string, options?: RequestOptions): Promise<Will[]>;
  async getWillsByOwner(
    owner: string,
    pagination: PaginationOptions,
    options?: RequestOptions,
  ): Promise<PaginatedWillsResult>;
  async getWillsByOwner(
    owner: string,
    paginationOrOptions?: PaginationOptions | RequestOptions,
    maybeOptions?: RequestOptions,
  ): Promise<Will[] | PaginatedWillsResult> {
    const pagination = isPaginationRequested(paginationOrOptions as PaginationOptions | undefined)
      ? (paginationOrOptions as PaginationOptions)
      : undefined;
    const options = pagination ? maybeOptions : (paginationOrOptions as RequestOptions | undefined);
    const raw = await this.read<RawWill[]>('get_wills_by_owner', { owner }, options);
    return paginateWills(raw.map(mapWill), pagination);
  async getWillsByOwner(owner: string, options?: RequestOptions): Promise<Will[]> {
    const raw = await this.readCached(
      `get_wills_by_owner:${owner}`,
      () => this.read<RawWill[]>('get_wills_by_owner', { owner }, options),
    );
    const raw = await this.read<RawWill[]>('get_wills_by_owner', { owner }, options);
    return raw.map(mapWill);
  }

  /** Lists every will `beneficiary` is named in. Does not require a connected wallet. */
  async getWillsByBeneficiary(beneficiary: string, options?: RequestOptions): Promise<Will[]>;
  async getWillsByBeneficiary(
    beneficiary: string,
    pagination: PaginationOptions,
    options?: RequestOptions,
  ): Promise<PaginatedWillsResult>;
  async getWillsByBeneficiary(
    beneficiary: string,
    paginationOrOptions?: PaginationOptions | RequestOptions,
    maybeOptions?: RequestOptions,
  ): Promise<Will[] | PaginatedWillsResult> {
    const pagination = isPaginationRequested(paginationOrOptions as PaginationOptions | undefined)
      ? (paginationOrOptions as PaginationOptions)
      : undefined;
    const options = pagination ? maybeOptions : (paginationOrOptions as RequestOptions | undefined);
    const raw = await this.read<RawWill[]>('get_wills_by_beneficiary', { beneficiary }, options);
    return paginateWills(raw.map(mapWill), pagination);
  ): Promise<Will[]> {
    const raw = await this.readCached(
      `get_wills_by_beneficiary:${beneficiary}`,
      () => this.read<RawWill[]>('get_wills_by_beneficiary', { beneficiary }, options),
    const raw = await this.read<RawWill[]>(
      'get_wills_by_beneficiary',
      { beneficiary },
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
  async guardianTrigger(willId: string, options?: RequestOptions): Promise<{ txHash: string }> {
    const guardian = await this.wallet.getPublicKey();
    const { txHash } = await this.invoke('guardian_trigger', { will_id: BigInt(willId), guardian }, options);
    return { txHash };
  }

  /**
   * Simulates a state-changing contract call and returns the estimated Soroban
   * resource fee without signing or submitting the transaction.
   */
  async previewFee(
    method: string,
    params: Record<string, unknown>,
    options?: RequestOptions,
  ): Promise<{ resourceFee: string }> {
    const sourceAccount = await this.wallet.getPublicKey();
    const simulation = await this.simulate(method, params, sourceAccount, options);
    return { resourceFee: this.extractResourceFee(simulation) };
  }

  /**
   * Passes through the Soroban RPC endpoint's network-wide classic-fee and
   * surge-pricing statistics (distinct from a specific transaction's
   * simulated resource fee). Useful for showing a "network is busy, fees may
   * be higher than usual" hint before the user submits. Does not require a
   * connected wallet.
   */
  async getNetworkFeeStats(options?: RequestOptions): Promise<rpc.Api.GetFeeStatsResponse> {
    return this.rpc(() => this.server.getFeeStats(), options);
  }

  async guardianTrigger(willId: string): Promise<{ txHash: string }> {
    const guardian = await this.wallet.getPublicKey();
  async guardianTrigger(
    willId: string,
    options?: RequestOptions,
  ): Promise<{ txHash: string; votesSoFar: number; released: boolean }> {
  async guardianTrigger(willId: string, options?: RequestOptions): Promise<{ txHash: string }> {
    const guardian = await getPublicKey();
    const { txHash, returnValue, events } = await this.invoke('guardian_trigger', {
      will_id: BigInt(willId),
      guardian,
    }, options);

  /**
   * Invalidates and re-fetches the cached contract spec. Call this after a
   * contract redeploy to ensure subsequent calls encode/decode against the
   * updated WASM interface.
   *
   * Returns the freshly-loaded spec so callers can await completion before
   * making further calls.
   */
  async refreshSpec(options?: RequestOptions): Promise<ContractSpecLike> {
    this.specPromise = undefined;
    return this.getSpec(options);
  }

  /** Unsubscribes from any configured event source. */
  destroy(): void {
    if (this.eventSubscription) {
      unsubscribeFromWillEvents(this.eventSubscription);
    let votesSoFar = 0;
    let released = false;

    // Decode contract events emitted during this transaction.
    if (events && events.length > 0) {
      for (const event of events) {
        const topics = event.topics ?? [];
        if (topics.includes('gvote')) {
          votesSoFar = (event.data as { votes?: number })?.votes ?? 1;
        }
        if (topics.includes('released')) {
          released = true;
        }
      }
    }

  /** Lazily fetches and caches the contract's spec from its deployed wasm. */
  private async getSpec(): Promise<ContractSpecLike> {
    if (!this.specPromise) {
      if (this.specJsonOverride !== undefined) {
        // Spec constructor natively accepts Buffer, string (base64 XDR),
        // xdr.ScSpecEntry[], or string[] — all match specJson's union type.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.specPromise = Promise.resolve(new Spec(this.specJsonOverride as Buffer));
      } else if (this.specOverride) {
        this.specPromise = Promise.resolve(this.specOverride);
      } else {
        this.specPromise = this.server
          .getContractWasmByContractId(this.contract.contractId())
          .then((wasm) => Spec.fromWasm(Buffer.from(wasm)));
    // Fallback: try decoding the return value if events weren't available.
    if (!released && !votesSoFar && returnValue) {
      try {
        const spec = await this.getSpec(options);
        const result = spec.funcResToNative('guardian_trigger', returnValue) as {
          votes?: number;
          released?: boolean;
        } | bigint;
        if (typeof result === 'object' && result !== null) {
          votesSoFar = result.votes ?? 0;
          released = result.released ?? false;
        }
      } catch {
        // Return value isn't decodable as a tuple; events are the primary source.
      }
    }

    return { txHash, votesSoFar, released };
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
    const spec = await this.getSpec();
    const contractOperations = operations.map(({ method, args }) =>
      this.contract.call(method, ...spec.funcArgsToScVals(method, args)),
    );
    const result = await this.submitOperations(contractOperations, 'batch', options);

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

  /**
   * Subscribes to SoroWill contract events using either WebSocket streaming
   * or polling. In `auto` mode, WebSocket is attempted first and polling is
   * used as a fallback if the endpoint does not support streaming.
   * Builds a SEP-7 deep-link URI for a state-changing contract call, so a
   * mobile wallet can sign it outside the browser extension flow.
   *
   * @returns The `web+stellar:tx?...` URI string.
   * @throws {Error} If the RPC call to build the transaction fails.
   */
  async subscribeToEvents(
    onEvent: (event: SoroWillEvent) => void | Promise<void>,
    options: EventSubscriptionOptions = {},
  ): Promise<EventSubscription> {
    const transport = options.transport ?? 'auto';
    if (transport === 'polling') {
      return this.createPollingSubscription(onEvent, options);
    }

    try {
      return await this.createWebSocketSubscription(onEvent, options);
    } catch (error) {
      if (transport === 'websocket') {
        throw error;
      }
      options.onError?.(new Error(`WebSocket event streaming unavailable; falling back to polling: ${asError(error).message}`));
      return this.createPollingSubscription(onEvent, options);
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Lazily fetches and caches the contract's spec from its deployed WASM.
   * On rejection the cached promise is cleared so the next call triggers a
   * fresh attempt instead of replaying a stale error.
   */
  private async getSpec(_options?: RequestOptions): Promise<ContractSpecLike> {
    if (!this.specPromise) {
      if (this.specOverride) {
        this.specPromise = Promise.resolve(this.specOverride);
      } else {
        const fetchPromise = this.server.getContractWasmByContractId(
          this.contract.contractId(),
        );

        this.specPromise = fetchPromise.then((wasm) => Spec.fromWasm(Buffer.from(wasm)));

        // Clear the cached promise on failure so subsequent calls retry
        // instead of replaying the stale rejection forever.
        this.specPromise.catch(() => {
          this.specPromise = undefined;
        });
      }
  /** Unsubscribes from any configured event source. */
  destroy(): void {
    if (this.eventSubscription) {
      unsubscribeFromWillEvents(this.eventSubscription);
    }
  }

  /**
   * Compares a wallet connection's reported network against this client's
   * configured network, throwing {@link WalletNetworkMismatchError} on
   * mismatch. Call this with the result of `connectWallet()` (or an
   * adapter's `connect()`/`reconnect()`) right after connecting, before the
   * user can trigger a transaction — e.g. Freighter set to mainnet while the
   * app instantiated a testnet client.
   *
   * State-changing methods also run this check automatically (when the
   * configured wallet adapter can report its network) before a transaction
   * is ever built and sent for signing.
   */
  assertWalletNetwork(connection: Pick<WalletConnection, 'networkPassphrase'>): void {
    if (connection.networkPassphrase !== this.networkPassphrase) {
      throw new WalletNetworkMismatchError(this.networkPassphrase, connection.networkPassphrase);
    }
  }

  /** Lazily fetches and caches the contract's spec from its deployed wasm. */
  private async getSpec(): Promise<ContractSpecLike> {
    if (!this.specPromise) {
      this.specPromise =
        this.specOverride !== undefined
          ? Promise.resolve(this.specOverride)
          : this.rpc(() => this.server.getContractWasmByContractId(this.contract.contractId())).then(
              (wasm) => Spec.fromWasm(Buffer.from(wasm)) as unknown as ContractSpecLike,
            );
    }
    return this.specPromise;
  /** Lazily fetches and caches the contract's spec from its deployed wasm. */
  private async getSpec(
    options?: RequestOptions,
  ): Promise<InstanceType<typeof Spec>> {
    if (!this.specPromise) {
      if (this.specOverride) {
        this.specPromise = Promise.resolve(this.specOverride) as Promise<InstanceType<typeof Spec>>;
      } else {
        this.specPromise = this.rpc(
          () => this.server.getContractWasmByContractId(this.contract.contractId()),
          options,
        ).then((wasm) => Spec.fromWasm(Buffer.from(wasm)));
      }
    }
    return await this.specPromise;
  }

  /** Simulates a read-only contract call, requiring no connected wallet or signature. */
  private async read<T>(method: string, args: Record<string, unknown>, options?: RequestOptions): Promise<T> {
    try {
      const cacheKey = createReadCacheKey(method, args);
      const cached = await this.readCache?.get<T>(cacheKey);
      if (cached !== undefined) {
        return cached;
      }

      const spec = await this.getSpec();
      const simulation = await this.simulate(method, args, NULL_ACCOUNT, options);
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
      if (rpc.Api.isSimulationRestore(simulation)) {
        throw new SoroWillRestoreRequiredError(
          `SoroWill simulation for ${method} requires ledger-entry restoration`,
          simulation,
        );
      }
      if (!simulation.result) {
        throw new SoroWillError(`SoroWill simulation for ${method} returned no result`);
      }

      const result = spec.funcResToNative(method, simulation.result.retval) as T;
      await this.readCache?.set(cacheKey, result, getWillIdsFromReadResult(method, args, result));
      return result;
    } catch (error) {
      throw mapContractError(error);
    }
  }

  private async simulate(
    method: string,
    args: Record<string, unknown>,
    sourceAccount: string,
    options?: RequestOptions,
  ): Promise<SimulatedCallResult> {
    const spec = await this.getSpec();
    const scArgs = spec.funcArgsToScVals(method, args);
    const operation = this.contract.call(method, ...scArgs);
    const account =
      sourceAccount === NULL_ACCOUNT
        ? new Account(NULL_ACCOUNT, '0')
        : await this.rpc(() => this.server.getAccount(sourceAccount), options);

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(30)
      .build();

    const simulation = await this.rpc(() => this.server.simulateTransaction(tx), options);
    if (rpc.Api.isSimulationError(simulation)) {
      throw new SoroWillError(`SoroWill simulation failed for ${method}: ${simulation.error}`);
    }

    return simulation as SimulatedCallResult;
    }
  }

  /** Builds, simulates, signs, and submits a state-changing contract call. */
  private async invoke(
    method: string,
    args: Record<string, unknown>,
    options?: RequestOptions,
  ): Promise<{ txHash: string; createdAt: number; returnValue: ScVal | undefined }> {
    const beforeCtx: BeforeInvokeContext = { method, args, timestamp: new Date().toISOString() };
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
    let errorMessage: string | null = null;

    try {
      const spec = await this.getSpec();
      const operation = this.contract.call(method, ...spec.funcArgsToScVals(method, args));
      const result = await this.submitOperations([operation], method, options);
      txHash = result.txHash;
      return result;
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
      throw mapContractError(error);
    } finally {
      const builtTx = await this.buildInvocationTransaction(method, args);
      const prepared = await this.prepareInvocation(method, args, builtTx);

      assertPreparedTransactionMatchesIntendedOperation({
        intendedTransactionXdr: builtTx.toXDR(),
        preparedTransactionXdr: prepared.toXDR(),
        networkPassphrase: this.networkPassphrase,
        context: method,
      });

      const signedTxXdr = await signTransaction(prepared.toXDR(), {
        networkPassphrase: this.networkPassphrase,
      });
      const signedTx = TransactionBuilder.fromXDR(signedTxXdr, this.networkPassphrase) as Transaction;

      const sendResponse = await this.rpc(() => this.server.sendTransaction(signedTx), options);
      if (sendResponse.status === 'ERROR') {
        const errorXdr = sendResponse.errorResult?.toXDR('base64') ?? 'no error result';
        throw new SoroWillError(
          `SoroWill transaction submission failed for ${method}: ${errorXdr}`,
        );
      }

      const txResponse = await this.rpc(
        () => this.server.pollTransaction(sendResponse.hash, { attempts: 30 }),
        options,
      );
      if (txResponse.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
        throw new SoroWillError(
          `SoroWill transaction for ${method} did not succeed: ${txResponse.status}`,
        );
      }
      const spec = await this.getSpec(options);
      const operation = this.contract.call(method, ...spec.funcArgsToScVals(method, args));
      const result = await this.submit([operation], method, options);

      txHash = result.txHash;

      // Invalidate affected read-cache entries
      if (method === 'create_will') {
        await this.readCache?.clear();
      } else {
        const affectedWillIds = getMutationWillIds(method, args);
        await Promise.all(affectedWillIds.map((willId) => this.readCache?.invalidateByWillId(willId)));
      }

      const afterCtx: AfterInvokeContext = {
        method,
        args,
        timestamp: new Date().toISOString(),
        txHash,
        error: errorMessage,
        durationMs: Date.now() - startTime,
      };
      await this.hooks.runAfterInvoke(afterCtx);
      await this.invalidateCacheForMutation(method, args);
    }
  }

  private async invalidateCacheForMutation(method: string, args: Record<string, unknown>): Promise<void> {
    if (!this.readCache) {
      return;
    }
    if (method === 'create_will') {
      await this.readCache.clear();
      return;
    }
    const willIds = getMutationWillIds(args);
    await Promise.all(willIds.map((willId) => this.readCache?.invalidateByWillId(willId)));
  }

  /**
   * Best-effort automatic version of {@link assertWalletNetwork}: skips
   * silently if the configured wallet adapter can't report its network
   * (e.g. a minimal custom adapter), since not every adapter can determine
   * this without prompting the user.
   */
  private async assertWalletNetworkMatches(): Promise<void> {
    const getNetwork = this.wallet.getNetwork;
    if (!getNetwork) {
      return;
    }
    const { networkPassphrase } = await getNetwork.call(this.wallet);
    this.assertWalletNetwork({ networkPassphrase });
  }

  /** Signs and submits one or more contract-call operations as a single transaction. */
  private async submitOperations(
    operations: readonly xdr.Operation[],
    label: string,
    options?: RequestOptions,
  ): Promise<{ txHash: string; createdAt: number; returnValue: ScVal | undefined }> {
    await this.assertWalletNetworkMatches();
    const publicKey = await this.wallet.getPublicKey();
    const account = await this.rpc(() => this.server.getAccount(publicKey), options);
    const builder = new TransactionBuilder(account, {
      fee: (BigInt(BASE_FEE) * BigInt(operations.length)).toString(),
      networkPassphrase: this.networkPassphrase,
    });
    for (const operation of operations) builder.addOperation(operation);
    const builtTx = builder.setTimeout(30).build();

    const prepared = await this.rpc(() => this.server.prepareTransaction(builtTx), options);

    assertPreparedTransactionMatchesIntendedOperation({
      intendedTransactionXdr: builtTx.toXDR(),
      preparedTransactionXdr: prepared.toXDR(),
      networkPassphrase: this.networkPassphrase,
      context: label,
    });

    const signedTxXdr = await this.wallet.signTransaction(prepared.toXDR(), {
      networkPassphrase: this.networkPassphrase,
    });
    const signedTx = TransactionBuilder.fromXDR(signedTxXdr, this.networkPassphrase) as Transaction;

    const sendResponse = await this.rpc(() => this.server.sendTransaction(signedTx), options);
    if (sendResponse.status === 'ERROR') {
      throw new SoroWillError(`SoroWill transaction submission failed for ${label}`);
    }

    const txResponse = await this.rpc(
      () => this.server.pollTransaction(sendResponse.hash, { attempts: 30 }),
      options,
    );
    if (txResponse.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
      throw new SoroWillError(`SoroWill transaction for ${label} did not succeed: ${txResponse.status}`);
      return result;
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

  /** Builds, signs, submits, and polls a set of operations as one transaction. */
  private async submit(
    operations: readonly xdr.Operation[],
    label: string,
    options?: RequestOptions,
  ): Promise<{
    txHash: string;
    createdAt: number;
    returnValue: ScVal | undefined;
    events?: Array<{ topics: string[]; data: unknown }>;
  }> {
    options?.signal?.throwIfAborted();

    try {
      const publicKey = await getPublicKey();
      options?.signal?.throwIfAborted();
      const account = await this.rpc(() => this.server.getAccount(publicKey), options);
      const builder = new TransactionBuilder(account, {
        fee: (BigInt(BASE_FEE) * BigInt(operations.length)).toString(),
        networkPassphrase: this.networkPassphrase,
      });
      for (const operation of operations) builder.addOperation(operation);
      const builtTx = builder.setTimeout(30).build();

      // prepareTransaction simulates and assembles Soroban data for the whole transaction.
      options?.signal?.throwIfAborted();
      const prepared = await this.rpc(() => this.server.prepareTransaction(builtTx), options);
      const signedTxXdr = await signTransaction(prepared.toXDR(), {
        networkPassphrase: this.networkPassphrase,
      });
      const signedTx = TransactionBuilder.fromXDR(
        signedTxXdr,
        this.networkPassphrase,
      ) as Transaction;

      options?.signal?.throwIfAborted();
      const sendResponse = await this.rpc(() => this.server.sendTransaction(signedTx), options);

      // Handle distinct sendTransaction statuses per the Soroban RPC spec.
      if (sendResponse.status === 'ERROR') {
        const errorXdr = sendResponse.errorResult?.toXDR?.('base64') ?? 'no error result';
        throw new SoroWillError(
          `SoroWill transaction submission failed for ${label}: ${errorXdr}`,
        );
      }

      options?.signal?.throwIfAborted();
      if (sendResponse.status === 'TRY_AGAIN_LATER') {
        throw new SoroWillError(
          `SoroWill RPC node is under backpressure — transaction for ${label} could not be submitted. Retry later.`,
        );
      }

      if (sendResponse.status === 'DUPLICATE') {
        // The transaction was already submitted (or still in the mempool).
        // We can still poll for its final status using the returned hash.
        // Fall through to polling below.
      }

      // PENDING and DUPLICATE both proceed to polling.
      const txResponse = await this.rpc(
        () => this.server.pollTransaction(sendResponse.hash, { attempts: this.pollAttempts }),
        options,
      );
      if (txResponse.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
        throw new SoroWillError(
          `SoroWill transaction for ${label} did not succeed: ${txResponse.status}`,
        );
      }

      // Extract events from the transaction result meta, if available.
      let events: Array<{ topics: string[]; data: unknown }> | undefined;
      const txResponseAny = txResponse as unknown as Record<string, unknown>;
      if (Array.isArray(txResponseAny.events)) {
        events = txResponseAny.events as Array<{ topics: string[]; data: unknown }>;
      }

      return {
        txHash: sendResponse.hash,
        createdAt: txResponse.createdAt,
        returnValue: txResponse.returnValue,
        events,
      };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw error;
      }
      throw mapContractError(error);
    }

    return {
      txHash: sendResponse.hash,
      createdAt: txResponse.createdAt,
      returnValue: txResponse.returnValue,
    };
  }

  private async createPollingSubscription(
    onEvent: (event: SoroWillEvent) => void | Promise<void>,
    options: EventSubscriptionOptions,
  ): Promise<EventSubscription> {
    const interval = normalizePositiveInteger(options.pollIntervalMs, 'pollIntervalMs') ?? this.defaultPollIntervalMs;
    const pageSize = normalizePositiveInteger(options.pageSize, 'pageSize') ?? 100;
    let cursor = options.cursor ?? null;
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async (): Promise<void> => {
      if (closed) {
        return;
      }

      try {
        const page = await this.fetchEventsPage(cursor, pageSize);
        for (const event of page.events) {
          await onEvent(event);
          cursor = event.cursor;
        }
        if (page.nextCursor) {
          cursor = page.nextCursor;
        }
      } catch (error) {
        options.onError?.(asError(error));
      } finally {
        if (!closed) {
          timer = setTimeout(() => {
            void poll();
          }, interval);
        }
      }
    };

    void poll();

    return {
      transport: 'polling',
      get closed() {
        return closed;
      },
      close() {
        closed = true;
        if (timer !== undefined) {
          clearTimeout(timer);
        }
      },
    };
  }

  private async createWebSocketSubscription(
    onEvent: (event: SoroWillEvent) => void | Promise<void>,
    options: EventSubscriptionOptions,
  ): Promise<EventSubscription> {
    const pageSize = normalizePositiveInteger(options.pageSize, 'pageSize') ?? 100;
    const socket = await this.openWebSocket(this.eventStreamUrl);
    let closed = false;

    socket.onmessage = (message) => {
      void this.handleStreamMessage(message.data, onEvent, options);
    };
    socket.onerror = () => {
      options.onError?.(new Error('SoroWill event stream connection error'));
    };
    socket.onclose = () => {
      closed = true;
    };
    socket.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'subscribeToEvents',
        params: this.buildEventRequestParams(options.cursor ?? null, pageSize),
      }),
    );

    return {
      transport: 'websocket',
      get closed() {
        return closed;
      },
      close() {
        closed = true;
        socket.close();
      },
    };
  }

  private async handleStreamMessage(
    data: string,
    onEvent: (event: SoroWillEvent) => void | Promise<void>,
    options: EventSubscriptionOptions,
  ): Promise<void> {
    try {
      const parsed = JSON.parse(data) as JsonRpcSuccess<RpcEventPage | RpcEventRecord[]> | JsonRpcFailure | RpcEventPage;
      if ('error' in parsed) {
        throw new Error(parsed.error.message ?? 'Unknown event stream error');
      }

      const page = this.normalizeEventPage('result' in parsed ? parsed.result : parsed);
      for (const event of page.events) {
        await onEvent(event);
      }
    } catch (error) {
      options.onError?.(asError(error));
    }
  }

  private async fetchEventsPage(cursor: string | null, pageSize: number): Promise<{
    events: SoroWillEvent[];
    nextCursor: string | null;
  }> {
    const fetchImplementation = this.fetchImplementation ?? globalThis.fetch;
    if (!fetchImplementation) {
      throw new Error('No fetch implementation is available for event polling');
    }

    const response = await fetchImplementation(this.eventRpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getEvents',
        params: this.buildEventRequestParams(cursor, pageSize),
      }),
    });

    const json = (await response.json()) as JsonRpcSuccess<RpcEventPage | RpcEventRecord[]> | JsonRpcFailure;
    if ('error' in json) {
      throw new Error(json.error.message ?? 'Unknown RPC error while fetching events');
    }

    return this.normalizeEventPage(json.result);
  }

  private normalizeEventPage(payload: RpcEventPage | RpcEventRecord[]): {
    events: SoroWillEvent[];
    nextCursor: string | null;
  } {
    const records = Array.isArray(payload) ? payload : (payload.events ?? []);
    const events = records.map((record) => mapEventRecord(record, this.contract.contractId()));
    const nextCursor =
      Array.isArray(payload)
        ? (events.length > 0 ? events[events.length - 1]?.cursor ?? null : null)
        : (payload.nextCursor ?? (events.length > 0 ? events[events.length - 1]?.cursor ?? null : null));

    return {
      events,
      nextCursor,
    };
  }

  private buildEventRequestParams(cursor: string | null, limit: number): Record<string, unknown> {
    return {
      filters: [
        {
          type: 'contract',
          contractIds: [this.contract.contractId()],
        },
      ],
      pagination: {
        cursor,
        limit,
      },
    };
  }

  private deriveDefaultEventStreamUrl(rpcUrl: string): string {
    const url = new URL(rpcUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = `${url.pathname.replace(/\/$/, '')}/events`;
    return url.toString();
  }

  private async openWebSocket(url: string): Promise<WebSocketLike> {
    const socket = this.webSocketFactory ? this.webSocketFactory(url) : this.createBrowserWebSocket(url);
    return new Promise<WebSocketLike>((resolve, reject) => {
      let settled = false;

      socket.onopen = () => {
        settled = true;
        resolve(socket);
      };
      socket.onerror = () => {
        if (!settled) {
          settled = true;
          reject(new Error(`Unable to open SoroWill event stream at ${url}`));
        }
      };
      socket.onclose = () => {
        if (!settled) {
          settled = true;
          reject(new Error(`SoroWill event stream closed before it was ready at ${url}`));
        }
      };
    });
  }

  private createBrowserWebSocket(url: string): WebSocketLike {
    if (typeof WebSocket === 'undefined') {
      throw new Error('No WebSocket implementation is available for event streaming');
    }
    return new WebSocket(url) as unknown as WebSocketLike;
  }

  private extractResourceFee(simulation: SimulatedCallResult): string {
    if (!simulation.minResourceFee) {
      throw new SoroWillError('Soroban simulation did not return a minResourceFee estimate');
    }
    return simulation.minResourceFee;
  }

  /** Sends a single RPC request through the shared queue (concurrency/rate/timeout) with retry. */
  private rpc<T>(request: () => Promise<T>, options?: RequestOptions): Promise<T> {
    return this.queue.enqueue(() => this.retryRpc(request), options?.timeoutMs ?? this.timeoutMs);
  }

  private async retryRpc<T>(operation: () => Promise<T>): Promise<T> {
    let delayMs = this.retryOptions.initialDelayMs;
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.retryOptions.maxAttempts; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (attempt === this.retryOptions.maxAttempts) {
          break;
        }

        await this.sleep(delayMs);
        delayMs = Math.min(
          this.retryOptions.maxDelayMs,
          Math.max(delayMs, 1) * this.retryOptions.backoffFactor,
        );
      }
    }

    throw new SoroWillError(
      `SoroWill RPC call failed after ${this.retryOptions.maxAttempts} attempts: ${String(lastError)}`,
    );
  }
  // -----------------------------------------------------------------------
  // Private: RPC wrapper through queue
  // -----------------------------------------------------------------------

  /** Sends every RPC through the shared FIFO queue with the selected timeout. */
  private rpc<T>(request: () => Promise<T>, options?: RequestOptions): Promise<T> {
    options?.signal?.throwIfAborted();
    return this.queue.enqueue(request, options?.timeoutMs ?? this.timeoutMs);
  }

  // -----------------------------------------------------------------------
  // Private: transaction building helpers
  // -----------------------------------------------------------------------

  private async sleep(durationMs: number): Promise<void> {
    if (durationMs <= 0) {
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, durationMs);
    });
  }

  private async buildInvocationTransaction(
    method: string,
    args: Record<string, unknown>,
    sourcePublicKey?: string,
  ): Promise<Transaction> {
    const spec = await this.getSpec();
    const scArgs = spec.funcArgsToScVals(method, args);
    const operation = this.contract.call(method, ...scArgs);

    const publicKey = sourcePublicKey ?? (await getPublicKey());
    const account = await this.server.getAccount(publicKey);
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
    return this.server.prepareTransaction(transaction);
  }

  /** Sends every RPC through the shared FIFO queue with the selected timeout. */
  private rpc<T>(request: () => Promise<T>, options?: RequestOptions): Promise<T> {
    return this.queue.enqueue(request, options?.timeoutMs ?? this.timeoutMs);
    return this.rpcPool.withFailover((server) => server.prepareTransaction(transaction));
  }

  private deriveDefaultEventStreamUrl(rpcUrl: string): string {
    const url = rpcUrl.replace(/^http/, 'ws');
    return url.endsWith('/') ? `${url}events` : `${url}/events`;
  }
}
