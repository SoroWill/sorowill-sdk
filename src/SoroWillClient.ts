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
  type ReadCacheOptions,
} from './cache';
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
import { InFlightTracker } from './inFlightTracker';
import { DebugLogger } from './debugLogger';

type ScVal = xdr.ScVal;

const { Spec } = stellarContract;

/** An impossible account used to simulate read-only calls without a connected wallet. */
const NULL_ACCOUNT = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

/** Supported Stellar networks. */
export type SoroWillNetwork = 'testnet' | 'mainnet';

/**
 * Default contract addresses for each network, sourced from the SoroWill
 * contracts repository's `deployments/` manifests.
 *
 * **IMPORTANT — keep in sync on every redeploy.**
 * These values are baked into this SDK release. If the maintainers redeploy
 * the SoroWill contract (e.g. after an upgrade), this map must be updated and
 * a new SDK version published. Consumers who need to pin to a specific
 * deployment — or who are running their own fork — should pass `contractId`
 * explicitly to the `SoroWillClient` constructor rather than relying on this
 * default.
 *
 * @see https://github.com/SoroWill/contracts/tree/main/deployments
 */
export const DEFAULT_CONTRACT_IDS: Record<SoroWillNetwork, string> = {
  testnet: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
  // Mainnet is not yet deployed. This placeholder will be replaced when the
  // mainnet contract is live. Calling forNetwork('mainnet') before that happens
  // will throw an error so misconfiguration is caught early.
  mainnet: '',
};

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
  /**
   * Enable structured debug logging for operation builds, simulations, and submissions.
   * When enabled, logs operation details without logging secrets or private keys.
   * Defaults to false (opt-in only).
   */
  debug?: boolean;
  /**
   * If a transaction doesn't land within the poll window, automatically
   * rebuild and resubmit with a higher fee instead of throwing.
   * Defaults to false (opt-in).
   */
  autoFeeBumpOnTimeout?: boolean;
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

/**
 * Guards against a contract spec / SDK version drift silently producing a
 * corrupted `Will`: verifies the value decoded by `funcResToNative` actually
 * has the shape this SDK expects before any of its fields are trusted.
 */
function isRawWillShape(value: unknown): value is RawWill {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'bigint' &&
    typeof v.owner === 'string' &&
    typeof v.token === 'string' &&
    typeof v.balance === 'bigint' &&
    Array.isArray(v.beneficiaries) &&
    typeof v.checkin_period_days === 'bigint' &&
    typeof v.grace_period_days === 'bigint' &&
    typeof v.last_checkin === 'bigint' &&
    (v.trigger_time === undefined || typeof v.trigger_time === 'bigint') &&
    typeof v.status === 'string' &&
    Array.isArray(v.guardians) &&
    typeof v.guardian_votes === 'number'
  );
}

