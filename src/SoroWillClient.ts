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

import {
  ReadCache,
  createReadCacheKey,
  type ReadCacheOptions,
} from './cache';
import {
  unsubscribeFromWillEvents,
  type WillEventSource,
  type WillEventSubscription,
} from './events';
import type { Beneficiary, CreateWillParams, UpdateBeneficiariesParams, Will } from './types';
import { WillStatus } from './types';
import { getDefaultWalletAdapter, type WalletAdapter } from './wallet';

type ScVal = xdr.ScVal;
type ScVal = xdr.ScVal;

import { freighterAdapter, type WalletAdapter } from './wallet';
import { getPublicKey, signTransaction } from './wallet';
import { mapContractError, SoroWillError } from './errors';
import { RequestQueue } from './requestQueue';
import type {
  BatchOperation,
  BatchResult,
  Beneficiary,
  CreateWillParams,
  RequestOptions,
  UpdateBeneficiariesParams,
  Will,
} from './types';
import { ReadCache, type ReadCacheOptions } from './cache';
import { RpcEndpointPool } from './rpc';
import { buildSep7TxUri, type BuildSep7TxUriOptions } from './sep7';
import type { Beneficiary, CreateWillParams, UpdateBeneficiariesParams, Will } from './types';
import { WillStatus } from './types';
import { HookManager } from './hooks';
import type { BeforeInvokeContext, AfterInvokeContext } from './hooks';
import { assertPreparedTransactionMatchesIntendedOperation } from './txValidation';
import { getPublicKey, signTransaction } from './wallet';

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

interface JsonRpcSuccess<T> {
  result: T;
}

interface JsonRpcFailure {
  error: {
    code?: number;
    message?: string;
  };
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

interface RpcEventPage {
  events?: RpcEventRecord[];
  nextCursor?: string | null;
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
   * Defaults to {@link freighterAdapter} (the Freighter browser extension) for
   * backwards compatibility. Supply any {@link WalletAdapter} — e.g.
   * `createAlbedoAdapter()` — to use a different Stellar wallet.
   */
  wallet?: WalletAdapter;
  /** Wallet adapter used for state-changing calls. Defaults to Freighter. */
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
  /** Overrides the network's public RPC endpoint. Primarily useful for private RPC providers. */
  rpcUrl?: string;
  /** Optional list of RPC endpoints to use with automatic failover. */
  rpcUrls?: string[];
  /** Optional in-memory cache for read methods. */
  readCache?: SoroWillReadCacheOptions;
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

function isPaginationRequested(options: PaginationOptions | undefined): options is PaginationOptions {
  return options !== undefined && (options.pageSize !== undefined || options.cursor !== undefined);
}

function paginateWills(wills: Will[], options: PaginationOptions | undefined): Will[] | PaginatedWillsResult {
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
    return process.env;
  }
  return {};
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * A client for interacting with a deployed SoroWill contract from
 * TypeScript. Read methods (`getWill`, `getWillsByOwner`,
 * `getWillsByBeneficiary`) work without a connected wallet. All other
 * methods sign and submit a transaction via the configured wallet adapter.
 */
export class SoroWillClient {
  private readonly server: SoroWillRpcServer;
  private readonly contract: Contract;
  private readonly networkPassphrase: string;
  private readonly hooks: HookManager;
  private readonly wallet: WalletAdapter;
  private specPromise: Promise<InstanceType<typeof Spec>> | undefined;
  private readonly retryOptions: RpcRetryOptions;
  private readonly readCache: ReadCache | undefined;
  private readonly specOverride: ContractSpecLike | Promise<ContractSpecLike> | undefined;
  private readonly specJsonOverride: Buffer | string | unknown[] | undefined;
  private specPromise: Promise<ContractSpecLike> | undefined;
  private readonly eventSubscription?: WillEventSubscription;