function mapWill(raw: unknown): Will {
  if (!isRawWillShape(raw)) {
    throw new SoroWillError(
      'SoroWill received an unexpected shape while decoding a Will from the contract response. ' +
        'This usually means the deployed contract spec and this SDK version have drifted apart.',
    );
  }
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

function mapWillList(raw: unknown): Will[] {
  if (!Array.isArray(raw)) {
    throw new SoroWillError(
      'SoroWill expected a list of wills from the contract response but received something else. ' +
        'This usually means the deployed contract spec and this SDK version have drifted apart.',
    );
  }
  return raw.map(mapWill);
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

/**
 * A client for interacting with a deployed SoroWill contract from
 * TypeScript. Read methods (`getWill`, `getWillsByOwner`,
 * `getWillsByBeneficiary`) work without a connected wallet. All other
 * methods sign and submit a transaction via the configured wallet adapter.
 */
export class SoroWillClient {
  private readonly server: SoroWillRpcServer;
  private readonly rpcPool: RpcEndpointPool;
  private readonly contract: Contract;
  private readonly networkPassphrase: string;
  private readonly hooks: HookManager;
  private readonly wallet: WalletAdapter;
  private readonly retryOptions: RpcRetryOptions;
  private readonly pollAttempts: number;
  private readonly specOverride: ContractSpecLike | Promise<ContractSpecLike> | undefined;
  private readonly eventSubscription?: WillEventSubscription;
  private readonly eventRpcUrl: string;
  private readonly eventStreamUrl: string;
  private readonly defaultPollIntervalMs: number;
  private readonly fetchImplementation?: FetchImplementation;
  private readonly webSocketFactory?: (url: string) => WebSocketLike;
  private readonly queue: RequestQueue;
  private readonly timeoutMs: number;
  private readonly readCache: ReadCache | undefined;
  private specPromise: Promise<InstanceType<typeof Spec>> | undefined;
  private readonly inFlightTracker = new InFlightTracker();
  private readonly debug: boolean;
  private readonly debugLogger: DebugLogger;
  private readonly autoFeeBumpOnTimeout: boolean;

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
    this.readCache = options.readCache === false ? undefined : new ReadCache(options.readCache);
    this.debug = options.debug ?? false;
    this.debugLogger = new DebugLogger(this.debug);
    this.autoFeeBumpOnTimeout = options.autoFeeBumpOnTimeout ?? false;

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

  /**
   * Convenience constructor that targets a known network using the
   * **maintainer-managed default contract address** for that network.
   *
   * This is the recommended way to get started quickly. Any option accepted
   * by the `SoroWillClient` constructor can be passed as `overrides` —
   * including `contractId` if you need to point at a specific deployment
   * (e.g. a staging contract or your own fork).
   *
   * ```ts
   * // Simplest case — uses the default testnet contract:
   * const client = SoroWillClient.forNetwork('testnet');
   *
   * // Override the contract address (e.g. after a redeploy):
   * const client = SoroWillClient.forNetwork('testnet', {
   *   contractId: 'CNEW...',
   * });
   * ```
   *
   * **Important — default contract ID freshness:**
   * The default `contractId` values in {@link DEFAULT_CONTRACT_IDS} are
   * baked into each SDK release. If the SoroWill contract is redeployed
   * between SDK releases, you **must** pass `contractId` explicitly in
   * `overrides` until a new SDK version is published with the updated
   * address. Track redeployments in the contracts repo's
   * `deployments/` directory:
   * https://github.com/SoroWill/contracts/tree/main/deployments
   *
   * @param network - The target Stellar network (`'testnet'` or `'mainnet'`).
   * @param overrides - Any `SoroWillClientOptions` to merge on top of the
   *   per-network defaults. `network` is always taken from the first argument
   *   and cannot be overridden here.
   *
   * @throws {Error} If `network` is `'mainnet'` and no mainnet contract has
   *   been deployed yet (i.e. the default address is still the placeholder).
   */
  static forNetwork(
    network: SoroWillNetwork,
    overrides?: Partial<Omit<SoroWillClientOptions, 'network'>>,
  ): SoroWillClient {
    const defaultContractId = DEFAULT_CONTRACT_IDS[network];

    // Guard against the mainnet placeholder until a real deployment exists.
    if (!defaultContractId && !overrides?.contractId) {
      throw new Error(
        `No default contract address is available for network "${network}" yet. ` +
          'Pass contractId explicitly in the overrides argument.',
      );
    }

    return new SoroWillClient({
      ...overrides,
      network,
      contractId: overrides?.contractId ?? defaultContractId,
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
    const decoded = spec.funcResToNative('create_will', returnValue);
    if (typeof decoded !== 'bigint') {
      throw new SoroWillError(
        `SoroWill expected create_will to return a numeric will id but received a ${typeof decoded}. ` +
          'This usually means the deployed contract spec and this SDK version have drifted apart.',
      );
    }
    const willId = decoded.toString();
    return { willId, txHash };
  }

  /** Resets the check-in countdown for `willId`. */
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
    const owner = await getPublicKey();
    const { txHash } = await this.invoke(
      'update_beneficiaries',
      { will_id: BigInt(params.willId), owner, beneficiaries: params.beneficiaries },
      options,
    );
    return { txHash };
  }

  /** Adds more of the will's token to its locked balance. */
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
    const raw = await this.read<unknown>('get_will', { will_id: BigInt(willId) }, options);
    return mapWill(raw);
  }

  /** Lists every will owned by `owner`. Does not require a connected wallet. */
  async getWillsByOwner(owner: string, options?: RequestOptions): Promise<Will[]> {
    const raw = await this.read<unknown>('get_wills_by_owner', { owner }, options);
    return mapWillList(raw);
  }

  /** Lists every will `beneficiary` is named in. Does not require a connected wallet. */
  async getWillsByBeneficiary(
    beneficiary: string,
    options?: RequestOptions,
  ): Promise<Will[]> {
    const raw = await this.read<unknown>(
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

  /** Unsubscribes from any configured event source. */
  destroy(): void {
    if (this.eventSubscription) {
      unsubscribeFromWillEvents(this.eventSubscription);
    }
  }

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

  /** Builds, simulates, signs, and submits a state-changing contract call. */
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
      const spec = await this.getSpec(options);
      this.debugLogger.logOperationBuild(method, String(args.will_id ?? args.owner ?? ''));

      const operation = this.contract.call(method, ...spec.funcArgsToScVals(method, args));
      const result = await this.submit([operation], method, options);

      txHash = result.txHash;

      this.debugLogger.logSuccess(
        method,
        String(args.will_id ?? args.owner ?? ''),
        txHash,
        Date.now() - startTime,
      );

      const afterCtx: AfterInvokeContext = {
        method,
        args,
        timestamp: new Date().toISOString(),
        txHash,
        error: null,
        durationMs: Date.now() - startTime,
      };
      await this.hooks.runAfterInvoke(afterCtx);

      return result;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      this.debugLogger.logError(method, String(args.will_id ?? args.owner ?? ''), err);
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
      this.debugLogger.logSimulation(label);

      const signedTxXdr = await signTransaction(prepared.toXDR(), {
        networkPassphrase: this.networkPassphrase,
      });
      const signedTx = TransactionBuilder.fromXDR(
        signedTxXdr,
        this.networkPassphrase,
      ) as Transaction;

      options?.signal?.throwIfAborted();
      const sendResponse = await this.rpc(() => this.server.sendTransaction(signedTx), options);
      this.debugLogger.logSubmission(label, '', sendResponse.hash);

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
      let txResponse: rpc.Api.GetTransactionResponse;
      try {
        txResponse = await this.rpc(
          () => this.server.pollTransaction(sendResponse.hash, { attempts: this.pollAttempts }),
          options,
        );
      } catch (pollError) {
        // If poll times out and auto fee-bump is enabled, retry with higher fee
        if (this.autoFeeBumpOnTimeout) {
          this.debugLogger.logPoll(label, '');

          const feeBumpFee = (BigInt(BASE_FEE) * BigInt(operations.length) * BigInt(2)).toString();
          const feeBumpBuilder = new TransactionBuilder(account, {
            fee: feeBumpFee,
            networkPassphrase: this.networkPassphrase,
          });
          for (const operation of operations) feeBumpBuilder.addOperation(operation);
          const feeBumpTx = feeBumpBuilder.setTimeout(30).build();

          const feeBumpPrepared = await this.rpc(
            () => this.rpcPool.withFailover((server) => server.prepareTransaction(feeBumpTx)),
            options,
          );

          const feeBumpSignedXdr = await signTransaction(feeBumpPrepared.toXDR(), {
            networkPassphrase: this.networkPassphrase,
          });
          const feeBumpSignedTx = TransactionBuilder.fromXDR(
            feeBumpSignedXdr,
            this.networkPassphrase,
          ) as Transaction;

          const feeBumpResponse = await this.rpc(
            () => this.server.sendTransaction(feeBumpSignedTx),
            options,
          );

          if (feeBumpResponse.status === 'ERROR') {
            const errorXdr = feeBumpResponse.errorResult?.toXDR?.('base64') ?? 'no error result';
            throw new SoroWillError(
              `SoroWill fee-bump transaction submission failed for ${label}: ${errorXdr}`,
            );
          }

          this.debugLogger.logSubmission(label, '', feeBumpResponse.hash);

          txResponse = await this.rpc(
            () => this.server.pollTransaction(feeBumpResponse.hash, { attempts: this.pollAttempts }),
            options,
          );
        } else {
          throw pollError;
        }
      }

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

  private deriveDefaultEventStreamUrl(rpcUrl: string): string {
    const url = rpcUrl.replace(/^http/, 'ws');
    return url.endsWith('/') ? `${url}events` : `${url}/events`;
  }
}