  constructor(options: SoroWillClientOptions) {
    const config = NETWORK_CONFIG[options.network];
    this.server =
      options.rpcServer ??
      new rpc.Server(config.rpcUrl, { allowHttp: config.rpcUrl.startsWith('http://') });
    this.contract = new Contract(options.contractId);
    this.networkPassphrase = config.networkPassphrase;
    this.hooks = options.hooks ?? new HookManager();
    this.wallet = options.wallet ?? freighterAdapter;
    this.wallet = options.wallet ?? getDefaultWalletAdapter();
    this.retryOptions = { ...DEFAULT_RETRY_OPTIONS, ...options.retry };
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
  private readonly rpcPool: RpcEndpointPool;
  private readonly contract: Contract;
  private readonly networkPassphrase: string;
  private readonly eventRpcUrl: string;
  private readonly eventStreamUrl: string;
  private readonly defaultPollIntervalMs: number;
  private readonly fetchImplementation?: FetchImplementation;
  private readonly webSocketFactory?: (url: string) => WebSocketLike;
  private readonly queue: RequestQueue;
  private readonly timeoutMs: number;
  private readonly readCache: ReadCache | undefined;
  private specPromise: Promise<InstanceType<typeof Spec>> | undefined;

  constructor(options: SoroWillClientOptions) {
    const config = NETWORK_CONFIG[options.network];
    const rpcUrl = options.rpcUrl ?? config.rpcUrl;
    this.server = new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith('http://') });
    this.contract = new Contract(options.contractId);
    this.networkPassphrase = options.networkPassphrase ?? config.networkPassphrase;
    this.eventRpcUrl = options.eventRpcUrl ?? rpcUrl;
    this.eventStreamUrl = options.eventStreamUrl ?? this.deriveDefaultEventStreamUrl(this.eventRpcUrl);
    this.defaultPollIntervalMs = normalizePositiveInteger(
      options.defaultPollIntervalMs,
      'defaultPollIntervalMs',
    ) ?? 5_000;
    this.fetchImplementation = options.fetch;
    this.webSocketFactory = options.webSocketFactory;
  }

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
    this.contract = new Contract(options.contractId);
    this.networkPassphrase = config.networkPassphrase;
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
    this.rpcPool = new RpcEndpointPool(options.rpcUrls ?? config.rpcUrls);
    this.contract = new Contract(options.contractId);
    this.networkPassphrase = config.networkPassphrase;
    this.readCache = options.readCache ? new ReadCache(options.readCache) : undefined;
  }

  /** Locks `params.amount` of `params.token` and creates a new will. */
  async createWill(
    params: CreateWillParams,
    options?: RequestOptions,
  ): Promise<{ willId: string; txHash: string }> {
    const owner = await getPublicKey();
    const { txHash, returnValue } = await this.invoke('create_will', {
      owner,
      token: params.token,
      amount: BigInt(params.amount),
      beneficiaries: params.beneficiaries,
      checkin_period_days: BigInt(params.checkinPeriodDays),
      grace_period_days: BigInt(params.gracePeriodDays),
      guardians: params.guardians,
    }, options);
    if (!returnValue) {
      throw new Error('create_will transaction succeeded but returned no will id');
    }
    const spec = await this.getSpec(options);
    const willId = (spec.funcResToNative('create_will', returnValue) as bigint).toString();
    return { willId, txHash };
  }

  /** Resets the check-in countdown for `willId`. */
  async checkIn(willId: string): Promise<{ txHash: string; nextDeadline: Date }> {
    const owner = await this.wallet.getPublicKey();
    const will = await this.getWill(willId);
  async checkIn(
    willId: string,
    options?: RequestOptions,
  ): Promise<{ txHash: string; nextDeadline: Date }> {
    const owner = await getPublicKey();
    const will = await this.getWill(willId, options);
    const { txHash, createdAt } = await this.invoke('check_in', {
      will_id: BigInt(willId),
      owner,
    }, options);
    return { txHash, nextDeadline: new Date((createdAt + will.checkinPeriodDays * 86_400) * 1000) };
  }

  /** Starts the grace period for `willId` once the check-in deadline has passed. */
  async triggerWill(willId: string, options?: RequestOptions): Promise<{ txHash: string }> {
    const { txHash } = await this.invoke('trigger_will', { will_id: BigInt(willId) }, options);
    return { txHash };
  }

  /** Cancels an in-progress trigger during the grace period, resetting the countdown. */
  async emergencyCheckIn(willId: string): Promise<{ txHash: string; nextDeadline: Date }> {
    const owner = await this.wallet.getPublicKey();
    const will = await this.getWill(willId);
  async emergencyCheckIn(
    willId: string,
    options?: RequestOptions,
  ): Promise<{ txHash: string; nextDeadline: Date }> {
    const owner = await getPublicKey();
    const will = await this.getWill(willId, options);
    const { txHash, createdAt } = await this.invoke('emergency_checkin', {
      will_id: BigInt(willId),
      owner,
    }, options);
    return { txHash, nextDeadline: new Date((createdAt + will.checkinPeriodDays * 86_400) * 1000) };
  }

  /** Distributes the will's balance to all beneficiaries once the grace period has elapsed. */
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
  async cancelWill(willId: string): Promise<{ txHash: string; refundAmount: string }> {
    const owner = await this.wallet.getPublicKey();
    const will = await this.getWill(willId);
  async cancelWill(
    willId: string,
    options?: RequestOptions,
  ): Promise<{ txHash: string; refundAmount: string }> {
    const owner = await getPublicKey();
    const will = await this.getWill(willId, options);
    const { txHash } = await this.invoke('cancel_will', {
      will_id: BigInt(willId),
      owner,
    }, options);
    return { txHash, refundAmount: will.balance };
  }

  /** Replaces the beneficiary list for a will before it has been triggered. */
  async updateBeneficiaries(params: UpdateBeneficiariesParams): Promise<{ txHash: string }> {
    const owner = await this.wallet.getPublicKey();
  async updateBeneficiaries(
    params: UpdateBeneficiariesParams,
    options?: RequestOptions,
  ): Promise<{ txHash: string }> {
    const owner = await getPublicKey();
    const { txHash } = await this.invoke('update_beneficiaries', {
      will_id: BigInt(params.willId),
      owner,
      beneficiaries: params.beneficiaries,
    }, options);
    return { txHash };
  }

  /** Adds more of the will's token to its locked balance. */
  async topUp(willId: string, amount: string): Promise<{ txHash: string }> {
    const owner = await this.wallet.getPublicKey();
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
    const raw = await this.read<RawWill>('get_will', { will_id: BigInt(willId) }, options);
  async getWill(willId: string): Promise<Will> {
    const raw = await this.readCached(`get_will:${willId}`, () =>
      this.read<RawWill>('get_will', { will_id: BigInt(willId) }),
    );
    return mapWill(raw);
  }

  /** Lists every will owned by `owner`. Does not require a connected wallet. */
  async getWillsByOwner(owner: string, options?: RequestOptions): Promise<Will[]> {
    const raw = await this.read<RawWill[]>('get_wills_by_owner', { owner }, options);
  async getWillsByOwner(owner: string): Promise<Will[]> {
    const raw = await this.readCached(`get_wills_by_owner:${owner}`, () =>
      this.read<RawWill[]>('get_wills_by_owner', { owner }),
    );
    return raw.map(mapWill);
  }

  /** Lists every will `beneficiary` is named in. Does not require a connected wallet. */
  async getWillsByBeneficiary(
    beneficiary: string,
    options?: RequestOptions,
  ): Promise<Will[]> {
    const raw = await this.read<RawWill[]>(
      'get_wills_by_beneficiary',
      { beneficiary },
      options,
  async getWillsByBeneficiary(beneficiary: string): Promise<Will[]> {
    const raw = await this.readCached(`get_wills_by_beneficiary:${beneficiary}`, () =>
      this.read<RawWill[]>('get_wills_by_beneficiary', { beneficiary }),
    );
    return raw.map(mapWill);
  }

  /**
   * Casts a guardian vote to force an early release of `willId`. Once 2 of
   * the will's guardians have voted, the balance is released automatically.
   */
  async guardianTrigger(willId: string): Promise<{ txHash: string }> {
    const guardian = await this.wallet.getPublicKey();
  async guardianTrigger(willId: string, options?: RequestOptions): Promise<{ txHash: string }> {
    const guardian = await getPublicKey();
    const { txHash } = await this.invoke('guardian_trigger', {
      will_id: BigInt(willId),
      guardian,
    }, options);
    return { txHash };
  }

  /** Unsubscribes from any configured event source. */
  destroy(): void {
    if (this.eventSubscription) {
      unsubscribeFromWillEvents(this.eventSubscription);
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
      }
  /**
   * Combines contract calls into one atomic transaction and one wallet signature prompt.
   * Arguments use the native names and values accepted by the deployed contract spec.
   */
  async batch(operations: readonly BatchOperation[], options?: RequestOptions): Promise<BatchResult> {
    if (operations.length === 0) {
      throw new RangeError('A batch must contain at least one operation');
    }
    const spec = await this.getSpec(options);
    const contractOperations = operations.map(({ method, args }) =>
      this.contract.call(method, ...spec.funcArgsToScVals(method, args)),
    );
    const result = await this.submit(contractOperations, 'batch', options);
    return { txHash: result.txHash, createdAt: result.createdAt };
   * Builds a SEP-7 deep-link URI for a state-changing contract call, so a
   * mobile wallet can sign it outside the browser extension flow.
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

  /** Lazily fetches and caches the contract's spec from its deployed wasm. */
  private async getSpec(options?: RequestOptions): Promise<InstanceType<typeof Spec>> {
    if (!this.specPromise) {
      this.specPromise = this.rpc(
        () => this.server.getContractWasmByContractId(this.contract.contractId()),
        options,
      )
      this.specPromise = this.rpcPool
        .withFailover((server) => server.getContractWasmByContractId(this.contract.contractId()))
        .then((wasm) => Spec.fromWasm(wasm));
    }
    return await this.specPromise;
  }

  private async readCached<T>(cacheKey: string, load: () => Promise<T>): Promise<T> {
    const cached = this.readCache?.get<T>(cacheKey);
    if (cached !== undefined) {
      return cached;
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

      const simulation = await this.rpc(() => this.server.simulateTransaction(tx), options);
      if (rpc.Api.isSimulationError(simulation)) {
        throw new SoroWillError(`SoroWill simulation failed for ${method}: ${simulation.error}`);
      }
      if (!simulation.result) {
        throw new SoroWillError(`SoroWill simulation for ${method} returned no result`);
      }

      return spec.funcResToNative(method, simulation.result.retval) as T;
    } catch (error) {
      throw mapContractError(error);
  private async read<T>(method: string, args: Record<string, unknown>): Promise<T> {
    const cacheKey = createReadCacheKey(method, args);
    const cached = await this.readCache?.get<T>(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    const spec = await this.getSpec();
    const simulation = await this.simulate(method, args, NULL_ACCOUNT);
    if (!simulation.result) {
      throw new Error(`SoroWill simulation for ${method} returned no result`);
    }
    return spec.funcResToNative(method, simulation.result.retval) as T;
  }

  private async simulate(
    method: string,
    args: Record<string, unknown>,
    sourceAccount: string,
  ): Promise<SimulatedCallResult> {
    const spec = await this.getSpec();
    const scArgs = spec.funcArgsToScVals(method, args);
    const operation = this.contract.call(method, ...scArgs);
    const account =
      sourceAccount === NULL_ACCOUNT ? new Account(NULL_ACCOUNT, '0') : await this.server.getAccount(sourceAccount);

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(30)
      .build();

    const simulation = await this.retryRpc(`simulateTransaction(${method})`, async () => {
      return await this.server.simulateTransaction(tx);
    });

    const simulation = await this.rpcPool.withFailover((server) => server.simulateTransaction(tx));
    if (rpc.Api.isSimulationError(simulation)) {
      throw new Error(`SoroWill simulation failed for ${method}: ${simulation.error}`);
    }
    if (!simulation.result) {
      throw new Error(`SoroWill simulation for ${method} returned no result`);
    }

    const result = spec.funcResToNative(method, simulation.result.retval) as T;
    await this.readCache?.set(cacheKey, result, getWillIdsFromReadResult(method, args, result));
    return result;
  }

  /** Builds, simulates, signs, and submits a state-changing contract call. */
  private async invoke(
    method: string,
    args: Record<string, unknown>,
    options?: RequestOptions,
  ): Promise<{ txHash: string; createdAt: number; returnValue: ScVal | undefined }> {
    const beforeCtx: BeforeInvokeContext = {
      method,
      args,
      timestamp: new Date().toISOString(),
    };
    const proceed = await this.hooks.runBeforeInvoke(beforeCtx);
    if (!proceed) {
      throw new Error(`SoroWill invocation aborted by beforeInvoke hook for ${method}`);
    }

    const startTime = Date.now();
    let txHash: string | null = null;
    let error: string | null = null;

    try {
      const spec = await this.getSpec();
      const scArgs = spec.funcArgsToScVals(method, args);
      const operation = this.contract.call(method, ...scArgs);

      const publicKey = await getPublicKey();
      const account = await this.server.getAccount(publicKey);
      const builtTx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(operation)
        .setTimeout(30)
        .build();

      const prepared = await this.server.prepareTransaction(builtTx);
      const signedTxXdr = await signTransaction(prepared.toXDR(), {
        networkPassphrase: this.networkPassphrase,
      });
      const signedTx = TransactionBuilder.fromXDR(signedTxXdr, this.networkPassphrase) as Transaction;

      const sendResponse = await this.server.sendTransaction(signedTx);
      if (sendResponse.status === 'ERROR') {
        throw new Error(`SoroWill transaction submission failed for ${method}`);
      }

      const txResponse = await this.server.pollTransaction(sendResponse.hash, { attempts: 30 });
      if (txResponse.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
        throw new Error(`SoroWill transaction for ${method} did not succeed: ${txResponse.status}`);
      }

      txHash = sendResponse.hash;

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
        txHash: sendResponse.hash,
        createdAt: txResponse.createdAt,
        returnValue: txResponse.returnValue,
      };
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      if (error) {
        const afterCtx: AfterInvokeContext = {
          method,
          args,
          timestamp: new Date().toISOString(),
          txHash,
          error,
          durationMs: Date.now() - startTime,
        };
        await this.hooks.runAfterInvoke(afterCtx);
      }
    }
    const spec = await this.getSpec(options);
    const operation = this.contract.call(method, ...spec.funcArgsToScVals(method, args));
    return this.submit([operation], method, options);
  }

    const publicKey = await this.wallet.getPublicKey();
    const account = await this.server.getAccount(publicKey);
    const builtTx = new TransactionBuilder(account, {
      fee: BASE_FEE,
  private async submit(
    operations: readonly xdr.Operation[],
    label: string,
    options?: RequestOptions,
  ): Promise<{ txHash: string; createdAt: number; returnValue: ScVal | undefined }> {
    try {
      const publicKey = await getPublicKey();
      const account = await this.rpc(() => this.server.getAccount(publicKey), options);
      const builder = new TransactionBuilder(account, {
        fee: (BigInt(BASE_FEE) * BigInt(operations.length)).toString(),
        networkPassphrase: this.networkPassphrase,
      });
      for (const operation of operations) builder.addOperation(operation);
      const builtTx = builder.setTimeout(30).build();

      // prepareTransaction simulates and assembles Soroban data for the whole transaction.
      const prepared = await this.rpc(() => this.server.prepareTransaction(builtTx), options);
      const signedTxXdr = await signTransaction(prepared.toXDR(), {
        networkPassphrase: this.networkPassphrase,
      });
      const signedTx = TransactionBuilder.fromXDR(
        signedTxXdr,
        this.networkPassphrase,
      ) as Transaction;

      const sendResponse = await this.rpc(() => this.server.sendTransaction(signedTx), options);
      if (sendResponse.status === 'ERROR') {
        const errorXdr = sendResponse.errorResult?.toXDR('base64') ?? 'no error result';
        throw new SoroWillError(
          `SoroWill transaction submission failed for ${label}: ${errorXdr}`,
        );
      }

      const txResponse = await this.rpc(
        () => this.server.pollTransaction(sendResponse.hash, { attempts: 30 }),
        options,
      );
      if (txResponse.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
        throw new SoroWillError(
          `SoroWill transaction for ${label} did not succeed: ${txResponse.status}`,
        );
      }

      return {
        txHash: sendResponse.hash,
        createdAt: txResponse.createdAt,
        returnValue: txResponse.returnValue,
      };
    } catch (error) {
      throw mapContractError(error);
    const builtTx = await this.buildInvocationTransaction(method, args);
    const prepared = await this.prepareInvocation(method, args, builtTx);

    assertPreparedTransactionMatchesIntendedOperation({
      intendedTransactionXdr: builtTx.toXDR(),
      preparedTransactionXdr: prepared.toXDR(),
      networkPassphrase: this.networkPassphrase,
      context: method,
    });

    const prepared = await this.server.prepareTransaction(builtTx);
    const signedTxXdr = await this.wallet.signTransaction(prepared.toXDR(), {
    const signedTxXdr = await signTransaction(prepared.toXDR(), {
      networkPassphrase: this.networkPassphrase,
    });
    const signedTx = TransactionBuilder.fromXDR(signedTxXdr, this.networkPassphrase) as Transaction;

    const sendResponse = await this.retryRpc(`sendTransaction(${method})`, async () => {
      return await this.server.sendTransaction(signedTx);
    });
    const sendResponse = await this.rpcPool.withFailover((server) => server.sendTransaction(signedTx));
    if (sendResponse.status === 'ERROR') {
      throw new Error(`SoroWill transaction submission failed for ${method}`);
    }

    const txResponse = await this.retryRpc(`pollTransaction(${method})`, async () => {
      return await this.server.pollTransaction(sendResponse.hash, { attempts: 30 });
    });
    const txResponse = await this.rpcPool.withFailover((server) =>
      server.pollTransaction(sendResponse.hash, { attempts: 30 }),
    );
    if (txResponse.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
      throw new Error(`SoroWill transaction for ${method} did not succeed: ${txResponse.status}`);
    }
  }

  /** Sends every RPC through the shared FIFO queue with the selected timeout. */
  private rpc<T>(request: () => Promise<T>, options?: RequestOptions): Promise<T> {
    return this.queue.enqueue(request, options?.timeoutMs ?? this.timeoutMs);
    this.readCache?.clear();

    if (method === 'create_will') {
      await this.readCache?.clear();
    } else {
      const affectedWillIds = getMutationWillIds(method, args);
      await Promise.all(affectedWillIds.map((willId) => this.readCache?.invalidateByWillId(willId)));
    }

    return {
      txHash: sendResponse.hash,
      createdAt: txResponse.createdAt,
      returnValue: txResponse.returnValue,
    };
  }

  private async retryRpc<T>(label: string, operation: () => Promise<T>): Promise<T> {
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

    throw new Error(
      `SoroWill RPC call ${label} failed after ${this.retryOptions.maxAttempts} attempts: ${String(lastError)}`,
    );
  }

  private async sleep(durationMs: number): Promise<void> {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, durationMs);
    });
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
    const transaction = builtTx ?? (await this.buildInvocationTransaction(method, args, sourcePublicKey));
    return this.rpcPool.withFailover((server) => server.prepareTransaction(transaction));
  }
}
