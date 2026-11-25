import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  FeeBumpTransaction,
  Networks,
  hash as stellarHash,
  StrKey,
  Transaction,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  xdr,
  contract as stellarContract,
} from '@stellar/stellar-sdk';

import {
  computeContractSpecVersion,
  describeContractVersionMismatch,
  type ContractSpecVersion,
} from './contractVersion';
import {
  createReadCacheKey,
  ReadCache,
  type ReadCacheOptions,
} from './cache';
import {
  EventDeduplicator,
  unsubscribeFromWillEvents,
  validateEventTypeFilter,
  type WillEventSource,
  type WillEventSubscription,
} from './events';
import type {
  BatchOperation,
  BatchOperationResult,
  BatchOperationResults,
  BatchQueueOptions,
  BatchQueueResult,
  BatchResult,
  Beneficiary,
  CreateWillParams,
  EmergencyCheckInOptions,
  EventSubscription,
  EventSubscriptionOptions,
  PaginatedWillsResult,
  PaginationOptions,
  RequestCostEstimate,
  RequestOptions,
  SoroWillEvent,
  SorobanEventType,
  UpdateBeneficiariesParams,
  Will,
  WillStreamOptions,
} from './types';
import { DEFAULT_WILL_STREAM_CHUNK_SIZE, WillStatus } from './types';
import {
  assertWalletSessionActive,
  getDefaultWalletAdapter,
  normalizeSignatureResponse,
  type SignatureResponse,
  type WalletAdapter,
  type WalletConnection,
} from './wallet';
import {
  AccountNotFundedError,
  BatchNetworkMismatchError,
  BeneficiaryValidationError,
  GuardianValidationError,
  CheckinPeriodExceedsTtlError,
  CheckInDuringGracePeriodError,
  ExorbitantFeeError,
  InvalidDayCountError,
  InvalidContractIdError,
  InvalidCursorError,
  InvalidGuardianSignatureError,
  InvalidPaginationOptionsError,
  InvalidPublicKeyError,
  InvalidWebSocketUrlError,
  InvokeFailedError,
  NotOwnerError,
  ReadOnlyModeError,
  RequestTimeoutError,
  mapContractError,
  SimulationError,
  SoroWillConfigError,
  SoroWillError,
  SoroWillInvalidAmountError,
  SoroWillRestoreRequiredError,
  TooManyGuardiansError,
  TransactionNetworkMismatchError,
  TransactionNotFoundError,
  UnsupportedBatchSizeError,
  WalletNetworkMismatchError,
  WillContractError,
  WebSocketNotConfiguredError,
  SseNotConfiguredError,
  GracePeriodActiveError,
  InvalidTimeLockError,
  TimeLockActiveError,
} from './errors';
import { assertValidBeneficiaryAddresses, assertValidStellarAddress, deepFreezeObject, hasDuplicateBeneficiaries, MAX_BENEFICIARIES, MAX_GUARDIANS, PERCENTAGE_SUM_EPSILON, validateBeneficiaries, validateGuardianSignature } from './utils';
import { RequestQueue } from './requestQueue';
import { InFlightTracker } from './inFlightTracker';
import { RpcEndpointPool } from './rpc';
import { buildSep7TxUri, type BuildSep7TxUriOptions } from './sep7';
import { HookManager } from './hooks';
import type { BeforeInvokeContext, AfterInvokeContext } from './hooks';
import { assertPreparedTransactionMatchesIntendedOperation, assertSupportedSignatureAlgorithm } from './txValidation';
import { DebugLogger, type DebugLoggerOptions } from './debugLogger';
import { SoroWillEventEmitter, type SoroWillLifecycleEvent } from './lifecycleEvents';

/** @internal Local alias for Soroban's `xdr.ScVal`; not part of the public API. */
type ScVal = xdr.ScVal;

/** Durability tier of a Soroban contract data ledger entry (#663). */
export type ContractStorageDurability = 'persistent' | 'temporary';

/**
 * Builds the `xdr.LedgerKey` for a Soroban contract's instance storage entry (#663).
 *
 * @param contractId - StrKey contract address (`C...`).
 * @throws {InvalidContractIdError} If `contractId` is not a valid Stellar contract ID.
 */
export function buildContractInstanceLedgerKey(contractId: string): xdr.LedgerKey {
  if (typeof contractId !== 'string' || !StrKey.isValidContract(contractId)) {
    throw new InvalidContractIdError(String(contractId));
  }
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: Address.fromString(contractId).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
}

/**
 * Builds an `xdr.LedgerKey` for a Soroban contract data storage entry (#663).
 *
 * @param contractId - StrKey contract address (`C...`).
 * @param key - Storage key as an `xdr.ScVal` or a JS value convertible via `nativeToScVal`.
 * @param durability - Storage durability tier (`'persistent'` or `'temporary'`). Defaults to `'persistent'`.
 * @throws {InvalidContractIdError} If `contractId` is not a valid Stellar contract ID.
 * @throws {SoroWillError} If `durability` is not `'persistent'` or `'temporary'`.
 */
export function buildContractDataLedgerKey(
  contractId: string,
  key: xdr.ScVal | unknown,
  durability: ContractStorageDurability = 'persistent',
): xdr.LedgerKey {
  if (typeof contractId !== 'string' || !StrKey.isValidContract(contractId)) {
    throw new InvalidContractIdError(String(contractId));
  }
  if (durability !== 'persistent' && durability !== 'temporary') {
    throw new SoroWillError(
      `Invalid contract storage durability: "${String(durability)}". Expected "persistent" or "temporary".`,
    );
  }
  const scKey = key instanceof xdr.ScVal ? key : nativeToScVal(key);
  const xdrDurability =
    durability === 'temporary'
      ? xdr.ContractDataDurability.temporary()
      : xdr.ContractDataDurability.persistent();

  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: Address.fromString(contractId).toScAddress(),
      key: scKey,
      durability: xdrDurability,
    }),
  );
}

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
 * @see https://github.com/SoroWill/sorowill-contracts/tree/main/deployments
 */
export const DEFAULT_CONTRACT_IDS: Record<SoroWillNetwork, string> = {
  testnet: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
  // Mainnet is not yet deployed. This placeholder will be replaced when the
  // mainnet contract is live. Calling forNetwork('mainnet') before that happens
  // will throw an error so misconfiguration is caught early.
  mainnet: '',
};

export interface NetworkConfig {
  rpcUrls: string[];
  networkPassphrase: string;
}

export const NETWORK_CONFIG: Record<SoroWillNetwork, NetworkConfig> = {
  testnet: {
    rpcUrls: ['https://soroban-testnet.stellar.org'],
    networkPassphrase: Networks.TESTNET,
  },
  mainnet: {
    rpcUrls: ['https://mainnet.sorobanrpc.com'],
    networkPassphrase: Networks.PUBLIC,
  },
};

/**
 * Result of a sign-only operation: a signed, prepared transaction envelope
 * that has **not** been submitted to the network.
 *
 * Use {@link SoroWillClient.submitSignedTransaction} to submit it later, or
 * hand the XDR to an offline/air-gapped signer or relayer.
 */
export interface SignedTransactionResult {
  /** Signed transaction envelope XDR (base64), ready for submission. */
  signedTxXdr: string;
  /** Network passphrase the envelope was signed for. */
  networkPassphrase: string;
  /** Transaction hash of the signed envelope (hex). */
  txHash: string;
  /** Source account public key of the signed transaction. */
  sourcePublicKey: string;
  /** Sequence number of the signed transaction (base-10 string). */
  sequence: string;
  /** Total fee of the signed transaction in stroops (base-10 string). */
  fee: string;
}

export interface RpcRetryOptions {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffFactor: number;
}

export interface SoroWillRpcServer {
  getContractWasmByContractId(contractId: string): Promise<Buffer | Uint8Array>;
  /**
   * Simulate an already-built Soroban transaction without signing or submitting it.
   * Use this low-level RPC method to inspect contract results or validate a
   * transaction before submission. Client write methods simulate internally
   * as part of `invoke`; callers should use those methods to perform writes.
   * Simulation makes an RPC round trip and does not change ledger state.
   */
  simulateTransaction(transaction: Transaction): Promise<rpc.Api.SimulateTransactionResponse>;
  getAccount(address: string): Promise<Account>;
  prepareTransaction(transaction: Transaction): Promise<Transaction>;
  sendTransaction(transaction: Transaction): Promise<rpc.Api.SendTransactionResponse>;
  pollTransaction(
    hash: string,
    options: { attempts: number },
  ): Promise<rpc.Api.GetTransactionResponse>;
  getFeeStats?(): Promise<rpc.Api.GetFeeStatsResponse>;
  getHealth?(): Promise<rpc.Api.GetHealthResponse>;
  /**
   * Fetch a transaction by hash. Returns `status: 'NOT_FOUND'` when the
   * network has no record of the hash.
   */
  getTransaction?(hash: string): Promise<rpc.Api.GetTransactionResponse>;
}

/**
 * Full details of a transaction fetched by hash via
 * {@link SoroWillClient.getTransaction}.
 */
export interface TransactionDetails {
  /** The transaction hash (hex). */
  hash: string;
  /** Terminal status reported by the network: `SUCCESS` or `FAILED`. */
  status: rpc.Api.GetTransactionStatus;
  /** Ledger sequence in which the transaction was included, if reported. */
  ledger?: number;
  /** Ledger close time (Unix seconds) of the including ledger, if reported. */
  createdAt?: number;
  /** Base64-encoded result XDR, if reported. */
  resultXdr?: string;
  /** Base64-encoded result meta XDR, if reported. */
  resultMetaXdr?: string;
  /** Base64-encoded envelope XDR, if reported. */
  envelopeXdr?: string;
  /** The raw RPC response, for fields not surfaced above. */
  raw: rpc.Api.GetTransactionResponse;
}

/** @internal */
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

/** Options for constructing a read cache scoped to SoroWill reads. */
export interface SoroWillReadCacheOptions {
  ttlMs?: number;
  /** Maximum cached entries before least-recently-used eviction. Defaults to 1000. */
  maxEntries?: number;
}

/** Soroban contract storage durability tier. */
export type ContractStorageDurability = 'persistent' | 'temporary' | 'instance';

/** Options for building a contract storage ledger entry key. */
export interface ContractStorageLedgerKeyOptions {
  /** Storage durability tier. Defaults to `'persistent'`. */
  durability?: ContractStorageDurability;
}

export type {
  EventSubscription,
  EventSubscriptionOptions,
  EventSubscriptionTransport,
} from './types';

/** Options for constructing a {@link SoroWillClient}. */
export interface SoroWillClientOptions {
  /**
   * Which Stellar network to connect to. Must be `"testnet"` or `"mainnet"`;
   * any other value throws {@link SoroWillConfigError} at construction.
   */
  network: SoroWillNetwork;
  /**
   * The deployed SoroWill contract's address. Must be a 56-character StrKey
   * starting with `C`; otherwise {@link InvalidContractIdError} is thrown at
   * construction.
   */
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
   * Optional shared in-flight deduplication tracker.
   *
   * By default each `SoroWillClient` instance creates its own `InFlightTracker`
   * scoped to its `contractId`, so duplicate requests from *different* instances
   * are not deduplicated. Pass a shared `InFlightTracker` (constructed with the
   * same `contractId` as the clients) to enable cross-instance deduplication
   * for the same contract (#503).
   *
   * @example
   * ```ts
   * import { InFlightTracker, SoroWillClient } from '@sorowill/sdk';
   *
   * const tracker = new InFlightTracker('CA3D5KRY...');
   * const clientA = new SoroWillClient({ ..., inFlightTracker: tracker });
   * const clientB = new SoroWillClient({ ..., inFlightTracker: tracker });
   * ```
   */
  inFlightTracker?: InFlightTracker;
  /**
   * Coalesce identical concurrent read-only calls (same contract method and
   * arguments) into a single RPC simulation, sharing its result between every
   * caller. Defaults to `true`. Reads that pass an `AbortSignal` are never
   * coalesced, so aborting one caller can't cancel another caller's request.
   */
  deduplicateReads?: boolean;
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
   * Advanced override that supplies the deployed contract's raw WASM bytes
   * directly, skipping the lazy `getContractWasmByContractId` RPC round-trip
   * that {@link getSpec} otherwise performs on first use. Takes priority over
   * fetching from the RPC server, but is itself overridden by `spec` if both
   * are provided.
   */
  specJson?: Uint8Array;
  /**
   * How long (in milliseconds) the lazily-fetched contract spec is considered
   * fresh before it is expired and re-fetched from the RPC node (#502).
   *
   * This is the primary mechanism for detecting a contract upgrade mid-session:
   * once the TTL has elapsed, the next SDK call will transparently re-fetch the
   * WASM, re-derive the `Spec`, and resume normal operation with the updated
   * method signatures.
   *
   * - Set to a finite value (e.g. `300_000` = 5 minutes) if you need to handle
   *   contract upgrades without constructing a new client.
   * - Defaults to `Infinity` (never re-fetch) to preserve the previous
   *   behaviour for existing consumers who do not need live upgrade detection.
   * - Has no effect when `spec` or `specJson` are provided (those are treated
   *   as permanent overrides and are not subject to TTL expiry).
   *
   * @example
   * ```ts
   * // Refresh the spec at most every 5 minutes.
   * const client = new SoroWillClient({
   *   network: 'testnet',
   *   contractId: 'C...',
   *   specCacheTtlMs: 5 * 60 * 1000,
   * });
   * ```
   */
  specCacheTtlMs?: number;
  /**
   * The contract version this application was built against. When the
   * deployed contract embeds a version in its `contractmetav0` WASM metadata
   * and it differs from this value, a mismatch warning is logged with
   * `console.warn` the first time the spec is loaded. See
   * {@link SoroWillClient.contractSpecVersion}.
   */
  expectedContractVersion?: string;
  /**
   * Optional override for the Soroban RPC endpoint. Must be an absolute
   * `http://` or `https://` URL; otherwise {@link SoroWillConfigError} is
   * thrown at construction.
   */
  rpcUrl?: string;
  /**
   * Optional override for the Stellar network passphrase. Must be a non-empty
   * string; otherwise {@link SoroWillConfigError} is thrown at construction.
   */
  networkPassphrase?: string;
  /**
   * Optional override for the endpoint used for event polling. Must be an
   * absolute `http://` or `https://` URL; otherwise {@link SoroWillConfigError}
   * is thrown at construction.
   */
  eventRpcUrl?: string;
  /**
   * Optional override for the WebSocket event streaming endpoint. Must be an
   * absolute `wss://` URL; otherwise {@link InvalidWebSocketUrlError} is thrown
   * at construction.
   */
  eventStreamUrl?: string;
  /**
   * Optional Server-Sent Events (SSE) endpoint used for real-time event
   * delivery when `subscribeToEvents` is called with `transport: 'sse'` (or
   * `'auto'`, which prefers SSE over WebSocket and polling).
   */
  eventSseUrl?: string;
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
  /**
   * Default timeout applied to each RPC request, in milliseconds. Must be a
   * finite number greater than zero. Defaults to 30 seconds.
   */
  timeoutMs?: number;
  /**
   * Maximum number of RPC requests in flight at once. Must be a positive
   * integer. Defaults to 4.
   */
  maxConcurrentRequests?: number;
  /**
   * Maximum RPC requests started in a rolling one-second window. Must be a
   * positive integer. Defaults to 10.
   */
  requestsPerSecond?: number;
  /**
   * Maximum number of RPC requests allowed to wait in the client's request
   * queue at once. Defaults to 1000. Requests enqueued while the queue is
   * full are rejected with a `RequestQueueOverflowError` instead of growing
   * the queue without bound (#525).
   *
   * Must be a positive integer; otherwise {@link SoroWillConfigError} is thrown
   * at construction.
   */
  maxQueueSize?: number;
  /**
   * Optional list of RPC endpoints to use with automatic failover. Must be a
   * non-empty array of absolute `http://` or `https://` URLs; otherwise
   * {@link SoroWillConfigError} is thrown at construction.
   */
  rpcUrls?: string[];
  /**
   * Whether to probe configured RPC endpoints on startup to deprioritize
   * unhealthy endpoints and fail over to a healthy secondary automatically.
   * Defaults to `true` when using real RPC servers (skipped when `rpcServer`
   * override is supplied).
   */
  checkHealthOnStartup?: boolean;
  /**
   * When `true`, query methods (`getWill`, `getWillsByOwner`,
   * `getWillsByBeneficiary`) return deeply frozen objects so callers cannot
   * accidentally mutate internal SDK state. Defaults to `false`.
   *
   * When `true`, each returned `Will` (and its nested `beneficiaries`,
   * `guardians`, `lastCheckin`, `triggerTime`, etc.) is frozen via
   * `Object.freeze()` at every depth. Any attempt to reassign a property
   * throws a `TypeError` in strict mode.
   *
   * @example
   * ```ts
   * import { SoroWillClient } from '@sorowill/sdk';
   *
   * const client = new SoroWillClient({
   *   network: 'testnet',
   *   contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
   *   deepFreeze: true,
   * });
   *
   * const will = await client.getWill('1');
   * will.balance = '999999'; // Throws: Cannot assign to read only property
   * will.beneficiaries[0].percentage = 99; // Throws
   * ```
   */
  deepFreeze?: boolean;
  /**
   * Maximum number of poll attempts for transaction finality.
   * Defaults to 30. Increase under mainnet congestion.
   *
   * Must be a positive integer; otherwise {@link SoroWillConfigError} is thrown
   * at construction.
   */
  pollAttempts?: number;
  /**
   * Enable structured debug logging for operation builds, simulations, and submissions.
   * When enabled, logs operation details without logging secrets or private keys.
   * Defaults to false (opt-in only).
   */
  debug?: boolean;
  /**
   * Controls redaction of sensitive fields in debug logs. Redaction is on by
   * default; pass extra field names via `redactKeys` to extend
   * {@link DEFAULT_REDACTED_KEYS}.
   */
  debugLoggerOptions?: DebugLoggerOptions;
  /**
   * If a transaction doesn't land within the poll window, automatically
   * rebuild and resubmit with a higher fee instead of throwing.
   * Defaults to false (opt-in).
   */
  autoFeeBumpOnTimeout?: boolean;
  /**
   * The validity window (in seconds) set on every built transaction via
   * `TransactionBuilder.setTimeout()`. Defaults to `30`.
   *
   * Increase this for signing flows that may take longer than 30 seconds
   * (e.g. a hardware wallet whose user needs time to physically approve the
   * transaction on-device), and decrease it if you want transactions to
   * expire more quickly.
   *
   * The value is forwarded to every `read()`, `submit()`, `batch()`, and
   * `buildInvocationTransaction()` call made by this client.
   */
  transactionTimeoutSeconds?: number;
  /**
   * When `true`, every state-changing operation refuses to proceed if the
   * wallet adapter cannot report its network (i.e. it does not implement
   * `getNetwork`). Defaults to `false`, in which case such wallets are not
   * checked and the network is only verified for adapters that can report it.
   */
  requireWalletNetwork?: boolean;
  /**
   * When `true`, the client operates in read-only mode. No wallet is required,
   * and all write (state-changing) operations will throw a {@link ReadOnlyModeError}
   * instead of attempting to sign and submit a transaction. Ideal for server-side
   * rendering, analytics dashboards, or any context where only query methods are
   * needed (#635).
   *
   * When `readOnly: true`, the `wallet` option is ignored and no default
   * wallet adapter is loaded.
   *
   * @example
   * ```ts
   * const client = new SoroWillClient({
   *   network: 'testnet',
   *   contractId: 'C...',
   *   readOnly: true,
   * });
   *
   * // Works fine:
   * const will = await client.getWill('1');
   *
   * // Throws ReadOnlyModeError:
   * await client.checkIn('1');
   * ```
   */
  readOnly?: boolean;
  /**
   * Optional lifecycle event emitter. When provided, the client emits
   * `init`, `connect`, `disconnect`, and `error` events to its listeners
   * (#786). A private emitter is created when omitted, so
   * {@link SoroWillClient.on} always works.
   */
  events?: SoroWillEventEmitter;
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
  release_after?: bigint | undefined;
  status: WillStatus;
  guardians: string[];
  guardian_votes: number;
}

const DEFAULT_POLL_ATTEMPTS = 30;

/**
 * Contract methods for which two concurrent invocations targeting the same
 * will must never both be submitted — each would send its own transaction
 * on-chain. Invocations of these methods are registered through
 * {@link InFlightTracker.trackExclusive}, so a duplicate arriving while the
 * first is still in flight is rejected with a `DuplicateOperationError`
 * instead of silently issuing a second transaction (#523).
 */
const EXCLUSIVE_INVOKE_METHODS: ReadonlySet<string> = new Set(['check_in']);

/** How a {@link SoroWillClient.batchCheckIn} run treats individual failures. */
export type BatchCheckInMode = 'best-effort' | 'atomic';

/** Per-will outcome of a {@link SoroWillClient.batchCheckIn} run. */
export interface BatchCheckInResult {
  /** The will id that was checked in. */
  willId: string;
  /** `true` when the check-in succeeded (or was skipped in atomic mode). */
  success: boolean;
  /** Number of attempts made for this will (0 when skipped). */
  attempts: number;
  /** Transaction hash of the successful check-in, when available. */
  txHash?: string;
  /** The error that caused the final failure, when `success` is `false`. */
  error?: unknown;
  /** `true` when the will was not attempted because an earlier will failed in atomic mode. */
  skipped?: boolean;
}

/** Options for {@link SoroWillClient.batchCheckIn}. */
export interface BatchCheckInOptions {
  /**
   * `'best-effort'` (default) attempts every will and reports each outcome.
   * `'atomic'` stops at the first failure and marks the remaining wills as skipped.
   */
  mode?: BatchCheckInMode;
  /** Maximum attempts per will, including the first. Defaults to `3`. */
  maxAttempts?: number;
  /** Base delay in milliseconds for exponential backoff between retries. Defaults to `250`. */
  retryBaseDelayMs?: number;
  /** Maximum delay in milliseconds between retries. Defaults to `5_000`. */
  retryMaxDelayMs?: number;
  /** Called after each will settles, in input order. */
  onResult?: (result: BatchCheckInResult) => void;
}

/** Aggregate outcome of a {@link SoroWillClient.batchCheckIn} run. */
export interface BatchCheckInSummary {
  /** The mode the run used. */
  mode: BatchCheckInMode;
  /** Per-will results, in input order. */
  results: BatchCheckInResult[];
  /** Will ids that were checked in successfully. */
  succeeded: string[];
  /** Will ids that failed after all retries. */
  failed: string[];
  /** Will ids not attempted because of an earlier failure in atomic mode. */
  skipped: string[];
  /** `true` when every will succeeded. */
  allSucceeded: boolean;
}

const DEFAULT_BATCH_CHECKIN_MAX_ATTEMPTS = 3;
const DEFAULT_BATCH_CHECKIN_RETRY_BASE_DELAY_MS = 250;
const DEFAULT_BATCH_CHECKIN_RETRY_MAX_DELAY_MS = 5_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * How long `subscribeToEvents` waits for a WebSocket to fire `onopen` before
 * giving up and falling back to HTTP polling. Guards against a server that
 * accepts the TCP/TLS connection but never completes the WebSocket handshake
 * (and never fires `onopen`, `onerror`, or `onclose`), which would otherwise
 * leave the returned promise pending forever.
 */
const DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_SSE_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_SSE_RECONNECT_DELAY_MS = 1_000;
const DEFAULT_SSE_MAX_RECONNECT_DELAY_MS = 30_000;

const DEFAULT_RETRY_OPTIONS: RpcRetryOptions = {
  maxAttempts: 1,
  initialDelayMs: 200,
  maxDelayMs: 2_000,
  backoffFactor: 2,
};

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
    (v.release_after === undefined || typeof v.release_after === 'bigint') &&
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
    beneficiaries: fromContractBeneficiaries(raw.beneficiaries),
    checkinPeriodDays: Number(raw.checkin_period_days),
    gracePeriodDays: Number(raw.grace_period_days),
    lastCheckin: new Date(Number(raw.last_checkin) * 1000),
    triggerTime: raw.trigger_time === undefined ? null : new Date(Number(raw.trigger_time) * 1000),
    status: raw.status,
    guardians: [...raw.guardians],
    guardianVotes: raw.guardian_votes,
    releaseAfter:
      raw.release_after === undefined || raw.release_after === 0n
        ? null
        : new Date(Number(raw.release_after) * 1000),
  };
}

/**
 * Deep-clones a `Will`, including its `beneficiaries`/`guardians` arrays and
 * the `lastCheckin`/`triggerTime` `Date` fields. Read-cache hits return the
 * exact cached object, so a caller mutating a returned `Will` (including
 * calling `setTime` on a `Date` field) would otherwise corrupt the cache for
 * every subsequent read of the same will (#187, #399).
 */
function cloneWill(will: Will): Will {
  return {
    ...will,
    beneficiaries: will.beneficiaries.map((beneficiary) => ({ ...beneficiary })),
    guardians: [...will.guardians],
    lastCheckin: new Date(will.lastCheckin.getTime()),
    triggerTime: will.triggerTime === null ? null : new Date(will.triggerTime.getTime()),
    releaseAfter: will.releaseAfter === null ? null : new Date(will.releaseAfter.getTime()),
  };
}

/** Default lifetime of a guardian vote before it expires, in milliseconds (24h). */
export const DEFAULT_GUARDIAN_VOTE_TTL_MS = 24 * 60 * 60 * 1000;

/** Per-guardian vote state returned by {@link SoroWillClient.getGuardianVotingStatus}. */
export interface GuardianVoteStatus {
  /** The guardian address. */
  readonly guardian: string;
  /** Whether this guardian has cast a vote in the current release cycle. */
  readonly hasVoted: boolean;
  /** When the guardian voted, or `null` if they have not voted. */
  readonly votedAt: Date | null;
  /** When the vote expires, or `null` if the guardian has not voted. */
  readonly expiresAt: Date | null;
  /** `true` when the guardian voted but the vote has since expired. */
  readonly expired: boolean;
}

/** Aggregate guardian voting status for a will. */
export interface GuardianVotingStatus {
  /** The will ID these votes belong to. */
  readonly willId: string;
  /** Number of distinct guardians who have voted in the current cycle. */
  readonly votesCast: number;
  /** Number of guardians required to release the will (2 of N). */
  readonly votesRequired: number;
  /** `true` when enough unexpired votes exist to release the will. */
  readonly thresholdReached: boolean;
  /** Per-guardian vote details, in the will's guardian order. */
  readonly guardians: readonly GuardianVoteStatus[];
}

/**
 * Builds the per-guardian voting status for a will from its guardian list,
 * vote count and the timestamps of the votes cast (#800).
 *
 * The contract only exposes the aggregate `guardian_votes` count, so vote
 * timestamps are attributed in guardian order: the first `votesCast` guardians
 * are treated as the voters. A vote is expired when `now - votedAt` exceeds
 * `ttlMs`; expired votes no longer count toward the release threshold.
 */
export function buildGuardianVotingStatus(
  will: Pick<Will, 'id' | 'guardians' | 'guardianVotes'>,
  voteTimestamps: readonly (Date | number | null | undefined)[] = [],
  options: { now?: number; ttlMs?: number } = {},
): GuardianVotingStatus {
  const now = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? DEFAULT_GUARDIAN_VOTE_TTL_MS;
  const votesRequired = 2;
  const votesCast = Math.max(0, Math.min(will.guardianVotes, will.guardians.length));

  const guardians: GuardianVoteStatus[] = will.guardians.map((guardian, index) => {
    const rawTimestamp = voteTimestamps[index];
    const votedAt =
      index < votesCast && rawTimestamp !== null && rawTimestamp !== undefined
        ? rawTimestamp instanceof Date
          ? new Date(rawTimestamp.getTime())
          : new Date(rawTimestamp)
        : null;
    const expiresAt = votedAt === null ? null : new Date(votedAt.getTime() + ttlMs);
    const expired = expiresAt !== null && expiresAt.getTime() <= now;
    return {
      guardian,
      hasVoted: index < votesCast,
      votedAt,
      expiresAt,
      expired,
    };
  });

  const activeVotes = guardians.filter((g) => g.hasVoted && !g.expired).length;
  return {
    willId: will.id,
    votesCast,
    votesRequired,
    thresholdReached: activeVotes >= votesRequired,
    guardians,
  };
}

function mapWillList(raw: unknown): Will[] {
  if (!Array.isArray(raw)) {
    throw new SoroWillError(
      'SoroWill expected a list of wills from the contract response but received something else. ' +
        'This usually means the deployed contract spec and this SDK version have drifted apart.',
    );
  }
  return sortWillsById(deduplicateWillsById(raw.map(mapWill)));
}

/**
 * Removes duplicate will entries by `id`. When the RPC response contains the
 * same will more than once (e.g. due to overlapping pagination cursors on the
 * contract side), only the first occurrence is kept. The input order is
 * preserved before the subsequent {@link sortWillsById} step (#634).
 */
function deduplicateWillsById(wills: Will[]): Will[] {
  const seen = new Set<string>();
  return wills.filter((will) => {
    if (seen.has(will.id)) return false;
    seen.add(will.id);
    return true;
  });
}

/**
 * Sorts wills ascending by numeric `will_id`. The contract does not guarantee
 * list order, so the SDK enforces it client-side: pagination cursors are
 * indexes into this sorted list, which keeps pages stable across calls
 * (no duplicates or skips as long as the underlying set is unchanged).
 */
function sortWillsById(wills: Will[]): Will[] {
  return wills.sort((a, b) => {
    const x = BigInt(a.id);
    const y = BigInt(b.id);
    return x < y ? -1 : x > y ? 1 : 0;
  });
}

// === Beneficiary scale conversion

/**
 * The SDK's public `Beneficiary.percentage` is on a 0-100 scale, but the
 * deployed contract's `Beneficiary` struct stores `basis_points` (0-10,000,
 * where 1 bp = 0.01%) and its `distribute()` divides each share by 10,000.
 * Multiplying by this factor converts an SDK percentage into the contract's
 * basis-point representation, so a 30% share binds on-chain as
 * `basis_points = 3000` rather than `30`.
 */
const PERCENT_TO_BASIS_POINTS = 100;

/**
 * Total beneficiary share expected on-chain, in basis points (100% = 10_000).
 * The SDK accepts whole percentages (0-100 scale) and scales them by
 * {@link PERCENT_TO_BASIS_POINTS}; the scaled total must equal this value or
 * the contract rejects the transaction with `InvalidPercentages`.
 */
const TOTAL_BASIS_POINTS = 10_000;

/**
 * Maximum `checkinPeriodDays` accepted by {@link SoroWillClient.createWill}.
 *
 * The will ledger entry must stay live until its check-in deadline or it is
 * archived and can no longer be triggered without a manual restore. Soroban
 * persistent entries live at most ~1 year of ledgers without a TTL extension
 * bump, so the check-in deadline (which is the only thing keeping the entry
 * alive via periodic `check_in` calls) must fall inside that window. The cap
 * is set conservatively below a full year (365 days) to leave headroom for
 * ledger-close variance.
 *
 * **IMPORTANT**: mirrors the contract-side maximum period validated in
 * `contracts/will/src/lib.rs` (`InvalidPeriod`); keep in sync manually.
 *
 * @since 0.1.2
 */
export const MAX_CHECKIN_PERIOD_DAYS = 365 - 30;

/** Maps SDK beneficiaries (0-100 `percentage`) to the contract's `{ address, basis_points }` shape. */
function toContractBeneficiaries(
  beneficiaries: readonly Beneficiary[],
): Array<{ address: string; basis_points: number }> {
  return beneficiaries.map((beneficiary) => ({
    address: beneficiary.address,
    // Math.round strips binary floating-point artifacts (e.g. 0.1 * 100 is
    // 10.000000000000002) so the emitted basis points are always integers
    // that still sum to exactly 10,000 when validation accepted the list.
    basis_points: Math.round(beneficiary.percentage * PERCENT_TO_BASIS_POINTS),
  }));
}

/**
 * Maps the contract's `{ address, basis_points }` beneficiaries back to the
 * SDK's 0-100 `percentage` scale (the inverse of {@link toContractBeneficiaries}).
 * Entries already carrying a `percentage` are passed through unchanged. The SDK
 * only ever writes whole percentages, so a `basis_points` value that is not a
 * multiple of 100 cannot be represented and is rejected rather than rounded.
 */
function fromContractBeneficiaries(beneficiaries: readonly unknown[]): Beneficiary[] {
  return beneficiaries.map((entry) => {
    const { address, basis_points: basisPoints, percentage } = entry as {
      address: string;
      basis_points?: unknown;
      percentage?: number;
    };
    if (basisPoints === undefined) {
      return { address, percentage: percentage as number };
    }
    const bp = Number(basisPoints);
    if (!Number.isInteger(bp) || bp % PERCENT_TO_BASIS_POINTS !== 0) {
      throw new SoroWillError(
        `SoroWill received beneficiary basis_points ${String(basisPoints)} for ${address}, which is not a ` +
          'whole percentage (a multiple of 100) and cannot be represented on the SDK\'s 0-100 percentage scale.',
      );
    }
    return { address, percentage: bp / PERCENT_TO_BASIS_POINTS };
  });
}

/**
 * Shape of an individual event record as returned by this SDK's own
 * polling/WebSocket event-subscription protocol (see {@link SoroWillClient.subscribeToEvents}).
 * This is distinct from `@stellar/stellar-sdk`'s `rpc.Api` event types —
 * events arrive here already JSON-decoded from either an HTTP poll response
 * or a WebSocket message.
 */
interface RawEventRecord {
  id?: string;
  pagingToken?: string;
  ledger?: number;
  ledgerClosedAt?: string;
  contractId?: string;
  txHash?: string;
  type?: string;
  topics?: unknown[];
  topic?: unknown[];
  value?: unknown;
}

function mapEventRecord(record: RawEventRecord, fallbackContractId: string): SoroWillEvent {
  const cursor = record.pagingToken ?? record.id ?? '';
  return {
    id: record.id ?? cursor,
    cursor,
    ledger: record.ledger ?? null,
    ledgerClosedAt: record.ledgerClosedAt ? new Date(record.ledgerClosedAt) : null,
    contractId: record.contractId ?? fallbackContractId,
    txHash: record.txHash ?? null,
    type: record.type ?? '',
    topics: record.topics ?? record.topic ?? [],
    value: record.value,
    raw: record,
  };
}

/**
 * Builds the `getEvents` filter list. A Soroban filter matches a single event
 * `type`, so one filter is emitted per requested type.
 */
function buildEventFilters(
  contractId: string,
  eventTypes: SorobanEventType[] | undefined,
): Array<{ type?: SorobanEventType; contractIds: string[] }> {
  if (!eventTypes) {
    return [{ contractIds: [contractId] }];
  }
  return eventTypes.map((type) => ({ type, contractIds: [contractId] }));
}

function parseCursor(cursor: string | undefined): number {
  if (cursor === undefined) {
    return 0;
  }
  if (typeof cursor !== 'string') {
    throw new InvalidCursorError(String(cursor), `expected a string, received ${typeof cursor}`);
  }
  if (cursor.length === 0) {
    throw new InvalidCursorError(cursor, 'cursor must not be empty');
  }
  if (!/^(0|[1-9]\d*)$/.test(cursor)) {
    throw new InvalidCursorError(
      cursor,
      'expected a non-negative integer offset with no sign, decimals, whitespace, or leading zeros',
    );
  }
  const offset = Number(cursor);
  if (!Number.isSafeInteger(offset)) {
    throw new InvalidCursorError(cursor, 'cursor offset exceeds Number.MAX_SAFE_INTEGER');
  }
  return offset;
}

function validateEventCursor(cursor: string | undefined): void {
  if (cursor === undefined) {
    return;
  }
  if (typeof cursor !== 'string') {
    throw new InvalidCursorError(String(cursor), `expected a string, received ${typeof cursor}`);
  }
  if (cursor.length === 0) {
    throw new InvalidCursorError(cursor, 'cursor must not be empty');
  }
  if (cursor.length > 256) {
    throw new InvalidCursorError(cursor, 'cursor must not exceed 256 characters');
  }
  // RPC paging token format: digits-digits (e.g., '0004294967296-0000000001')
  if (!/^\d+-\d+$/.test(cursor)) {
    throw new InvalidCursorError(
      cursor,
      'expected RPC paging token format (e.g., "0004294967296-0000000001")',
    );
  }
}

function normalizePositiveInteger(value: number | undefined, label: string): number | null {
  if (value === undefined) {
    return null;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new InvalidPaginationOptionsError(label, value);
  }
  return value;
}

/**
 * Validates a non-negative integer pagination option (`offset`). Unlike
 * {@link normalizePositiveInteger}, zero is accepted because skipping zero
 * records is the first page.
 */
function normalizeNonNegativeInteger(value: number | undefined, label: string): number | null {
  if (value === undefined) {
    return null;
  }
  if (!Number.isInteger(value) || value < 0) {
    throw new InvalidPaginationOptionsError(label, value);
  }
  return value;
}

/**
 * Resolves the effective page size from `limit` (preferred) or its `pageSize`
 * alias, validating both when present.
 */
function resolvePageSize(options: PaginationOptions | undefined): number | null {
  const limit = normalizePositiveInteger(options?.limit, 'limit');
  const pageSize = normalizePositiveInteger(options?.pageSize, 'pageSize');
  return limit ?? pageSize;
}

/**
 * Validates every pagination option on `options` up front so callers get a
 * typed error before any cache lookup or RPC round-trip.
 */
function validatePaginationOptions(options: PaginationOptions | undefined): void {
  if (!options) {
    return;
  }
  if (options.cursor !== undefined) {
    parseCursor(options.cursor);
  }
  resolvePageSize(options);
  normalizeNonNegativeInteger(options.offset, 'offset');
}

/**
 * Validates that `amount` is a string representing a positive integer before
 * it is passed to `BigInt()`. Throws {@link SoroWillInvalidAmountError} for
 * zero, negative, or malformed (non-numeric) strings so callers get a clear,
 * SDK-level error rather than a raw `SyntaxError` or a wasted RPC round-trip.
 */
function validateAmount(amount: string): bigint {
  // Only decimal digit strings with no leading minus or decimals are valid.
  // Must be at least one character, all digits, and the parsed value > 0.
  if (typeof amount !== 'string' || !/^\d+$/.test(amount)) {
    throw new SoroWillInvalidAmountError(amount);
  }
  const value = BigInt(amount);
  if (value <= 0n) {
    throw new SoroWillInvalidAmountError(amount);
  }
  return value;
}

export class SoroWillInvalidIdError extends SoroWillError {
  constructor(willId: unknown) {
    super(`Invalid willId: '${String(willId)}'. Expected a non-negative integer string.`);
    this.name = 'SoroWillInvalidIdError';
  }
}

/** Validates a `willId` string and converts it to a `bigint`, throwing {@link SoroWillInvalidIdError} for malformed ids. */
export function parseWillId(willId: string): bigint {
  if (typeof willId !== 'string' || !/^\d+$/.test(willId)) {
    throw new SoroWillInvalidIdError(willId);
  }
  return BigInt(willId);
}

/**
 * Validates that a day-count parameter (e.g. `checkinPeriodDays` or
 * `gracePeriodDays`) is a positive integer before it is converted to
 * `BigInt`. Throws a clear, SDK-level {@link SoroWillError} naming the
 * offending parameter instead of letting `BigInt()` surface a cryptic
 * `RangeError` such as *"The number 90.5 cannot be converted to a BigInt
 * because it is not an integer"*.
 *
 * @param value - The numeric value to validate.
 * @param paramName - Human-readable parameter name used in the error message.
 * @returns The value as a `bigint`.
 * @throws {SoroWillError} If `value` is not a positive integer.
 */
function validateDays(value: number, paramName: string): bigint {
  if (!Number.isInteger(value) || value <= 0) {
    throw new InvalidDayCountError(paramName, value);
  }
  return BigInt(value);
}

/**
 * Validates `checkinPeriodDays` against the contract storage TTL window.
 * Runs after {@link validateDays} so non-positive / fractional values still
 * surface as {@link InvalidDayCountError}; only in-range-but-unsafe values
 * throw {@link CheckinPeriodExceedsTtlError}.
 *
 * @since 0.1.2
 */
function validateCheckinPeriodDays(value: number): bigint {
  const days = validateDays(value, 'checkinPeriodDays');
  if (value > MAX_CHECKIN_PERIOD_DAYS) {
    throw new CheckinPeriodExceedsTtlError(value, MAX_CHECKIN_PERIOD_DAYS);
  }
  return days;
}

/**
 * Resolves the optional time-lock condition supplied to `createWill` into the
 * absolute Unix-seconds timestamp the contract stores as `release_after`.
 *
 * `timeLockDays` and `releaseAfter` are mutually exclusive; supplying neither
 * yields `undefined` (no time lock). `timeLockDays` is converted relative to
 * `now` so the condition is anchored at creation time.
 *
 * @param params - The `createWill` parameters carrying the time-lock fields.
 * @param now - Reference instant used to resolve `timeLockDays` (injectable for tests).
 * @returns The `release_after` timestamp in Unix seconds, or `undefined`.
 * @throws {InvalidTimeLockError} If the condition is malformed or in the past.
 * @since 0.1.3
 */
export function resolveTimeLock(
  params: Pick<CreateWillParams, 'timeLockDays' | 'releaseAfter'>,
  now: Date = new Date(),
): bigint | undefined {
  const { timeLockDays, releaseAfter } = params;
  if (timeLockDays !== undefined && releaseAfter !== undefined) {
    throw new InvalidTimeLockError(
      'releaseAfter',
      releaseAfter,
      'timeLockDays and releaseAfter are mutually exclusive; supply only one time-lock condition.',
    );
  }
  if (timeLockDays !== undefined) {
    if (!Number.isInteger(timeLockDays) || timeLockDays <= 0) {
      throw new InvalidTimeLockError(
        'timeLockDays',
        timeLockDays,
        `must be a positive integer number of days (received ${String(timeLockDays)}).`,
      );
    }
    return BigInt(Math.floor(now.getTime() / 1000) + timeLockDays * 86_400);
  }
  if (releaseAfter !== undefined) {
    if (!(releaseAfter instanceof Date) || Number.isNaN(releaseAfter.getTime())) {
      throw new InvalidTimeLockError('releaseAfter', releaseAfter, 'must be a valid Date.');
    }
    if (releaseAfter.getTime() <= now.getTime()) {
      throw new InvalidTimeLockError(
        'releaseAfter',
        releaseAfter,
        `must be in the future (received ${releaseAfter.toISOString()}).`,
      );
    }
    return BigInt(Math.floor(releaseAfter.getTime() / 1000));
  }
  return undefined;
}

/**
 * Validates that SDK beneficiaries (whole percentages, 0-100 scale) scale
 * cleanly to the contract's basis points and total exactly 100% (10_000 bp).
 * Throws {@link BeneficiaryValidationError} naming the scaled total when the
 * on-chain sum would be short (e.g. 0 after per-entry rounding) or otherwise
 * off — catching it here avoids a wasted signing round-trip that the contract
 * would reject with `InvalidPercentages`.
 *
 * Assumes structural validation (count, addresses, positive integers)
 * already passed via {@link validateBeneficiaries}.
 *
 * @since 0.1.2
 */
function assertBeneficiaryBasisPointsTotal(beneficiaries: Beneficiary[], method: string): void {
  const totalBp = beneficiaries.reduce(
    (acc, b) => acc + b.percentage * PERCENT_TO_BASIS_POINTS,
    0,
  );
  if (totalBp !== TOTAL_BASIS_POINTS) {
    throw new BeneficiaryValidationError(
      `Invalid beneficiaries for ${method}: percentages scale to ${totalBp} basis points ` +
        `but must total exactly ${TOTAL_BASIS_POINTS} (100%).`,
    );
  }
}

/**
 * Validates beneficiary list length, per-beneficiary percentage bounds (0 < p <= 100),
 * exact 100% sum, and basis-point scaling, throwing a descriptive
 * {@link BeneficiaryValidationError} identifying which check failed.
 */
function assertValidBeneficiaryPercentages(beneficiaries: readonly Beneficiary[], method: string): void {
  if (beneficiaries.length === 0 || beneficiaries.length > MAX_BENEFICIARIES) {
    throw new BeneficiaryValidationError(
      `Invalid beneficiaries for ${method}: received ${beneficiaries.length} entries, ` +
        `must be between 1 and ${MAX_BENEFICIARIES}.`,
    );
  }
  for (let i = 0; i < beneficiaries.length; i += 1) {
    const b = beneficiaries[i]!;
    if (typeof b.percentage !== 'number' || !Number.isFinite(b.percentage) || b.percentage <= 0 || b.percentage > 100) {
      throw new BeneficiaryValidationError(
        `Invalid beneficiaries for ${method}: beneficiary at index ${i} (${b.address}) has ` +
          `invalid percentage ${String(b.percentage)}. Each percentage must be > 0 and <= 100.`,
      );
    }
  }
  const sum = beneficiaries.reduce((acc, b) => acc + b.percentage, 0);
  if (Math.abs(sum - 100) >= PERCENTAGE_SUM_EPSILON) {
    throw new BeneficiaryValidationError(
      `Invalid beneficiaries for ${method}: beneficiary percentages sum to ${sum}, ` +
        'but must sum to exactly 100.',
    );
  }
  assertBeneficiaryBasisPointsTotal([...beneficiaries], method);
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
 *
 * Transaction source addresses must be valid Stellar account public keys and
 * already funded with XLM on the selected network to cover the minimum account
 * reserve and transaction fees. Unfunded wallets can raise
 * {@link AccountNotFundedError}. On testnet, use
 * {@link https://friendbot.stellar.org | Friendbot} for free test XLM.
 * On mainnet, transfer real XLM to the address before submitting transactions.
 * Invalid keys raise {@link InvalidPublicKeyError} before signing or account lookup.
 *
 * @see https://developers.stellar.org/docs/learn/fundamentals/lumens
 */

/**
 * Validates that a contract ID has the correct format for Stellar contracts.
 *
 * Throws {@link InvalidContractIdError} if the contract ID is missing, not a
 * string, or does not match the Stellar contract ID format (StrKey encoding
 * starting with 'C'). This allows configuration errors to be caught during
 * client initialization rather than on the first operation.
 *
 * @param contractId - The contract ID to validate.
 * @throws InvalidContractIdError when the contract ID format is invalid.
 *
 * @example
 * ```ts
 * // Validates during client construction
 * try {
 *   const client = new SoroWillClient({
 *     network: 'testnet',
 *     contractId: 'INVALID',  // Bad format
 *   });
 * } catch (error) {
 *   if (error instanceof InvalidContractIdError) {
 *     console.error('Configuration error:', error.message);
 *     // Client is never created, so no risk of cryptic errors on first operation
 *   }
 * }
 * ```
 */
function validateContractIdFormat(contractId: unknown): asserts contractId is string {
  if (typeof contractId !== 'string' || !StrKey.isValidContract(contractId)) {
    throw new InvalidContractIdError(String(contractId ?? ''));
  }
}

/** Returns `true` when `value` is an absolute `http(s)://` URL. */
function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() === '') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Returns `true` when `value` is an absolute `wss://` URL. */
function isSecureWebSocketUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() === '') return false;
  try {
    return new URL(value).protocol === 'wss:';
  } catch {
    return false;
  }
}

function assertOptionalBoolean(option: string, value: unknown): void {
  if (value !== undefined && typeof value !== 'boolean') {
    throw new SoroWillConfigError(option, 'must be a boolean.', value);
  }
}

function assertOptionalPositiveInteger(option: string, value: unknown): void {
  if (value === undefined) return;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new SoroWillConfigError(option, 'must be a positive integer.', value);
  }
}

function assertOptionalPositiveNumber(option: string, value: unknown): void {
  if (value === undefined) return;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new SoroWillConfigError(option, 'must be a finite number greater than zero.', value);
  }
}

function assertOptionalHttpUrl(option: string, value: unknown): void {
  if (value === undefined) return;
  if (!isHttpUrl(value)) {
    throw new SoroWillConfigError(
      option,
      'must be an absolute http:// or https:// URL (for example "https://soroban-testnet.stellar.org").',
      value,
    );
  }
}

/**
 * Validates every option passed to the {@link SoroWillClient} constructor
 * (#798). Throws a {@link SoroWillConfigError} naming the offending option and
 * why it was rejected, so misconfiguration fails fast at init instead of
 * surfacing as a cryptic error on the first RPC call.
 *
 * @param options - The raw constructor options.
 * @throws {SoroWillConfigError} when any option is invalid.
 */
function validateClientOptions(options: SoroWillClientOptions): void {
  if (options === null || typeof options !== 'object') {
    throw new SoroWillConfigError(
      'options',
      'a configuration object is required, e.g. { network: "testnet", contractId: "C..." }.',
      options,
    );
  }

  if (options.network !== 'testnet' && options.network !== 'mainnet') {
    throw new SoroWillConfigError(
      'network',
      `must be one of "testnet" or "mainnet" (received ${JSON.stringify(options.network)}).`,
      options.network,
    );
  }

  validateContractIdFormat(options.contractId);

  assertOptionalHttpUrl('rpcUrl', options.rpcUrl);
  assertOptionalHttpUrl('eventRpcUrl', options.eventRpcUrl);

  if (options.rpcUrls !== undefined) {
    if (!Array.isArray(options.rpcUrls) || options.rpcUrls.length === 0) {
      throw new SoroWillConfigError(
        'rpcUrls',
        'must be a non-empty array of http:// or https:// URLs.',
        options.rpcUrls,
      );
    }
    options.rpcUrls.forEach((url, index) => {
      if (!isHttpUrl(url)) {
        throw new SoroWillConfigError(
          `rpcUrls[${index}]`,
          'must be an absolute http:// or https:// URL.',
          url,
        );
      }
    });
  }

  if (options.eventStreamUrl !== undefined && !isSecureWebSocketUrl(options.eventStreamUrl)) {
    throw new InvalidWebSocketUrlError(String(options.eventStreamUrl));
  }

  if (options.networkPassphrase !== undefined) {
    if (typeof options.networkPassphrase !== 'string' || options.networkPassphrase.trim() === '') {
      throw new SoroWillConfigError(
        'networkPassphrase',
        'must be a non-empty string (for example "Test SDF Network ; September 2015").',
        options.networkPassphrase,
      );
    }
  }

  if (options.expectedContractVersion !== undefined) {
    if (
      typeof options.expectedContractVersion !== 'string' ||
      options.expectedContractVersion.trim() === ''
    ) {
      throw new SoroWillConfigError(
        'expectedContractVersion',
        'must be a non-empty version string (for example "1.2.0").',
        options.expectedContractVersion,
      );
    }
  }

  assertOptionalPositiveInteger('pollAttempts', options.pollAttempts);
  assertOptionalPositiveInteger('maxConcurrentRequests', options.maxConcurrentRequests);
  assertOptionalPositiveInteger('requestsPerSecond', options.requestsPerSecond);
  assertOptionalPositiveInteger('maxQueueSize', options.maxQueueSize);
  assertOptionalPositiveNumber('timeoutMs', options.timeoutMs);
  assertOptionalPositiveNumber('defaultPollIntervalMs', options.defaultPollIntervalMs);
  assertOptionalPositiveNumber('transactionTimeoutSeconds', options.transactionTimeoutSeconds);

  if (options.specCacheTtlMs !== undefined && options.specCacheTtlMs !== Infinity) {
    assertOptionalPositiveNumber('specCacheTtlMs', options.specCacheTtlMs);
  }

  assertOptionalBoolean('readOnly', options.readOnly);
  assertOptionalBoolean('debug', options.debug);
  assertOptionalBoolean('deepFreeze', options.deepFreeze);
  assertOptionalBoolean('deduplicateReads', options.deduplicateReads);
  assertOptionalBoolean('autoFeeBumpOnTimeout', options.autoFeeBumpOnTimeout);
  assertOptionalBoolean('requireWalletNetwork', options.requireWalletNetwork);
  assertOptionalBoolean('checkHealthOnStartup', options.checkHealthOnStartup);

  if (options.readCache !== undefined && options.readCache !== false) {
    if (typeof options.readCache !== 'object' || options.readCache === null) {
      throw new SoroWillConfigError(
        'readCache',
        'must be a ReadCacheOptions object or false to disable caching.',
        options.readCache,
      );
    }
  }

  if (options.retry !== undefined) {
    if (typeof options.retry !== 'object' || options.retry === null) {
      throw new SoroWillConfigError(
        'retry',
        'must be a partial RpcRetryOptions object.',
        options.retry,
      );
    }
    const { maxAttempts, initialDelayMs, maxDelayMs, backoffFactor } = options.retry;
    if (maxAttempts !== undefined) {
      assertOptionalPositiveInteger('retry.maxAttempts', maxAttempts);
    }
    if (initialDelayMs !== undefined) {
      if (typeof initialDelayMs !== 'number' || !Number.isFinite(initialDelayMs) || initialDelayMs < 0) {
        throw new SoroWillConfigError(
          'retry.initialDelayMs',
          'must be a finite, non-negative number.',
          initialDelayMs,
        );
      }
    }
    if (maxDelayMs !== undefined) {
      if (typeof maxDelayMs !== 'number' || !Number.isFinite(maxDelayMs) || maxDelayMs < 0) {
        throw new SoroWillConfigError(
          'retry.maxDelayMs',
          'must be a finite, non-negative number.',
          maxDelayMs,
        );
      }
    }
    if (backoffFactor !== undefined) {
      if (typeof backoffFactor !== 'number' || !Number.isFinite(backoffFactor) || backoffFactor < 1) {
        throw new SoroWillConfigError(
          'retry.backoffFactor',
          'must be a finite number of at least 1.',
          backoffFactor,
        );
      }
    }
  }

  if (options.fetch !== undefined && typeof options.fetch !== 'function') {
    throw new SoroWillConfigError('fetch', 'must be a fetch-compatible function.', options.fetch);
  }
  if (options.webSocketFactory !== undefined && typeof options.webSocketFactory !== 'function') {
    throw new SoroWillConfigError(
      'webSocketFactory',
      'must be a function that returns a WebSocket-like object.',
      options.webSocketFactory,
    );
  }
}

/** How long {@link SoroWillClient.willStatus} may serve a cached status (#726). */
const WILL_STATUS_CACHE_TTL_MS = 30_000;

/** How long {@link SoroWillClient.getContractVersion} may serve a cached version (#792). */
const CONTRACT_VERSION_CACHE_TTL_MS = 60 * 60 * 1000;

/** Maximum number of items accepted by the batch helpers (#727). */
const MAX_BATCH_OPERATIONS = 25;

/**
 * Per-item outcome of {@link SoroWillClient.batchCreateWill} and
 * {@link SoroWillClient.batchCheckIn}. `index` is the item's position in the input.
 */
export type BatchItemResult<T> =
  | { readonly index: number; readonly status: 'success'; readonly value: T }
  | { readonly index: number; readonly status: 'error'; readonly error: Error };

function assertBatchSize(length: number, method: string): void {
  if (length === 0) {
    throw new SoroWillError(`${method} requires at least one item.`);
  }
  if (length > MAX_BATCH_OPERATIONS) {
    throw new SoroWillError(
      `${method} accepts at most ${MAX_BATCH_OPERATIONS} items but received ${length}.`,
    );
  }
}

/** A single beneficiary's previewed share of a will's distribution. */
export interface BeneficiaryDistributionPreview {
  /** The beneficiary's Stellar address. */
  address: string;
  /** The beneficiary's share, in percent (0-100), as stored on the will. */
  percentage: number;
  /** The beneficiary's final amount, in the token's smallest unit (stroops). */
  amount: bigint;
}

/** Result of {@link SoroWillClient.previewDistribution}. */
export interface DistributionPreview {
  /** Total amount being distributed, in the token's smallest unit (stroops). */
  totalAmount: bigint;
  /** Per-beneficiary amounts, in the same order as the will's beneficiaries. */
  distributions: BeneficiaryDistributionPreview[];
  /** Sum of all previewed amounts; equals `totalAmount` (rounding remainder is assigned). */
  distributedAmount: bigint;
}

/**
 * Split `totalAmount` across beneficiaries by percentage, in integer units.
 *
 * Uses largest-remainder rounding so the parts always sum exactly to
 * `totalAmount`: each share is floored, then the leftover units are handed out
 * one at a time to the beneficiaries with the largest fractional remainders
 * (ties broken by original order). Percentages are converted to basis points
 * (×100) to match the on-chain representation.
 */
export function computeDistributionPreview(
  totalAmount: bigint,
  beneficiaries: ReadonlyArray<{ address: string; percentage: number }>,
): DistributionPreview {
  if (totalAmount < 0n) {
    throw new RangeError('totalAmount must be non-negative');
  }
  const total = BigInt(totalAmount);
  const basisPoints = beneficiaries.map((b) => BigInt(Math.round(b.percentage * 100)));
  const totalBasisPoints = basisPoints.reduce((sum, bp) => sum + bp, 0n);

  const amounts: bigint[] = [];
  const remainders: { index: number; remainder: bigint }[] = [];
  let distributed = 0n;

  for (let i = 0; i < beneficiaries.length; i += 1) {
    const bp = basisPoints[i] ?? 0n;
    const numerator = total * bp;
    const share = totalBasisPoints === 0n ? 0n : numerator / totalBasisPoints;
    amounts.push(share);
    distributed += share;
    remainders.push({
      index: i,
      remainder: totalBasisPoints === 0n ? 0n : numerator % totalBasisPoints,
    });
  }

  let leftover = total - distributed;
  if (leftover > 0n) {
    remainders.sort((a, b) => {
      if (a.remainder === b.remainder) return a.index - b.index;
      return a.remainder > b.remainder ? -1 : 1;
    });
    for (const { index } of remainders) {
      if (leftover === 0n) break;
      amounts[index] = (amounts[index] ?? 0n) + 1n;
      leftover -= 1n;
    }
  }

  return {
    totalAmount: total,
    distributions: beneficiaries.map((b, i) => ({
      address: b.address,
      percentage: b.percentage,
      amount: amounts[i] ?? 0n,
    })),
    distributedAmount: amounts.reduce((sum, amount) => sum + amount, 0n),
  };
}

export class SoroWillClient {
  private readonly server: SoroWillRpcServer;
  private readonly rpcPool: RpcEndpointPool;
  private readonly contract: Contract;
  private readonly networkPassphrase: string;
  private lastWalletNetworkPassphrase: string;
  private readonly network: SoroWillNetwork;
  private readonly hooks: HookManager;
  private readonly wallet: WalletAdapter;
  private readonly pollAttempts: number;
  private readonly specOverride: ContractSpecLike | Promise<ContractSpecLike> | undefined;
  private readonly specJsonOverride: Uint8Array | undefined;
  private eventSubscription?: WillEventSubscription | undefined;
  private readonly eventSource?: WillEventSource | undefined;
  private readonly eventRpcUrl: string;
  private readonly eventStreamUrl: string | undefined;
  private readonly eventSseUrl: string | undefined;
  private readonly defaultPollIntervalMs: number;
  private readonly webSocketFactory: ((url: string) => WebSocketLike) | undefined;
  private readonly fetchImpl: FetchImplementation;
  private readonly queue: RequestQueue;
  /** Tail of the per-account write chain; see {@link SoroWillClient.serializeWrite}. */
  private writeChain: Promise<unknown> = Promise.resolve();
  private readonly inFlightTracker: InFlightTracker;
  private readonly timeoutMs: number;
  private readonly readCache: ReadCache | undefined;
  private readonly deduplicateReads: boolean;
  /** Per-will status cache backing {@link SoroWillClient.willStatus} (#726). */
  private readonly statusCache = new Map<string, { status: WillStatus; expiresAt: number }>();
  /** Cached deployed contract version backing {@link SoroWillClient.getContractVersion} (#792). */
  private contractVersionCache: { version: string; expiresAt: number } | undefined;
  /**
   * Read simulations currently in flight, keyed by method + arguments +
   * request options, so identical concurrent reads share one RPC call (#619).
   */
  private readonly inFlightReads = new Map<string, Promise<unknown>>();
  private readonly retryOptions: RpcRetryOptions;
  private specPromise: Promise<InstanceType<typeof Spec>> | undefined;
  /**
   * Wall-clock timestamp (ms) when the spec was last successfully resolved.
   * Used together with `specCacheTtlMs` to expire and re-fetch the spec
   * after a contract upgrade (#502).
   */
  private specResolvedAt: number | undefined;
  /**
   * Per-network cache for fee stats results. Keyed by network passphrase so
   * that switching networks (e.g. testnet → mainnet mid-session) never returns
   * stale fees from the previous network (#500).
   */
  private feeStatsCache: Map<string, rpc.Api.GetFeeStatsResponse>;
  private lastFeeStatsCachedPassphrase: string | undefined;
  private readonly debug: boolean;
  private readonly debugLogger: DebugLogger;
  private readonly autoFeeBumpOnTimeout: boolean;
  private readonly transactionTimeoutSeconds: number;
  private readonly deepFreeze: boolean;
  private readonly readOnly: boolean;
  /**
   * How long (in milliseconds) the lazily-fetched contract spec is considered
   * fresh. After this TTL elapses the next call will re-fetch the spec from the
   * RPC node, picking up any changes introduced by a contract upgrade (#502).
   *
   * `Infinity` (the default) keeps the behaviour from SDK ≤ 0.1.1: the spec is
   * fetched once per client instance and never re-fetched automatically.
   * Explicit `spec`/`specJson` overrides are always treated as permanent and are
   * not subject to TTL expiry.
   */
  private readonly specCacheTtlMs: number;
  /**
   * Tracks hashes of transactions that have been signed by this client to
   * prevent duplicate signing (and thus duplicate submissions) of the same
   * transaction (#573). A transaction's hash is determined by its contents
   * (source account, sequence number, operations, fee, timeout) and is
   * identical before and after signing, so we can detect duplicates prior to
   * sending the signed envelope to the wallet.
   */
  private readonly signedTransactionHashes: Set<string>;
  private stopWatchingWalletNetwork?: (() => void) | undefined;
  private lastKnownPublicKey?: string | undefined;
  private specVersion: ContractSpecVersion | null = null;
  private expectedContractVersion?: string | undefined;
  private warnedSpecVersions: Set<string> = new Set();
  private requireWalletNetwork: boolean = false;
  private readonly lifecycleEvents: SoroWillEventEmitter;

  constructor(options: SoroWillClientOptions) {
    // Validate the whole configuration on initialization (#798, #626).
    // This catches configuration errors early, before the first operation.
    validateClientOptions(options);

    const config = NETWORK_CONFIG[options.network];
    const rpcUrl = options.rpcUrl ?? config.rpcUrls[0]!;

    // #153: Wrap the underlying Contract constructor error with a clear SDK-level
    // error so callers see a SoroWill-specific message rather than a raw StrKey
    // decoding failure.
    try {
      this.contract = new Contract(options.contractId);
    } catch (originalError) {
      throw new InvalidContractIdError(options.contractId ?? '', { cause: originalError });
    }

    this.server =
      options.rpcServer ??
      new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith('http://') });
    this.networkPassphrase = options.networkPassphrase ?? config.networkPassphrase;
    this.lastWalletNetworkPassphrase = this.networkPassphrase;
    this.network = options.network;
    this.hooks = options.hooks ?? new HookManager();
    this.readOnly = options.readOnly ?? false;
    this.wallet = this.readOnly
      ? // In read-only mode, provide a no-op stub so write methods can throw
        // ReadOnlyModeError before ever touching the wallet.
        (options.wallet ?? {
          isConnected: async () => false,
          connect: async () => { throw new ReadOnlyModeError('connect'); },
          reconnect: async () => { throw new ReadOnlyModeError('reconnect'); },
          disconnect: async () => undefined,
          getPublicKey: async () => { throw new ReadOnlyModeError('getPublicKey'); },
          signTransaction: async () => { throw new ReadOnlyModeError('signTransaction'); },
        } as WalletAdapter)
      : (options.wallet ?? getDefaultWalletAdapter());
    this.requireWalletNetwork = options.requireWalletNetwork ?? false;
    this.lifecycleEvents = options.events ?? new SoroWillEventEmitter();
    this.pollAttempts = options.pollAttempts ?? DEFAULT_POLL_ATTEMPTS;
    if (!Number.isInteger(this.pollAttempts) || this.pollAttempts <= 0) {
      throw new RangeError('pollAttempts must be a positive integer');
    }
    this.specOverride = options.spec;
    this.specJsonOverride = options.specJson;
    this.eventRpcUrl = options.eventRpcUrl ?? rpcUrl;
    this.eventStreamUrl = options.eventStreamUrl;
    this.eventSseUrl = options.eventSseUrl;
    if (this.eventStreamUrl !== undefined) {
      if (!this.eventStreamUrl.startsWith('wss://')) {
        throw new InvalidWebSocketUrlError(this.eventStreamUrl);
      }
    }
    this.defaultPollIntervalMs = options.defaultPollIntervalMs ?? 5_000;
    if (!Number.isFinite(this.defaultPollIntervalMs) || this.defaultPollIntervalMs <= 0) {
      throw new RangeError('defaultPollIntervalMs must be a finite number greater than zero');
    }
    this.webSocketFactory = options.webSocketFactory;
    this.fetchImpl = options.fetch ?? fetch;

    const poolRpcUrls =
      options.rpcUrls ?? (options.rpcUrl ? [options.rpcUrl, ...config.rpcUrls] : config.rpcUrls);
    this.rpcPool = new RpcEndpointPool(poolRpcUrls, options.rpcServer);
    if (!options.rpcServer && options.checkHealthOnStartup !== false) {
      void this.rpcPool.checkEndpointsHealth().catch(() => {});
    }
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
      ...(options.maxQueueSize === undefined
        ? {}
        : { maxQueueSize: options.maxQueueSize }),
    });
    this.inFlightTracker =
      options.inFlightTracker ??
      // Default: a private tracker scoped to this contract's address so that
      // different client instances targeting different contracts never share a
      // dedup entry for the same (willId, method) pair (#503).
      new InFlightTracker(options.contractId);
    // #573: Track signed transaction hashes to prevent duplicate signing.
    this.signedTransactionHashes = new Set();
    this.readCache = options.readCache === false ? undefined : new ReadCache(options.readCache);
    this.deduplicateReads = options.deduplicateReads ?? true;
    this.retryOptions = { ...DEFAULT_RETRY_OPTIONS, ...options.retry };
    const { maxAttempts, initialDelayMs, maxDelayMs, backoffFactor } = this.retryOptions;
    if (!Number.isInteger(maxAttempts) || maxAttempts <= 0) {
      throw new RangeError('retry.maxAttempts must be a positive integer');
    }
    if (!Number.isFinite(initialDelayMs) || initialDelayMs < 0) {
      throw new RangeError('retry.initialDelayMs must be a finite, non-negative number');
    }
    if (!Number.isFinite(maxDelayMs) || maxDelayMs < 0) {
      throw new RangeError('retry.maxDelayMs must be a finite, non-negative number');
    }
    if (!Number.isFinite(backoffFactor) || backoffFactor < 1) {
      throw new RangeError('retry.backoffFactor must be a finite number of at least 1');
    }
    this.debug = options.debug ?? false;
    this.debugLogger = new DebugLogger(this.debug);
    this.autoFeeBumpOnTimeout = options.autoFeeBumpOnTimeout ?? false;
    this.transactionTimeoutSeconds = options.transactionTimeoutSeconds ?? 30;
    if (!Number.isFinite(this.transactionTimeoutSeconds) || this.transactionTimeoutSeconds <= 0) {
      throw new RangeError('transactionTimeoutSeconds must be a finite number greater than zero');
    }
    this.deepFreeze = options.deepFreeze ?? false;

    this.specCacheTtlMs = options.specCacheTtlMs ?? Infinity;
    this.expectedContractVersion = options.expectedContractVersion;
    if (this.specCacheTtlMs !== Infinity && (!Number.isFinite(this.specCacheTtlMs) || this.specCacheTtlMs <= 0)) {
      throw new RangeError('specCacheTtlMs must be a finite number greater than zero, or Infinity');
    }

    this.feeStatsCache = new Map();

    // Scope cached reads to the configured network, and drop them whenever the
    // wallet reports a network switch so testnet data is never served after
    // switching to mainnet (or vice versa) (#603).
    this.readCache?.setNetwork(this.networkPassphrase);
    this.stopWatchingWalletNetwork = this.wallet.onNetworkChange?.(({ networkPassphrase }) => {
      this.handleNetworkChange(networkPassphrase);
    });

    this.eventSource = options.eventSource;
    if (this.readCache && options.eventSource) {
      // Subscribe and automatically clean up the listener if setup throws.
      // Without this guard, a thrown error during subscribe leaves an orphaned
      // listener attached to the event source, causing memory leaks and stale
      // event deliveries on every subsequent subscription attempt (issue #484).
      let subscription: WillEventSubscription | undefined;
      try {
        subscription = options.eventSource.subscribe((event) => {
          void this.readCache?.invalidateByWillId(event.willId);
        });
        this.eventSubscription = subscription;
      } catch (err) {
        // If a partial subscription was registered before the error, clean it
        // up before re-throwing so no orphaned listeners remain.
        if (subscription !== undefined) {
          try {
            unsubscribeFromWillEvents(subscription);
          } catch {
            // Best-effort cleanup; swallow secondary errors.
          }
        }
        throw err;
      }
    }

    this.lifecycleEvents.emit('init', {
      network: this.network,
      contractId: options.contractId,
      readOnly: this.readOnly,
    });
  }

  // -----------------------------------------------------------------------
  // Lifecycle events (#786)
  // -----------------------------------------------------------------------

  /**
   * Registers a listener for SDK lifecycle events (`init`, `connect`,
   * `disconnect`, `error`). Pass `'*'` to receive every event.
   *
   * @returns An unsubscribe function.
   *
   * @example
   * ```ts
   * const off = client.on('error', (event) => console.warn(event.type, event.error));
   * // later
   * off();
   * ```
   */
  on(
    type: SoroWillLifecycleEvent | '*',
    listener: (event: SoroWillLifecycleEvent) => void,
  ): () => void {
    return this.lifecycleEvents.on(type, listener);
  }

  /** Removes a previously registered lifecycle listener. */
  off(type: SoroWillLifecycleEvent | '*', listener: (event: SoroWillLifecycleEvent) => void): void {
    this.lifecycleEvents.off(type, listener);
  }

  /** Registers a listener that fires at most once for the given event type. */
  once(
    type: SoroWillLifecycleEvent | '*',
    listener: (event: SoroWillLifecycleEvent) => void,
  ): () => void {
    return this.lifecycleEvents.once(type, listener);
  }

  // -----------------------------------------------------------------------
  // Static factory
  // -----------------------------------------------------------------------

  /**
   * Constructs a client from environment variables.
   *
   * **Operation Type:** Read-only (Factory)
   *
   * @readonly
   * @remarks Factory method that constructs a client instance without modifying ledger state or submitting transactions.
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
   * @param env - Optional environment object (defaults to `process.env`).
   * @returns A new configured `SoroWillClient` instance.
   * @throws {Error} If `SOROWILL_NETWORK` is not `"testnet"` or `"mainnet"`.
   * @throws {Error} If `SOROWILL_CONTRACT_ID` is not set.
   *
   * @example
   * ```ts
   * // Loads settings from environment variables:
   * const client = SoroWillClient.fromEnv();
   * ```
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
    if (pollInterval !== undefined && (!Number.isFinite(pollInterval) || pollInterval <= 0)) {
      throw new Error('SOROWILL_EVENTS_POLL_INTERVAL_MS must be a finite positive number');
    }

    return new SoroWillClient({
      network,
      contractId,
      ...(env.SOROWILL_RPC_URL ? { rpcUrl: env.SOROWILL_RPC_URL } : {}),
      ...(env.SOROWILL_NETWORK_PASSPHRASE ? { networkPassphrase: env.SOROWILL_NETWORK_PASSPHRASE } : {}),
      ...(env.SOROWILL_EVENT_RPC_URL ? { eventRpcUrl: env.SOROWILL_EVENT_RPC_URL } : {}),
      ...(env.SOROWILL_EVENT_STREAM_URL ? { eventStreamUrl: env.SOROWILL_EVENT_STREAM_URL } : {}),
      ...(pollInterval !== undefined ? { defaultPollIntervalMs: pollInterval } : {}),
    });
  }

  /**
   * Convenience constructor that targets a known network using the
   * **maintainer-managed default contract address** for that network.
   *
   * **Operation Type:** Read-only (Factory)
   *
   * @readonly
   * @remarks Factory method that constructs a client instance targeting a standard network without modifying ledger state.
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
   * https://github.com/SoroWill/sorowill-contracts/tree/main/deployments
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

  /**
   * Creates a `SoroWillClient` pre-wired for unit testing and dependency
   * injection without any global state mutation (#516).
   *
   * Accepts the same options as the constructor, but applies test-friendly
   * defaults — most importantly it does **not** require a real RPC server or
   * a connected wallet.
   *
   * ### Why this exists
   *
   * The standard constructor wires up production defaults (Freighter wallet,
   * real RPC server, etc.) that are unavailable in a test environment. Callers
   * end up patching global state or importing mocks at module level to work
   * around this. `createTestClient` makes the dependency surface explicit: you
   * supply exactly the collaborators your test needs, and the factory fills in
   * safe no-op stubs for everything else.
   *
   * @example
   * ```ts
   * import { SoroWillClient } from '@sorowill/sdk';
   * import { vi } from 'vitest';
   *
   * const mockServer = {
   *   getAccount: vi.fn(),
   *   simulateTransaction: vi.fn(),
   *   prepareTransaction: vi.fn(),
   *   sendTransaction: vi.fn(),
   *   pollTransaction: vi.fn(),
   *   getContractWasmByContractId: vi.fn(),
   * };
   *
   * const mockWallet = {
   *   isConnected: vi.fn().mockResolvedValue(true),
   *   connect: vi.fn(),
   *   reconnect: vi.fn(),
   *   disconnect: vi.fn(),
   *   getPublicKey: vi.fn().mockResolvedValue('GTESTKEY...'),
   *   signTransaction: vi.fn(),
   * };
   *
   * const client = SoroWillClient.createTestClient({
   *   rpcServer: mockServer,
   *   wallet: mockWallet,
   * });
   * ```
   *
   * @param overrides - Optional partial options. Any value not supplied here
   *   gets a safe stub so the client can be constructed without real
   *   infrastructure.
   */
  static createTestClient(
    overrides: Partial<SoroWillClientOptions> & {
      /** Override for the RPC server — pass a vi.fn() mock object in tests. */
      rpcServer?: SoroWillRpcServer;
    } = {},
  ): SoroWillClient {
    const network: SoroWillNetwork = overrides.network ?? 'testnet';
    // Use the testnet default contract id as a valid placeholder; tests that
    // exercise contract-id validation should pass their own value.
    const contractId =
      overrides.contractId ?? DEFAULT_CONTRACT_IDS.testnet;

    return new SoroWillClient({
      network,
      contractId,
      // Disable read-caching by default so tests don't share stale state.
      readCache: false,
      // Apply caller overrides last so they take precedence over the stubs above.
      ...overrides,
    });
  }

  // -----------------------------------------------------------------------
  // Public: state-changing methods
  // -----------------------------------------------------------------------

  /**
   * Locks `params.amount` of `params.token` and creates a new will.
   *
   * **Operation Type:** Write (State-changing)
   *
   * @remarks State-changing write operation. Builds, signs, and submits an on-chain transaction that modifies
   * ledger state to create a new inheritance will. Requires a connected wallet to sign and consumes transaction fees.
   *
   * @param params - Configuration parameters for creating the will.
   * @param options - Optional request timeout and signal options.
   * @returns The newly created will's ID and the transaction hash.
   * @throws {SoroWillError} If the transaction simulation fails or returns no result.
   * @throws {RequestTimeoutError} If the RPC request exceeds its configured timeout.
   * @throws {WillContractError} Mapped contract-level errors (e.g. InvalidPercentagesError,
   *   TooManyBeneficiariesError, ZeroAmountError).
   * @throws {InvalidBeneficiaryAddressError} If a beneficiary address is not a valid
   *   Stellar account address (`G...`).
   * @throws {Error} If the wallet is not connected or fails to sign.
   *
   * @example
   * ```ts
   * const { willId, txHash } = await client.createWill({
   *   token: 'CDLZ...',
   *   amount: '10000000',
   *   beneficiaries: [{ address: 'GBEN...', percentage: 100 }],
   *   checkinPeriodDays: 90,
   *   gracePeriodDays: 14,
   *   guardians: [],
   * });
   * console.log(`Created will ${willId} in transaction ${txHash}`);
   * ```
   */
  async createWill(
    params: CreateWillParams,
    options?: RequestOptions,
  ): Promise<{ willId: string; txHash: string }> {
    const beneficiaries = [...params.beneficiaries];
    assertValidBeneficiaryAddresses(beneficiaries);
    if (hasDuplicateBeneficiaries(beneficiaries)) {
      throw new BeneficiaryValidationError('Invalid beneficiaries: duplicate beneficiary addresses are not allowed.');
    }
    assertValidBeneficiaryPercentages(beneficiaries, 'createWill');
    // #156: Validate guardians count synchronously before any RPC round-trip.
    if (params.guardians.length > MAX_GUARDIANS) {
      throw new TooManyGuardiansError(params.guardians.length, MAX_GUARDIANS);
    }
    if (!StrKey.isValidContract(params.token)) {
      throw new InvalidContractIdError(params.token);
    }
    // #537: fail fast when the check-in deadline would outlive the will
    // entry's storage TTL (archived before it can be triggered).
    validateCheckinPeriodDays(params.checkinPeriodDays);
    // #699: Validate balance/amount > 0 synchronously before wallet/RPC calls.
    const amount = validateAmount(params.amount);
    await this.assertWalletNetwork({ networkPassphrase: this.networkPassphrase });
    const owner = await this.getWalletPublicKey();
    const seenGuardians = new Set<string>();
    for (const guardian of params.guardians) {
      if (!StrKey.isValidEd25519PublicKey(guardian)) {
        throw new GuardianValidationError('invalid_address', guardian);
      }
      if (seenGuardians.has(guardian)) {
        throw new GuardianValidationError('duplicate', guardian);
      }
      if (guardian === owner) {
        throw new GuardianValidationError('owner_is_guardian', guardian);
      }
      seenGuardians.add(guardian);
    }
    const { txHash, returnValue } = await this.invoke(
      'create_will',
      {
        owner,
        token: params.token,
        amount,
        beneficiaries: toContractBeneficiaries(beneficiaries),
        checkin_period_days: validateCheckinPeriodDays(params.checkinPeriodDays),
        grace_period_days: validateDays(params.gracePeriodDays, 'gracePeriodDays'),
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

  /**
   * Adds funds to an existing will without replacing its configuration.
   *
   * Supports incremental partial top-ups: each call transfers exactly
   * `amount` (in stroops) from the connected wallet to the will's token
   * balance and returns the resulting balance.
   *
   * @param willId - The will to fund.
   * @param amount - Amount to add, in stroops. Must be greater than zero.
   * @param options - Optional request options (timeouts, retries, hooks).
   * @returns The transaction hash, the funded amount and the new will balance.
   * @throws {SoroWillError} If the transaction simulation/submission fails.
   * @throws {WillNotFoundError} If the will does not exist.
   */
  async fundWill(
    willId: string,
    amount: bigint | number | string,
    options?: RequestOptions,
  ): Promise<{ txHash: string; amount: bigint; newBalance: bigint }> {
    const normalizedWillId = validateWillId(willId);
    const fundAmount = validateAmount(amount);
    await this.assertWalletNetwork({ networkPassphrase: this.networkPassphrase });
    const funder = await this.getWalletPublicKey();
    const { txHash } = await this.invoke(
      'fund_will',
      {
        funder,
        will_id: normalizedWillId,
        amount: fundAmount,
      },
      options,
    );
    const will = await this.getWill(normalizedWillId, options);
    const newBalance = BigInt(will.amount);
    return { txHash, amount: fundAmount, newBalance };
  }

  /**
   * Resets the check-in countdown for `willId`.
   *
   * Before submitting, the will's existence is validated via `getWill()`
   * unless `options.skipExistenceCheck` is `true`. If the will does not
   * exist, a {@link WillNotFoundError} is thrown before any transaction is
   * built, avoiding wasted gas and fees.
   *
   * @returns The transaction hash and the next check-in deadline.
   * @throws {SoroWillError} If the transaction simulation/submission fails.
   * @throws {RequestTimeoutError} If the RPC request exceeds its configured timeout.
   * @throws {WillNotFoundError} If the will does not exist and `skipExistenceCheck` is not set.
   * @throws {Error} If the wallet is not connected or fails to sign.
   */
  async checkIn(
    willId: string,
    options?: RequestOptions,
  ): Promise<{ txHash: string; nextDeadline: Date }> {
    if (this.readOnly) {
      throw new ReadOnlyModeError('check_in');
    }
    parseWillId(willId);
    await this.assertWalletNetwork({ networkPassphrase: this.networkPassphrase });
    const owner = await this.getWalletPublicKey();
    // checkin_period_days is a stored will property not returned by the
    // contract's check_in function, so a separate getWill() read is
    // unavoidable in order to compute the nextDeadline return value.
    // This read also validates will existence, throwing WillNotFoundError
    // if the will is not found — before any gas is spent.
    let will: Awaited<ReturnType<typeof this.getWill>> | null = null;
    if (!options?.skipExistenceCheck) {
      will = await this.getWill(willId, options);
    }
    // If the will is in the Triggered state (grace period active), the contract
    // will reject check_in with WillNotActiveError. Detect this early and throw
    // a descriptive CheckInDuringGracePeriodError so callers know to use
    // emergencyCheckIn() instead.
    if (will?.status === WillStatus.Triggered) {
      const graceEndsAt =
        will.triggerTime === null
          ? undefined
          : new Date(will.triggerTime.getTime() + will.gracePeriodDays * 86_400_000);
      const nextDeadline = new Date(will.lastCheckin.getTime() + will.checkinPeriodDays * 86_400_000);
      throw new CheckInDuringGracePeriodError(willId, { graceEndsAt, nextDeadline });
    }
    const { txHash, createdAt } = await this.invoke(
      'check_in',
      { will_id: parseWillId(willId), owner },
      options,
    );
    return {
      txHash,
      nextDeadline: will
        ? new Date((createdAt + will.checkinPeriodDays * 86_400) * 1000)
        : new Date(createdAt * 1000),
    };
  }

  /**
   * Starts the grace period for `willId` once the check-in deadline has passed.
   *
   * **Operation Type:** Write (State-changing)
   *
   * @remarks State-changing write operation. Builds, signs, and submits an on-chain transaction that modifies
   * ledger state to transition the will from Active to Triggered. Requires a connected wallet to sign and consumes
   * transaction fees.
   *
   * @param willId - The identifier of the will to trigger.
   * @param options - Optional request options.
   * @returns The transaction hash.
   * @throws {SoroWillError} If the transaction simulation/submission fails.
   * @throws {RequestTimeoutError} If the RPC request exceeds its configured timeout.
   * @throws {WillNotFoundError} If the will does not exist.
   * @throws {CheckinNotDueError} If the check-in deadline has not passed.
   * @throws {Error} If the wallet is not connected or fails to sign.
   *
   * @example
   * ```ts
   * const { txHash } = await client.triggerWill('1');
   * console.log(`Will triggered in transaction: ${txHash}`);
   * ```
   */
  /**
   * Cancels an unconfirmed (still pending) transaction by replacing it with a
   * high-fee transaction that reuses the same source account and sequence
   * number (#788).
   *
   * **Operation Type:** Write (State-changing)
   *
   * @remarks Stellar has no "cancel" operation: a pending transaction is
   * cancelled by submitting a replacement with the same sequence number and a
   * fee at least 10x higher (the multiplier stellar-core requires). The
   * replacement carries a single `manage_data` operation with an empty value,
   * which is cheap and has no effect on the SoroWill contract, so the original
   * invocation can never be applied once the replacement is included.
   *
   * The replacement is built from the pending transaction's own sequence
   * number, so it is only valid while the original is still unconfirmed. If
   * the original has already been included in the ledger, a
   * {@link SoroWillError} is thrown instead of submitting a no-op.
   *
   * @param pendingTxHash - Hash of the unconfirmed transaction to cancel.
   * @param options - Optional per-call timeout and abort signal.
   * @returns The replacement transaction hash.
   * @throws {SoroWillError} If the pending transaction is already confirmed or
   *   the replacement could not be submitted.
   * @throws {RequestTimeoutError} If the RPC request exceeds its configured timeout.
   * @throws {Error} If the wallet is not connected or fails to sign.
   *
   * @example
   * ```ts
   * const { txHash } = await client.cancelPendingTransaction('abc123hash');
   * console.log(`Pending transaction replaced by: ${txHash}`);
   * ```
   */
  async cancelPendingTransaction(
    pendingTxHash: string,
    options?: RequestOptions,
  ): Promise<{ txHash: string }> {
    if (this.readOnly) {
      throw new ReadOnlyModeError('cancelPendingTransaction');
    }
    if (typeof pendingTxHash !== 'string' || pendingTxHash.trim() === '') {
      throw new SoroWillError(
        'Cannot cancel a pending transaction: a non-empty transaction hash is required.',
      );
    }
    const hash = pendingTxHash.trim();
    await this.assertWalletNetwork({ networkPassphrase: this.networkPassphrase });

    // Refuse to "cancel" a transaction that already reached the ledger: its
    // sequence number is consumed, so a replacement would be rejected.
    const existing = await this.rpc(
      () => this.rpcPool.withFailover((server) => server.getTransaction(hash)),
      options,
      'cancelPendingTransaction:getTransaction',
    );
    if (existing.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      throw new SoroWillError(
        'Cannot cancel a pending transaction: it has already been confirmed on-chain.',
      );
    }

    const publicKey = await this.getWalletPublicKey();
    const account = await this.rpc(
      () => this.rpcPool.withFailover((server) => server.getAccount(publicKey)),
      options,
      'cancelPendingTransaction:getAccount',
    );

    // The replacement must reuse the pending transaction's sequence number to
    // supersede it. The pending tx used `account.sequence + 1`; the account's
    // current sequence is that value once the original was accepted into the
    // mempool, so build from one below it.
    const replacementSequence = (BigInt(account.sequence) - 1n).toString();
    const source = new Account(publicKey, replacementSequence);
    const baseFee = BigInt(BASE_FEE);
    const replacementFee = (await this.computeBumpedFee(baseFee, options)).toString();

    const builder = new TransactionBuilder(source, {
      fee: replacementFee,
      networkPassphrase: this.networkPassphrase,
    });
    // A `manage_data` operation with an empty value is cheap and has no effect
    // on the SoroWill contract, so the replacement only consumes the pending
    // transaction's sequence number.
    builder.addOperation(
      stellarContract.Operation.manageData({
        name: 'sorowill-cancel',
        value: '',
      }),
    );

    const builtTx = builder.setTimeout(this.transactionTimeoutSeconds).build();
    this.assertTransactionNetwork(builtTx);

    const prepared = await this.rpc(
      () => this.rpcPool.withFailover((server) => server.prepareTransaction(builtTx)),
      options,
      'cancelPendingTransaction:prepareTransaction',
    );
    this.assertTransactionNetwork(prepared);

    const signedResponse = await this.wallet.signTransaction(prepared.toXDR(), {
      networkPassphrase: this.networkPassphrase,
    });
    const signedXdr = normalizeSignatureResponse(signedResponse);
    const signedTx = TransactionBuilder.fromXDR(signedXdr, this.networkPassphrase);
    if (!(signedTx instanceof Transaction)) {
      throw new SoroWillError(
        'Expected a plain Transaction envelope after signing the cancellation, but received FeeBumpTransaction',
      );
    }

    const sendResponse = await this.rpc(
      () => this.rpcPool.withFailover((server) => server.sendTransaction(signedTx)),
      options,
      'cancelPendingTransaction:sendTransaction',
    );
    if (sendResponse.status === 'ERROR') {
      throw new SoroWillError(
        'Failed to submit the replacement transaction that cancels the pending transaction. ' +
          'The pending transaction may have already been confirmed; check its status before retrying.',
      );
    }
    if (sendResponse.status === 'TRY_AGAIN_LATER') {
      throw new SoroWillError(
        'SoroWill RPC node is under backpressure — the cancellation transaction could not be submitted. Retry later.',
      );
    }

    this.debugLogger.logSubmission('cancelPendingTransaction', undefined, sendResponse.hash);
    return { txHash: sendResponse.hash };
  }

  async triggerWill(willId: string, options?: RequestOptions): Promise<{ txHash: string }> {
    parseWillId(willId);
    await this.assertWalletNetwork({ networkPassphrase: this.networkPassphrase });
    const { txHash } = await this.invoke('trigger_will', { will_id: parseWillId(willId) }, options);
    return { txHash };
  }

  /**
   * Cancels an in-progress trigger during the grace period, resetting the countdown.
   *
   * **Operation Type:** Write (State-changing)
   *
   * @remarks State-changing write operation. Builds, signs, and submits an on-chain transaction that modifies
   * ledger state to cancel a triggered will and reset its check-in countdown. Requires a connected wallet to sign
   * and incurs transaction fees. When guardian signature(s) are provided, validates their format before submission.
   *
   * @param willId - The identifier of the will to check in for.
   * @param options - Optional request options or {@link EmergencyCheckInOptions} containing guardian signatures.
   * @returns An object with the transaction hash and the next check-in deadline.
   * @throws {InvalidGuardianSignatureError} If a provided guardian signature is empty or malformed.
   * @throws {SoroWillInvalidIdError} If `willId` is not a valid non-negative integer string.
   * @throws {SoroWillError} If the transaction fails on-chain.
   *
   * @example
   * ```ts
   * // Standard emergency check-in by owner
   * const { txHash, nextDeadline } = await client.emergencyCheckIn('42');
   * console.log(`Emergency check-in confirmed: ${txHash}, next deadline: ${nextDeadline}`);
   *
   * // Emergency check-in with guardian signature
   * const { txHash } = await client.emergencyCheckIn('42', {
   *   guardianSignature: 'AAAA...',
   * });
   * ```
   */
  async emergencyCheckIn(
    willId: string,
    options?: EmergencyCheckInOptions,
  ): Promise<{ txHash: string; nextDeadline: Date }>;
  async emergencyCheckIn(
    willId: string,
    guardianSignature?: string,
    options?: RequestOptions,
  ): Promise<{ txHash: string; nextDeadline: Date }>;
  async emergencyCheckIn(
    willId: string,
    guardianSignatureOrOptions?: string | EmergencyCheckInOptions,
    options?: RequestOptions,
  ): Promise<{ txHash: string; nextDeadline: Date }> {
    parseWillId(willId);

    let guardianSig: string | undefined;
    let guardianSigs: string[] | undefined;
    let requestOptions: RequestOptions | undefined;

    if (typeof guardianSignatureOrOptions === 'string') {
      guardianSig = guardianSignatureOrOptions;
      requestOptions = options;
    } else if (typeof guardianSignatureOrOptions === 'object' && guardianSignatureOrOptions !== null) {
      guardianSig = guardianSignatureOrOptions.guardianSignature;
      guardianSigs = guardianSignatureOrOptions.guardianSignatures;
      requestOptions = guardianSignatureOrOptions;
    } else {
      requestOptions = options;
    }

    if (guardianSig !== undefined) {
      validateGuardianSignature(guardianSig);
    }
    if (guardianSigs !== undefined) {
      if (!Array.isArray(guardianSigs) || guardianSigs.length === 0) {
        throw new InvalidGuardianSignatureError(
          undefined,
          'Invalid guardian signature: guardianSignatures list must not be empty when provided.',
        );
      }
      for (const sig of guardianSigs) {
        validateGuardianSignature(sig);
      }
    }

    await this.assertWalletNetwork({ networkPassphrase: this.networkPassphrase });
    const owner = await this.getWalletPublicKey();
    // checkin_period_days is a stored will property not returned by the
    // contract's emergency_checkin function, so a separate getWill() read is
    // unavoidable in order to compute the nextDeadline return value.
    const will = await this.getWill(willId, requestOptions);
    const invokeArgs: Record<string, unknown> = {
      will_id: parseWillId(willId),
      owner,
    };
    if (guardianSig !== undefined) {
      invokeArgs.guardian_signature = guardianSig;
    } else if (guardianSigs !== undefined) {
      invokeArgs.guardian_signatures = guardianSigs;
    }

    const { txHash, createdAt } = await this.invoke(
      'emergency_checkin',
      invokeArgs,
      requestOptions,
    );
    return {
      txHash,
      nextDeadline: new Date((createdAt + will.checkinPeriodDays * 86_400) * 1000),
    };
  }

  /**
   * Distributes the will's balance to all beneficiaries once the grace period has elapsed.
   *
   * **Operation Type:** Write (State-changing)
   *
   * @remarks State-changing write operation. Builds, signs, and submits an on-chain transaction that modifies
   * ledger state to distribute locked assets to beneficiaries and transition will status to Released. Requires a
   * connected wallet to sign and consumes transaction fees.
   *
   * @param willId - The identifier of the will to release.
   * @param options - Optional request options.
   * @returns The transaction hash.
   * @throws {SoroWillError} If the transaction simulation/submission fails.
   * @throws {RequestTimeoutError} If the RPC request exceeds its configured timeout.
   * @throws {WillNotFoundError} If the will does not exist.
   * @throws {WillNotTriggeredError} If the will has not been triggered.
   * @throws {GracePeriodNotExpiredError} If the grace period has not yet expired.
   * @throws {Error} If the wallet is not connected or fails to sign.
   *
   * @example
   * ```ts
   * const { txHash } = await client.releaseInheritance('1');
   * console.log(`Inheritance released: ${txHash}`);
   * ```
   */
  /**
   * Distributes the locked balance to beneficiaries after the grace period
   * expires.
   *
   * **Beneficiary funding validation:** Before submitting the release
   * transaction, the SDK verifies that every beneficiary account exists on
   * chain and holds enough XLM to cover the trustline reserve required to
   * receive the will's token. If any beneficiary account is unfunded, the
   * method throws a {@link BeneficiaryValidationError} with a clear message
   * naming the unfunded account so the caller can fund it before retrying.
   *
   * @param willId - The on-chain will ID.
   * @param options - Optional per-call timeout and abort signal.
   * @returns The transaction hash.
   * @throws {SoroWillInvalidIdError} If `willId` is not a valid numeric ID.
   * @throws {WillNotFoundError} If the will does not exist.
   * @throws {BeneficiaryValidationError} If any beneficiary account is not
   * funded (does not exist on-chain or lacks sufficient XLM for a trustline).
   * @throws {RequestTimeoutError} If the RPC request exceeds its configured timeout.
   * @throws {Error} If the wallet is not connected or fails to sign.
   */
  async releaseInheritance(
    willId: string,
    options?: RequestOptions,
  ): Promise<{ txHash: string }> {
    parseWillId(willId);
    await this.assertWalletNetwork({ networkPassphrase: this.networkPassphrase });

    // Resolve beneficiaries from the will so we can validate funding before
    // attempting the on-chain release.
    const will = await this.getWill(willId, options);

    // #631: Validate that the grace period has expired before attempting the
    // on-chain release. The contract rejects with a cryptic error if called
    // during the grace period; surface a clear SDK-level error instead.
    if (will.triggerTime !== null) {
      const gracePeriodMs = will.gracePeriodDays * 24 * 60 * 60 * 1000;
      const gracePeriodExpiresAt = new Date(will.triggerTime.getTime() + gracePeriodMs);
      if (Date.now() < gracePeriodExpiresAt.getTime()) {
        throw new GracePeriodActiveError(willId, gracePeriodExpiresAt);
      }
    }

    // #655: Validate ownership before submitting the release transaction so
    // non-owners fail fast with NotOwnerError instead of hitting the network.
    const caller = await this.getWalletPublicKey();
    if (caller !== will.owner) {
      throw new NotOwnerError();
    }

    await this.validateBeneficiariesFunded(will.beneficiaries);

    const { txHash } = await this.invoke(
      'release_inheritance',
      { will_id: parseWillId(willId) },
      options,
    );
    return { txHash };
  }

  /**
   * Validates that every beneficiary account exists on-chain and holds enough
   * XLM to satisfy the trustline reserve for receiving the will's token.
   *
   * @param beneficiaries - The beneficiary list from the will.
   * @throws {BeneficiaryValidationError} If any beneficiary account is not
   *   found on-chain or is unfunded.
   */
  private async validateBeneficiariesFunded(
    beneficiaries: readonly { address: string }[],
  ): Promise<void> {
    for (const beneficiary of beneficiaries) {
      try {
        await this.server.getAccount(beneficiary.address);
      } catch {
        throw new BeneficiaryValidationError(
          `Beneficiary account "${beneficiary.address}" is not funded on this network. ` +
            'The account does not exist on-chain. Fund it with the minimum XLM reserve ' +
            'before attempting to release inheritance.',
        );
      }
    }
  }

  /** Cancels the will and withdraws the full balance back to the owner. */
  async cancelWill(
    willId: string,
    options?: RequestOptions,
  ): Promise<{
    txHash: string;
    refundAmount: string;
    confirmedAt: Date;
    willClosed: boolean;
    message: string;
  }> {
    const canonicalWillId = parseWillId(willId).toString();
    await this.assertWalletNetwork({ networkPassphrase: this.networkPassphrase });
    const owner = await this.getWalletPublicKey();
    const { txHash, createdAt, returnValue } = await this.invoke('cancel_will', {
      will_id: BigInt(canonicalWillId),
      owner,
    }, options);
    // The will's cached state is stale now that it has been cancelled.
    this.statusCache.delete(canonicalWillId);
    await this.readCache?.invalidateByWillId(canonicalWillId);

    // cancel_will returns the refunded balance on success. Decode it from the
    // transaction return value to avoid an extra getWill() round-trip.
    let refundAmount: string;
    if (returnValue) {
      const spec = await this.getSpec(options);
      refundAmount = (spec.funcResToNative('cancel_will', returnValue) as bigint).toString();
    } else {
      // Fallback for older contract versions that don't return the balance.
      const will = await this.getWill(canonicalWillId, options);
      refundAmount = will.balance;
    }

    // Cancellation closes the will, so a successful cancel always reports closed.
    const confirmedAt = new Date(createdAt * 1000);
    return {
      txHash,
      refundAmount,
      confirmedAt,
      willClosed: true,
      message:
        `Will ${canonicalWillId} cancelled. Refunded ${refundAmount} in transaction ${txHash}, ` +
        `confirmed at ${confirmedAt.toISOString()}.`,
    };
  }

  /**
   * Replaces the beneficiary list for a will before it has been triggered.
   *
   * The will's existence is validated via `getWill()` before submission. If
   * the will does not exist, a {@link WillNotFoundError} is thrown before any
   * transaction is built, avoiding wasted gas and fees.
   *
   * @returns The transaction hash.
   * @throws {BeneficiaryValidationError} If the beneficiary list fails client-side validation.
   * @throws {SoroWillError} If the transaction simulation/submission fails.
   * @throws {RequestTimeoutError} If the RPC request exceeds its configured timeout.
   * @throws {WillNotFoundError} If the will does not exist.
   * @throws {Error} If the wallet is not connected or fails to sign.
   */
  async updateBeneficiaries(
    params: UpdateBeneficiariesParams,
    options?: RequestOptions,
  ): Promise<{ txHash: string }> {
    parseWillId(params.willId);
    const beneficiaries = [...params.beneficiaries];
    assertValidBeneficiaryAddresses(beneficiaries);
    if (hasDuplicateBeneficiaries(beneficiaries)) {
      throw new BeneficiaryValidationError('Invalid beneficiaries: duplicate beneficiary addresses are not allowed.');
    }
    assertValidBeneficiaryPercentages(beneficiaries, 'updateBeneficiaries');
    // Validate will existence before submitting, to avoid wasting gas on a
    // non-existent will.
    if (!options?.skipExistenceCheck) {
      await this.getWill(params.willId, options);
    }
    await this.assertWalletNetwork({ networkPassphrase: this.networkPassphrase });
    const owner = await this.getWalletPublicKey();
    const { txHash } = await this.invoke(
      'update_beneficiaries',
      { will_id: parseWillId(params.willId), owner, beneficiaries: toContractBeneficiaries(beneficiaries) },
      options,
    );
    return { txHash };
  }

  /**
   * Adds more of the will's token to its locked balance.
   *
   * **Operation Type:** Write (State-changing)
   *
   * @remarks State-changing write operation. Builds, signs, and submits an on-chain transaction that modifies
   * ledger state to deposit additional tokens into the will. Requires a connected wallet to sign and consumes
   * transaction fees.
   *
   * @param willId - The identifier of the will to top up.
   * @param amount - The token amount in base units (stroops) as a positive decimal integer string.
   * @param options - Optional request options.
   * @returns An object with the transaction hash.
   * @throws {SoroWillInvalidAmountError} If amount is not a valid positive integer string.
   * @throws {SoroWillError} If the transaction fails on-chain.
   *
   * @example
   * ```ts
   * const { txHash } = await client.topUp('1', '5000000');
   * console.log(`Will topped up: ${txHash}`);
   * ```
   */
  async topUp(
    willId: string,
    amount: string,
    options?: RequestOptions,
  ): Promise<{ txHash: string }> {
    const parsedWillId = parseWillId(willId);
    // Reject zero, negative, and malformed amounts before touching the wallet or RPC.
    const parsedAmount = validateAmount(amount);
    await this.assertWalletNetwork({ networkPassphrase: this.networkPassphrase });
    const owner = await this.getWalletPublicKey();
    const { txHash } = await this.invoke('top_up', {
      will_id: parsedWillId,
      owner,
      amount: parsedAmount,
    }, options);
    return { txHash };
  }

  /**
   * Adds `amount` base units to the balance of `willId` and reports the
   * resulting balance. Unlike a full refill, any positive amount is accepted.
   *
   * The amount is validated before any wallet or RPC interaction. The will's
   * cached read is invalidated after submission so `remainingBalance` reflects
   * the confirmed top-up (#725).
   *
   * @param willId - The will to fund.
   * @param amount - Positive integer amount in base units, as a decimal string.
   * @returns The transaction hash and the will's balance after the top-up.
   * @throws {SoroWillInvalidAmountError} If `amount` is zero, negative, or malformed.
   */
  async fundWill(
    willId: string,
    amount: string,
    options?: RequestOptions,
  ): Promise<{ txHash: string; remainingBalance: string }> {
    const canonicalWillId = parseWillId(willId).toString();
    const { txHash } = await this.topUp(canonicalWillId, amount, options);
    await this.readCache?.invalidateByWillId(canonicalWillId);
    const will = await this.getWill(canonicalWillId, options);
    return { txHash, remainingBalance: will.balance };
  }

  /**
   * Creates several wills, one transaction per entry, submitted sequentially.
   *
   * This is not atomic: each will is created by its own transaction. Failures
   * do not stop the batch. Each entry's outcome is returned in input order, so
   * a failed entry can be retried without repeating the ones that succeeded (#727).
   *
   * @param paramsList - 1 to 25 will definitions.
   * @param options - Optional request options applied to every transaction.
   * @returns One {@link BatchItemResult} per input entry, in input order.
   * @throws {SoroWillError} If the list is empty or has more than 25 entries.
   */
  async batchCreateWill(
    paramsList: readonly CreateWillParams[],
    options?: RequestOptions,
  ): Promise<BatchItemResult<{ willId: string; txHash: string }>[]> {
    assertBatchSize(paramsList.length, 'batchCreateWill');
    return this.runBatchSequentially(paramsList, (params) => this.createWill(params, options));
  }

  /**
   * Resets the check-in countdown for several wills, one transaction per will,
   * submitted sequentially.
   *
   * Not atomic: failures do not stop the batch, and each will's outcome is
   * returned in input order. Every will ID is validated before any transaction
   * is submitted (#727).
   *
   * @param willIds - 1 to 25 will IDs.
   * @param options - Optional request options applied to every transaction.
   * @returns One {@link BatchItemResult} per input ID, in input order.
   * @throws {SoroWillError} If the list is empty or has more than 25 entries.
   * @throws {Error} If any will ID is malformed.
   */
  async batchCheckIn(
    willIds: readonly string[],
    options?: RequestOptions,
  ): Promise<BatchItemResult<{ txHash: string; nextDeadline: Date }>[]> {
    assertBatchSize(willIds.length, 'batchCheckIn');
    const canonicalIds = willIds.map((willId) => parseWillId(willId).toString());
    return this.runBatchSequentially(canonicalIds, (willId) => this.checkIn(willId, options));
  }

  private async runBatchSequentially<I, T>(
    items: readonly I[],
    run: (item: I) => Promise<T>,
  ): Promise<BatchItemResult<T>[]> {
    const results: BatchItemResult<T>[] = [];
    for (const [index, item] of items.entries()) {
      try {
        results.push({ index, status: 'success', value: await run(item) });
      } catch (error) {
        results.push({
          index,
          status: 'error',
          error: error instanceof Error ? error : new SoroWillError(String(error)),
        });
      }
    }
    return results;
  }

  // -----------------------------------------------------------------------
  // Public: transaction polling
  // -----------------------------------------------------------------------

  /**
   * Polls for the final status of a submitted transaction and returns its
   * `createdAt` ledger timestamp and contract return value.
   *
   * **Operation Type:** Read-only (Query)
   *
   * @readonly
   * @remarks Read-only query operation. Polls RPC transaction status without modifying ledger state or submitting new transactions.
   *
   * This is the same polling-and-status-handling logic used internally by
   * all state-changing methods. Consumers who submit transactions through a
   * custom signing flow (e.g. using lower-level
   * `buildTransaction`/`submitSignedTransaction` primitives) can call this
   * directly instead of re-implementing the polling loop themselves.
   *
   * @param txHash - The hash returned by `sendTransaction`.
   * @param options - Optional per-call timeout and abort signal.
   * @returns The ledger creation timestamp and the contract return value, if any.
   * @throws {SoroWillError} If the transaction does not reach `SUCCESS` status.
   * @throws {RequestTimeoutError} If the RPC request exceeds its configured timeout.
   *
   * @example
   * ```ts
   * const { createdAt, returnValue } = await client.waitForTransaction('abc123hash');
   * console.log(`Transaction confirmed at ledger timestamp: ${createdAt}`);
   * ```
   */
  async waitForTransaction(
    txHash: string,
    options?: RequestOptions,
  ): Promise<{ createdAt: number; returnValue: xdr.ScVal | undefined }> {
    const txResponse = await this.rpc(
      () => this.server.pollTransaction(txHash, { attempts: this.pollAttempts }),
      options,
      'pollTransaction',
    );

    if (txResponse.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
      throw new InvokeFailedError(txHash, `transaction did not succeed`, {
        status: txResponse.status,
        resultXdr: (txResponse as unknown as Record<string, unknown>).resultXdr ?? null,
        diagnosticEventsXdr: (txResponse as unknown as Record<string, unknown>).diagnosticEventsXdr ?? null,
        txHash,
      });
    }

    return {
      createdAt: txResponse.createdAt,
      returnValue: txResponse.returnValue,
    };
  }

  /**
   * Fetches a transaction by hash and returns its full details (#793).
   *
   * **Operation Type:** Read-only (Query)
   *
   * @readonly
   * @remarks Read-only query operation. Does not modify ledger state.
   *
   * Unlike {@link SoroWillClient.waitForTransaction}, this performs a single
   * RPC round trip and does not poll or throw on a `FAILED` status — the
   * status is returned so callers can inspect it.
   *
   * @param txHash - The transaction hash returned by `sendTransaction`.
   * @param options - Optional per-call timeout and abort signal.
   * @returns The transaction details, including status and ledger metadata.
   * @throws {TransactionNotFoundError} If the network has no record of `txHash`.
   * @throws {RequestTimeoutError} If the RPC request exceeds its configured timeout.
   *
   * @example
   * ```ts
   * try {
   *   const tx = await client.getTransaction('abc123hash');
   *   console.log(tx.status, tx.ledger);
   * } catch (err) {
   *   if (err instanceof TransactionNotFoundError) {
   *     console.warn('Unknown transaction', err.txHash);
   *   }
   * }
   * ```
   */
  async getTransaction(txHash: string, options?: RequestOptions): Promise<TransactionDetails> {
    if (typeof txHash !== 'string' || txHash.trim() === '') {
      throw new SoroWillError('getTransaction requires a non-empty transaction hash');
    }
    const hash = txHash.trim();

    const response = await this.rpc(
      () =>
        this.rpcPool.withFailover((server) => {
          if (typeof server.getTransaction !== 'function') {
            throw new SoroWillError('The configured RPC server does not support getTransaction');
          }
          return server.getTransaction(hash);
        }),
      options,
      'getTransaction',
    );

    if (!response || response.status === rpc.Api.GetTransactionStatus.NOT_FOUND) {
      throw new TransactionNotFoundError(hash);
    }

    const record = response as unknown as Record<string, unknown>;
    const details: TransactionDetails = {
      hash,
      status: response.status,
      raw: response,
    };
    if (typeof record.ledger === 'number') details.ledger = record.ledger;
    if (typeof record.createdAt === 'number') details.createdAt = record.createdAt;
    if (typeof record.resultXdr === 'string') details.resultXdr = record.resultXdr;
    if (typeof record.resultMetaXdr === 'string') details.resultMetaXdr = record.resultMetaXdr;
    if (typeof record.envelopeXdr === 'string') details.envelopeXdr = record.envelopeXdr;
    return details;
  }

  /**
   * Proactively check whether the configured RPC endpoint is reachable.
   *
   * **Operation Type:** Read-only (Query)
   *
   * @readonly
   * @remarks Read-only query operation. Probes the RPC health endpoint without modifying ledger state.
   * Useful for showing a 'network unavailable' banner before attempting a real call.
   * Never throws — network failures resolve to `false` rather than propagating an exception.
   *
   * The call goes through the request queue with the client's timeout and RPC failover.
   * A server that does not implement `getHealth` is reported as not healthy (`false`).
   *
   * @param options - Optional request timeout and abort signal.
   * @returns `true` only if the RPC server reports `status: 'healthy'`, `false` otherwise.
   *
   * @example
   * ```ts
   * const online = await client.isHealthy();
   * if (!online) {
   *   console.warn('RPC endpoint currently unreachable');
   * }
   * ```
   */
  async isHealthy(options?: RequestOptions): Promise<boolean> {
    try {
      const response = await this.rpc(
        () =>
          this.rpcPool.withFailover((server) => {
            if (typeof server.getHealth !== 'function') {
              throw new SoroWillError('The configured RPC server does not support getHealth');
            }
            return server.getHealth();
          }),
        options,
        'getHealth',
      );
      return response?.status === 'healthy';
    } catch {
      // Network failures, timeouts, or any other errors mean the server is not healthy
      return false;
    }
  }

  /**
   * Probes all configured RPC endpoints for health, updating pool failover state
   * and switching away from an unhealthy primary endpoint if a healthy secondary exists.
   */
  async checkRpcHealth(): Promise<Array<{ url: string; healthy: boolean; latencyMs?: number }>> {
    return this.rpcPool.checkEndpointsHealth();
  }

  /**
   * Rotates to the next configured RPC endpoint in the pool and returns its URL.
   */
  rotateRpcEndpoint(): string {
    return this.rpcPool.rotate();
  }

  /**
   * Returns the currently active RPC endpoint URL.
   *
   * **Operation Type:** Read-only (Query)
   *
   * @readonly
   * @remarks Read-only query operation. Returns the active local configuration without making network requests.
   *
   * When multiple RPC endpoints are configured via `rpcUrls`, the pool tracks
   * which endpoint is actively in use. This is useful for debugging regional
   * outages, comparing endpoint reliability, or understanding which backup
   * endpoint the client failed over to.
   *
   * @throws {Error} if no RPC endpoints are configured (which is prevented by
   * the RpcEndpointPool constructor, so this should not occur in practice)
   *
   * @returns the currently active RPC endpoint URL
   *
   * @example
   * ```ts
   * const activeUrl = client.getActiveRpcUrl();
   * console.log(`Currently connected to RPC: ${activeUrl}`);
   * ```
   */
  getActiveRpcUrl(): string {
    return this.rpcPool.getActiveRpcUrl();
  }

  /**
   * Builds the Soroban `xdr.LedgerKey` for a contract storage entry on this
   * client's contract, enabling advanced users to query contract state directly
   * via `getLedgerEntries` or inspect ledger footprints for debugging.
   *
   * @param key - Storage key as an `xdr.ScVal` or symbol string (ignored when
   *   `durability` is `'instance'`).
   * @param options - Optional durability tier (`'persistent'`, `'temporary'`,
   *   or `'instance'`). Defaults to `'persistent'`.
   * @returns The constructed `xdr.LedgerKey` for the contract data entry.
   * @throws {SoroWillError} If `durability` is invalid or `key` is missing/empty
   *   for non-instance storage.
   *
   * @example
   * ```ts
   * const ledgerKey = client.getContractStorageLedgerKey('admin');
   * const base64Key = ledgerKey.toXDR('base64');
   * ```
   */
  getContractStorageLedgerKey(
    key: xdr.ScVal | string,
    options?: ContractStorageLedgerKeyOptions,
  ): xdr.LedgerKey {
    const durability = options?.durability ?? 'persistent';
    const contractAddress = Address.fromString(this.contract.contractId()).toScAddress();

    if (durability === 'instance') {
      return xdr.LedgerKey.contractData(
        new xdr.LedgerKeyContractData({
          contract: contractAddress,
          key: xdr.ScVal.scvLedgerKeyContractInstance(),
          durability: xdr.ContractDataDurability.persistent(),
        }),
      );
    }

    if (durability !== 'persistent' && durability !== 'temporary') {
      throw new SoroWillError(
        `Invalid contract storage durability "${String(durability)}": expected "persistent", "temporary", or "instance"`,
      );
    }

    let scKey: xdr.ScVal;
    if (typeof key === 'string') {
      if (key.length === 0) {
        throw new SoroWillError('Contract storage key string must not be empty');
      }
      scKey = xdr.ScVal.scvSymbol(key);
    } else if (key instanceof xdr.ScVal) {
      scKey = key;
    } else {
      throw new SoroWillError('Contract storage key must be a non-empty string or an xdr.ScVal');
    }

    const xdrDurability =
      durability === 'temporary'
        ? xdr.ContractDataDurability.temporary()
        : xdr.ContractDataDurability.persistent();

    return xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: contractAddress,
        key: scKey,
        durability: xdrDurability,
      }),
    );
  }

  /**
   * Builds the Soroban `xdr.LedgerKey` for this contract's instance storage
   * entry (`ScvLedgerKeyContractInstance`).
   *
   * @returns The constructed `xdr.LedgerKey` for the contract instance entry.
   */
  getContractInstanceLedgerKey(): xdr.LedgerKey {
    return this.getContractStorageLedgerKey(xdr.ScVal.scvLedgerKeyContractInstance(), {
      durability: 'instance',
    });
  }

  /**
   * Fetches a will by its ID.
   *
   * **Immutability guarantee:** The returned `Will` object is a fresh clone
   * (via {@link cloneWill}). Mutating properties on the returned object does
   * **not** affect internal SDK state or the read cache. When
   * {@link SoroWillClientOptions.deepFreeze} is `true`, the returned object
   * is additionally deep-frozen so any mutation attempt throws a `TypeError`.
   *
   * @param willId - The on-chain will ID.
   * @param options - Optional per-call timeout and abort signal.
   * @returns The will record.
   * @throws {SoroWillInvalidIdError} If `willId` is not a valid numeric ID.
   * @throws {WillNotFoundError} If the will does not exist on-chain.
   * @throws {RequestTimeoutError} If the RPC request exceeds its configured timeout.
   */
  async getWill(willId: string, options?: RequestOptions): Promise<Will> {
    const canonicalWillId = parseWillId(willId).toString();
    const cacheKey = createReadCacheKey('get_will', { willId: canonicalWillId });
    if (this.readCache && !options?.skipCache) {
      await this.readCache.ready();
      const cached = this.readCache.get<Will>(cacheKey);
      if (cached !== undefined) {
        const cloned = cloneWill(cached);
        return this.deepFreeze ? deepFreezeObject(cloned) : cloned;
      }
    }
    const raw = await this.read<unknown>('get_will', { will_id: BigInt(canonicalWillId) }, options);
    const will = mapWill(raw);
    this.readCache?.set(cacheKey, cloneWill(will), [canonicalWillId]);
    return this.deepFreeze ? deepFreezeObject(will) : will;
  }

  /**
   * Returns only the status of `willId`, without exposing the rest of the
   * will record. Results are cached for 30 seconds per will, so repeated status
   * checks are served from memory instead of RPC (#726).
   *
   * The cache is cleared for a will by {@link SoroWillClient.cancelWill}. Other
   * status transitions (e.g. triggering or releasing) made outside this client
   * become visible after the TTL expires.
   *
   * @param willId - The will to check.
   * @param options - Optional request options.
   * @returns The will's current {@link WillStatus}.
   * @throws {RequestTimeoutError} If the RPC request exceeds its configured timeout.
   */
  async willStatus(willId: string, options?: RequestOptions): Promise<WillStatus> {
    const canonicalWillId = parseWillId(willId).toString();
    const now = Date.now();
    const cached = this.statusCache.get(canonicalWillId);
    if (cached && cached.expiresAt > now) {
      return cached.status;
    }
    const raw = await this.read<unknown>('get_will', { will_id: BigInt(canonicalWillId) }, options);
    const { status } = mapWill(raw);
    this.statusCache.set(canonicalWillId, { status, expiresAt: now + WILL_STATUS_CACHE_TTL_MS });
    return status;
  }

  /**
   * Returns the guardian voting status of `willId`, including per-guardian
   * vote details, vote timestamps and whether each vote has expired (#800).
   *
   * The contract exposes only the aggregate vote count, so vote timestamps are
   * attributed in guardian order (the first `votesCast` guardians are treated
   * as the voters). Votes older than `voteTtlMs` (default 24h) are reported as
   * `expired` and no longer count toward the 2-of-N release threshold.
   *
   * @param willId - The will to inspect.
   * @param options - Optional request options plus `voteTtlMs` / `now` overrides.
   * @returns The aggregate and per-guardian voting status.
   * @throws {SoroWillInvalidIdError} If `willId` is not a valid numeric ID.
   * @throws {WillNotFoundError} If the will does not exist on-chain.
   * @throws {RequestTimeoutError} If the RPC request exceeds its configured timeout.
   */
  async getGuardianVotingStatus(
    willId: string,
    options?: RequestOptions & { voteTtlMs?: number; now?: number },
  ): Promise<GuardianVotingStatus> {
    const will = await this.getWill(willId, options);
    return buildGuardianVotingStatus(will, [], {
      now: options?.now,
      ttlMs: options?.voteTtlMs,
    });
  }

  /**
   * Fetches multiple wills by ID in a single RPC call. More efficient than
   * calling `getWill` repeatedly. Does not require a connected wallet.
   *
   * De-duplicates IDs in the request but returns results in the original input
   * order, repeating results for duplicate input IDs.
   *
   * @param willIds - Array of will ID strings to fetch.
   * @param options - Optional request options.
   * @returns An array of will records in the same order as the input IDs.
   * @throws {RequestTimeoutError} If the RPC request exceeds its configured timeout.
   */
  async getWills(willIds: string[], options?: RequestOptions): Promise<Will[]> {
    if (willIds.length === 0) {
      return [];
    }

    const canonicalIds = willIds.map((id) => parseWillId(id).toString());
    const uniqueIds = Array.from(new Set(canonicalIds));
    const cacheKey = createReadCacheKey('get_wills', { will_ids: uniqueIds.join(',') });

    if (this.readCache && !options?.skipCache) {
      await this.readCache.ready();
      const cached = this.readCache.get<Will[]>(cacheKey);
      if (cached !== undefined) {
        const cloned = cached.map(cloneWill);
        const result = canonicalIds.map((id) => cloned.find((w) => w.id === id)!);
        return this.deepFreeze
          ? result.map((w) => deepFreezeObject(w))
          : result;
      }
    }

    const raw = await this.read<unknown>('get_wills', { will_ids: uniqueIds.map(BigInt) }, options);
    const wills = Array.isArray(raw) ? raw.map(mapWill) : [mapWill(raw)];
    this.readCache?.set(cacheKey, wills.map(cloneWill), uniqueIds);

    const result = canonicalIds.map((id) => cloneWill(wills.find((w) => w.id === id)!));
    return this.deepFreeze
      ? result.map((w) => deepFreezeObject(w))
      : result;
  }

  /**
   * Lists every will owned by `owner`. Does not require a connected wallet.
   *
   * **Immutability guarantee:** The returned `Will[]` array and each element
   * are fresh clones. Mutating the array or any `Will` property does **not**
   * affect internal SDK state or the read cache. When
   * {@link SoroWillClientOptions.deepFreeze} is `true`, each returned object
   * is deep-frozen so any mutation attempt throws a `TypeError`.
   *
   * @param owner - The Stellar public key of the will owner.
   * @param options - Optional pagination and per-call timeout/abort signal.
   * @returns An array of will records owned by `owner`.
   * @throws {InvalidCursorError} If a pagination cursor is invalid.
   * @throws {RequestTimeoutError} If the RPC request exceeds its configured timeout.
   */
  async getWillsByOwner(owner: string, options?: RequestOptions): Promise<Will[]>;
  /**
   * Lists every will owned by `owner`, one client-side page at a time. Does
   * not require a connected wallet.
   *
   * **Immutability guarantee:** Same as {@link getWillsByOwner} — returned
   * objects are clones (deep-frozen when `deepFreeze` is enabled).
   *
   * **Read-only operation** — does not require wallet authentication.
   *
   * Supports both offset/limit (`{ offset, limit }`) and cursor-based
   * (`{ cursor }`) pagination; see {@link PaginationOptions}.
   *
   * @param owner - The Stellar public key of the will owner.
   * @param options - Pagination options plus optional timeout/abort signal.
   * @returns A paginated page of will records.
   *
   * @example
   * ```ts
   * const page = await client.getWillsByOwner('GISSUE559...', { offset: 0, limit: 20 });
   * const next = await client.getWillsByOwner('GISSUE559...', { cursor: page.nextCursor! });
   * ```
   */
  async getWillsByOwner(
    owner: string,
    options: PaginationOptions & RequestOptions,
  ): Promise<PaginatedWillsResult>;
  async getWillsByOwner(
    owner: string,
    options?: (PaginationOptions & RequestOptions) | RequestOptions,
  ): Promise<Will[] | PaginatedWillsResult> {
    // #612: reject malformed addresses before they reach the cache key or RPC.
    assertValidStellarAddress(owner, 'owner', { allowContract: true });
    validatePaginationOptions(options as PaginationOptions | undefined);
    const cacheKey = createReadCacheKey('get_wills_by_owner', { owner });
    if (this.readCache && !options?.skipCache) {
      await this.readCache.ready();
      const cached = this.readCache.get<Will[]>(cacheKey);
      if (cached !== undefined) {
        const cloned = cached.map(cloneWill);
        return this.paginate(
          this.deepFreeze ? cloned.map(deepFreezeObject) : cloned,
          options,
        );
      }
    }
    const raw = await this.read<unknown>('get_wills_by_owner', { owner }, options);
    const wills = mapWillList(raw);
    this.readCache?.set(cacheKey, wills.map(cloneWill), wills.map((will) => will.id));
    const cloned = wills.map(cloneWill);
    return this.paginate(
      this.deepFreeze ? cloned.map(deepFreezeObject) : cloned,
      options,
    );
  }

  /**
   * Lists every will `beneficiary` is named in. Does not require a connected
   * wallet.
   *
   * **Immutability guarantee:** The returned `Will[]` array and each element
   * are fresh clones. Mutating the array or any `Will` property does **not**
   * affect internal SDK state or the read cache. When
   * {@link SoroWillClientOptions.deepFreeze} is `true`, each returned object
   * is deep-frozen so any mutation attempt throws a `TypeError`.
   *
   * @param beneficiary - The Stellar public key of the beneficiary.
   * @param options - Optional pagination and per-call timeout/abort signal.
   * @returns An array of will records naming `beneficiary`.
   * @throws {InvalidCursorError} If a pagination cursor is invalid.
   * @throws {RequestTimeoutError} If the RPC request exceeds its configured timeout.
   */
  async getWillsByBeneficiary(
    beneficiary: string,
    options?: RequestOptions,
  ): Promise<Will[]>;
  /**
   * Lists every will `beneficiary` is named in, one client-side page at a
   * time. Does not require a connected wallet.
   *
   * **Immutability guarantee:** Same as {@link getWillsByBeneficiary} —
   * returned objects are clones (deep-frozen when `deepFreeze` is enabled).
   *
   * **Read-only operation** — does not require wallet authentication.
   *
   * Supports both offset/limit (`{ offset, limit }`) and cursor-based
   * (`{ cursor }`) pagination; see {@link PaginationOptions}.
   *
   * @param beneficiary - The Stellar public key of the beneficiary.
   * @param options - Pagination options plus optional timeout/abort signal.
   * @returns A paginated page of will records.
   *
   * @example
   * ```ts
   * const page = await client.getWillsByBeneficiary('GISSUE559...', { limit: 20 });
   * ```
   */
  async getWillsByBeneficiary(
    beneficiary: string,
    options: PaginationOptions & RequestOptions,
  ): Promise<PaginatedWillsResult>;
  async getWillsByBeneficiary(
    beneficiary: string,
    options?: (PaginationOptions & RequestOptions) | RequestOptions,
  ): Promise<Will[] | PaginatedWillsResult> {
    // #612: reject malformed addresses before they reach the cache key or RPC.
    assertValidStellarAddress(beneficiary, 'beneficiary', { allowContract: true });
    validatePaginationOptions(options as PaginationOptions | undefined);
    const cacheKey = createReadCacheKey('get_wills_by_beneficiary', { beneficiary });
    if (this.readCache && !options?.skipCache) {
      await this.readCache.ready();
      const cached = this.readCache.get<Will[]>(cacheKey);
      if (cached !== undefined) {
        const cloned = cached.map(cloneWill);
        return this.paginate(
          this.deepFreeze ? cloned.map(deepFreezeObject) : cloned,
          options,
        );
      }
    }
    const raw = await this.read<unknown>(
      'get_wills_by_beneficiary',
      { beneficiary },
      options,
    );
    const wills = mapWillList(raw);
    this.readCache?.set(cacheKey, wills.map(cloneWill), wills.map((will) => will.id));
    const cloned = wills.map(cloneWill);
    return this.paginate(
      this.deepFreeze ? cloned.map(deepFreezeObject) : cloned,
      options,
    );
  }

  /**
   * Streams every will owned by `owner`, one will at a time, instead of
   * buffering the whole response in memory (#787).
   *
   * Results are fetched in pages of {@link WillStreamOptions.chunkSize} wills
   * (default {@link DEFAULT_WILL_STREAM_CHUNK_SIZE}) and yielded as an async
   * iterable, so only one page is held in memory at a time. Yields are
   * de-duplicated by will ID and sorted ascending by `will_id`, matching
   * {@link getWillsByOwner}.
   *
   * **Read-only operation** — does not require wallet authentication.
   *
   * @param owner - The Stellar public key of the will owner.
   * @param options - Optional chunk size, limit, timeout and abort signal.
   * @returns An async iterable of will records.
   *
   * @example
   * ```ts
   * for await (const will of client.streamWillsByOwner('GISSUE559...')) {
   *   process(will);
   * }
   * ```
   */
  streamWillsByOwner(owner: string, options?: WillStreamOptions): AsyncGenerator<Will, void, undefined> {
    assertValidStellarAddress(owner, 'owner', { allowContract: true });
    return this.streamWillsFromPages(
      (pageOptions) => this.getWillsByOwner(owner, pageOptions),
      options,
    );
  }

  /**
   * Streams every will `beneficiary` is named in, one will at a time, instead
   * of buffering the whole response in memory (#787).
   *
   * **Read-only operation** — does not require wallet authentication.
   *
   * @param beneficiary - The Stellar public key of the beneficiary.
   * @param options - Optional chunk size, limit, timeout and abort signal.
   * @returns An async iterable of will records.
   */
  streamWillsByBeneficiary(
    beneficiary: string,
    options?: WillStreamOptions,
  ): AsyncGenerator<Will, void, undefined> {
    assertValidStellarAddress(beneficiary, 'beneficiary', { allowContract: true });
    return this.streamWillsFromPages(
      (pageOptions) => this.getWillsByBeneficiary(beneficiary, pageOptions),
      options,
    );
  }

  /**
   * Streams the wills for `willIds`, one will at a time, instead of buffering
   * the whole response in memory (#787). IDs are fetched in chunks of
   * {@link WillStreamOptions.chunkSize} and yielded in input order, repeating
   * results for duplicate input IDs (matching {@link getWills}).
   *
   * @param willIds - Array of will ID strings to fetch.
   * @param options - Optional chunk size, limit, timeout and abort signal.
   * @returns An async iterable of will records.
   */
  async *streamWills(
    willIds: string[],
    options?: WillStreamOptions,
  ): AsyncGenerator<Will, void, undefined> {
    const chunkSize = normalizeStreamChunkSize(options?.chunkSize);
    const limit = normalizeStreamLimit(options?.limit);
    let yielded = 0;
    for (let start = 0; start < willIds.length; start += chunkSize) {
      if (limit !== undefined && yielded >= limit) {
        return;
      }
      const chunk = willIds.slice(start, start + chunkSize);
      const wills = await this.getWills(chunk, options);
      for (const will of wills) {
        if (limit !== undefined && yielded >= limit) {
          return;
        }
        yielded += 1;
        yield will;
      }
    }
  }

  /**
   * Shared paging loop behind {@link streamWillsByOwner} and
   * {@link streamWillsByBeneficiary}: pulls one page at a time and yields its
   * wills, so peak memory is bounded by `chunkSize` rather than the full
   * result set (#787).
   */
  private async *streamWillsFromPages(
    fetchPage: (options: PaginationOptions & RequestOptions) => Promise<Will[] | PaginatedWillsResult>,
    options?: WillStreamOptions,
  ): AsyncGenerator<Will, void, undefined> {
    const chunkSize = normalizeStreamChunkSize(options?.chunkSize);
    const limit = normalizeStreamLimit(options?.limit);
    let cursor: string | undefined;
    let yielded = 0;
    for (;;) {
      const page = await fetchPage({ ...options, pageSize: chunkSize, cursor });
      const wills = Array.isArray(page) ? page : page.wills;
      const nextCursor = Array.isArray(page) ? null : page.nextCursor;
      for (const will of wills) {
        if (limit !== undefined && yielded >= limit) {
          return;
        }
        yielded += 1;
        yield will;
      }
      if (nextCursor === null || nextCursor === undefined || wills.length === 0) {
        return;
      }
      cursor = nextCursor;
    }
  }

  /**
   * Applies optional client-side pagination to an already-fetched list of
   * wills. Returns the plain list unchanged when no pagination option
   * (`pageSize`, `limit`, `offset`, or `cursor`) is present on `options`, so
   * callers who don't ask for pagination keep getting a plain `Will[]`.
   *
   * Supports both offset/limit pagination (`offset` + `limit`/`pageSize`) and
   * cursor-based pagination (`cursor` from a previous `nextCursor`). When both
   * are supplied, `cursor` takes precedence over `offset`.
   *
   * Sort order guarantee: wills are always returned sorted ascending by
   * `will_id`, so cursors are consistent across calls.
   */
  private paginate(
    wills: Will[],
    options?: (PaginationOptions & RequestOptions) | RequestOptions,
  ): Will[] | PaginatedWillsResult {
    const paginationOptions = options as PaginationOptions | undefined;
    if (
      !paginationOptions ||
      (paginationOptions.pageSize === undefined &&
        paginationOptions.limit === undefined &&
        paginationOptions.offset === undefined &&
        paginationOptions.cursor === undefined)
    ) {
      return wills;
    }
    const limit = resolvePageSize(paginationOptions);
    const start =
      paginationOptions.cursor !== undefined
        ? parseCursor(paginationOptions.cursor)
        : (normalizeNonNegativeInteger(paginationOptions.offset, 'offset') ?? 0);
    const pageSize = limit ?? Math.max(wills.length - start, 0);
    const page = wills.slice(start, start + pageSize);
    const nextIndex = start + page.length;
    const hasMore = nextIndex < wills.length;
    return {
      wills: page,
      nextCursor: hasMore ? String(nextIndex) : null,
      prevCursor: start > 0 ? String(Math.max(start - pageSize, 0)) : null,
      offset: start,
      limit,
      total: wills.length,
      hasMore,
    };
  }

  /**
   * Casts a guardian vote to force an early release of `willId`. Once 2 of
   * the will's guardians have voted, the balance is released automatically.
   *
   * **Operation Type:** Write (State-changing)
   *
   * @remarks Write operation. Submits a signed transaction to cast a guardian vote, altering ledger state.
   * Requires a connected wallet with guardian authorization.
   *
   * @param willId - The identifier of the will to vote on.
   * @param options - Optional request options.
   * @returns The transaction hash.
   * @throws {SoroWillError} If the transaction simulation/submission fails.
   * @throws {RequestTimeoutError} If the RPC request exceeds its configured timeout.
   * @throws {WillNotFoundError} If the will does not exist.
   * @throws {NotGuardianError} If the caller is not a guardian of this will.
   * @throws {AlreadyVotedError} If this guardian has already voted.
   * @throws {Error} If the wallet is not connected or fails to sign.
   *
   * @example
   * ```ts
   * const { txHash } = await client.guardianTrigger('1');
   * console.log(`Guardian vote submitted: ${txHash}`);
   * ```
   */
  async guardianTrigger(willId: string, options?: RequestOptions): Promise<{ txHash: string }> {
    parseWillId(willId);
    await this.assertWalletNetwork({ networkPassphrase: this.networkPassphrase });
    const guardian = await this.getWalletPublicKey();
    const { txHash, returnValue, events } = await this.invoke('guardian_trigger', {
      will_id: parseWillId(willId),
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

    void votesSoFar;
    void released;
    return { txHash };
  }

  /**
   * Validates that every operation in a batch targets the same Stellar network
   * and that this network is the one the client is configured for (#550).
   *
   * Operations that omit `network` inherit the client's network. Any operation
   * that declares a different network — or two operations that declare
   * *different* networks — is rejected with a {@link BatchNetworkMismatchError}
   * before any transaction is built, signed, or submitted.
   */
  private assertBatchNetworks(operations: readonly BatchOperation[]): void {
    let declaredNetwork: SoroWillNetwork | undefined;
    let declaredIndex = -1;

    operations.forEach((operation, index) => {
      const network = operation.network;
      if (network === undefined) {
        // Inherits the client's network — always compatible.
        return;
      }
      if (declaredNetwork !== undefined && declaredNetwork !== network) {
        throw new BatchNetworkMismatchError(this.network, network, index, {
          operationIndex: declaredIndex,
          network: declaredNetwork,
        });
      }
      declaredNetwork = network;
      declaredIndex = index;
    });

    // Every declared network agrees with itself — now check they also agree
    // with the network this client is configured for.
    if (declaredNetwork !== undefined && declaredNetwork !== this.network) {
      throw new BatchNetworkMismatchError(
        this.network,
        declaredNetwork,
        declaredIndex,
        undefined,
      );
    }
  }

  /**
   * Simulates, signs, and submits a raw contract call given by its native method name and arguments.
   * Arguments use the native names and values accepted by the deployed contract spec.
   *
   * **Maximum batch size: 1.** Soroban transactions may contain only a single
   * `InvokeHostFunction` operation, so a batch must contain exactly one
   * operation; multiple calls cannot be combined into one atomic transaction
   * and must be submitted separately.
   *
   * @param operations - Array containing a single {@link BatchOperation}.
   * @param options - Optional request options.
   * @returns The transaction hash and creation timestamp.
   * @throws {RangeError} If the batch contains zero operations.
   * @throws {UnsupportedBatchSizeError} If the batch contains more than one operation (i.e. exceeds the maximum batch size of 1).
   * @throws {SoroWillError} If the transaction simulation/submission fails.
   * @throws {RequestTimeoutError} If the RPC request exceeds its configured timeout.
   * @throws {WillContractError} Mapped contract-level errors from any operation in the batch.
   * @throws {Error} If the wallet is not connected or fails to sign.
   *
   * @example
   * ```ts
   * const result = await client.batch([
   *   { method: 'check_in', args: { will_id: 1n } }
   * ]);
   * console.log(`Batch operation txHash: ${result.txHash}`);
   * ```
   */
  async batch(
    operations: readonly BatchOperation[],
    options?: RequestOptions,
  ): Promise<BatchResult<readonly BatchOperation[]>>;
  async batch<const TOperations extends readonly BatchOperation[]>(
    operations: TOperations,
    options?: RequestOptions,
  ): Promise<BatchResult<TOperations>>;
  async batch<const TOperations extends readonly BatchOperation[]>(
    operations: TOperations,
    options?: RequestOptions,
  ): Promise<BatchResult<TOperations>> {
    if (operations.length === 0) {
      throw new RangeError('A batch must contain at least one operation');
    }
    // #635: Reject write operations in read-only mode.
    if (this.readOnly) {
      throw new ReadOnlyModeError('batch');
    }
    // #550: every operation must target the same network, and that network
    // must be the one the client is configured for. This runs before any
    // transaction is built, signed, or submitted so a batch can never mix
    // testnet and mainnet operations. It is checked before the batch-size
    // limit so a mixed-network batch reports the network problem rather
    // than the size problem.
    this.assertBatchNetworks(operations);
    if (operations.length > 1) {
      throw new UnsupportedBatchSizeError(operations.length);
    }
    if (operations[0].condition) {
      const shouldRun = await operations[0].condition([]);
      if (!shouldRun) {
        return {
          success: true,
          txHash: '',
          createdAt: 0,
          results: [
            {
              index: 0,
              method: operations[0].method,
              status: 'skipped',
              attempts: 0,
            },
          ] as unknown as BatchOperationResults<TOperations>,
        };
      }
    }
    await this.assertWalletNetwork({ networkPassphrase: this.networkPassphrase });
    const hookContexts = operations.map(({ method, args }) => ({
      before: {
        method,
        args,
        timestamp: new Date().toISOString(),
      } satisfies BeforeInvokeContext,
      startTime: Date.now(),
    }));
    for (const { before } of hookContexts) {
      const proceed = await this.hooks.runBeforeInvoke(before);
      if (!proceed) {
        throw new SoroWillError(`SoroWill invocation aborted by beforeInvoke hook for ${before.method}`);
      }
    }

    let txHash: string | null = null;
    let error: string | null = null;
    try {
      return await this.serializeWrite(async () => {
        const publicKey = await this.getWalletPublicKey();
        const spec = await this.getSpec(options);
        const contractOperations = operations.map(({ method, args }) =>
          this.contract.call(method, ...spec.funcArgsToScVals(method, args)),
        );

        const account = await this.rpc(
          () => this.rpcPool.withFailover((server) => server.getAccount(publicKey)),
          options,
          'getAccount',
        );
        const builder = new TransactionBuilder(account, {
          fee: BASE_FEE,
          networkPassphrase: this.networkPassphrase,
        });
        for (const op of contractOperations) {
          builder.addOperation(op);
        }
        const builtTx = builder.setTimeout(this.transactionTimeoutSeconds).build();

        const prepared = await this.rpc(
          () => this.rpcPool.withFailover((server) => server.prepareTransaction(builtTx)),
          options,
          'batch:prepareTransaction',
        );

        assertPreparedTransactionMatchesIntendedOperation({
          intendedTransactionXdr: builtTx.toXDR(),
          preparedTransactionXdr: prepared.toXDR(),
          networkPassphrase: this.networkPassphrase,
          context: 'batch',
        });

        const signedTxResponse = await this.signWithWallet(prepared.toXDR());
        const signedTxXdr = normalizeSignatureResponse(signedTxResponse);
        const result = await this.submitSignedTransaction(signedTxXdr, options);
        txHash = result.txHash;
        // Soroban allows a single invocation per transaction, so the
        // transaction's return value belongs to the (only) operation.
        const results = operations.map(({ method, args }) => {
          const native =
            result.returnValue === undefined ? undefined : spec.funcResToNative(method, result.returnValue);
          return { method, args, returnValue: native };
        }) as BatchOperationResults<TOperations>;
        const batchResult: BatchResult<TOperations> = {
          success: true,
          txHash: result.txHash,
          createdAt: result.createdAt,
          results,
        };
        return batchResult;
      });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      for (const { before, startTime } of hookContexts) {
        await this.hooks.runAfterInvoke({
          method: before.method,
          args: before.args,
          timestamp: new Date().toISOString(),
          txHash,
          error,
          durationMs: Date.now() - startTime,
        });
      }
    }
  }

  /**
   * Submits a queue of contract calls one after another, each as its own
   * transaction (Soroban allows one contract invocation per transaction, see
   * {@link batch}), and reports a per-operation outcome instead of throwing on
   * the first failure.
   *
   * Partial failures are handled explicitly rather than leaving later
   * operations queued against stale state:
   * - A failing operation is retried up to `maxRetries` times. Contract errors
   *   and wallet network mismatches are deterministic and are not retried.
   * - With `onFailure: 'stop'` (the default), every operation after a failure
   *   is marked `skipped` and never submitted. With `'continue'`, the rest of
   *   the queue still runs.
   * - Cached reads for every will touched by the queue are invalidated, so a
   *   subsequent read reflects whatever actually landed on-chain.
   * - Aborting `options.signal` marks every not-yet-submitted operation `skipped`.
   *
   * Operations that already succeeded are not rolled back — Soroban
   * transactions are final once they land.
   *
   * @returns A {@link BatchQueueResult} with one entry per operation, in queue order.
   * @throws {RangeError} If the queue is empty or `maxRetries` is not a non-negative integer.
   */
  async batchSequential(
    operations: readonly BatchOperation[],
    options: BatchQueueOptions = {},
  ): Promise<BatchQueueResult> {
    if (operations.length === 0) {
      throw new RangeError('A batch must contain at least one operation');
    }
    const { onFailure = 'stop', maxRetries = 0, ...requestOptions } = options;
    if (!Number.isInteger(maxRetries) || maxRetries < 0) {
      throw new RangeError('maxRetries must be a non-negative integer');
    }

    const results: BatchOperationResult[] = [];
    let halted: Error | undefined;

    for (const [index, { method, args, condition }] of operations.entries()) {
      if (!halted && requestOptions.signal?.aborted) {
        halted = new SoroWillError('Batch aborted before this operation was submitted', {
          cause: requestOptions.signal.reason,
        });
      }
      if (halted) {
        results.push({ index, method, status: 'skipped', error: halted, attempts: 0 });
        continue;
      }

      if (condition) {
        let shouldRun: boolean;
        try {
          shouldRun = await condition(results);
        } catch (err) {
          const conditionError = err instanceof Error ? err : new Error(String(err));
          results.push({ index, method, status: 'failed', error: conditionError, attempts: 0 });
          if (onFailure === 'stop') {
            halted = new SoroWillError(
              `Skipped because operation ${index} (${method}) condition failed: ${conditionError.message}`,
              { cause: conditionError },
            );
          }
          continue;
        }
        if (!shouldRun) {
          results.push({ index, method, status: 'skipped', attempts: 0 });
          continue;
        }
      }

      let attempts = 0;
      let lastError: Error | undefined;
      while (attempts <= maxRetries) {
        attempts++;
        try {
          const { txHash } = await this.invoke(method, args, requestOptions);
          results.push({ index, method, status: 'success', txHash, attempts });
          lastError = undefined;
          break;
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          if (
            err instanceof WillContractError ||
            err instanceof WalletNetworkMismatchError ||
            requestOptions.signal?.aborted
          ) {
            break;
          }
        }
      }

      if (lastError) {
        results.push({ index, method, status: 'failed', error: lastError, attempts });
        if (onFailure === 'stop') {
          halted = new SoroWillError(
            `Skipped because operation ${index} (${method}) failed: ${lastError.message}`,
            { cause: lastError },
          );
        }
      }
    }

    if (this.readCache) {
      const willIds = new Set(
        operations
          .map(({ args }) => args.will_id)
          .filter((willId) => willId !== undefined && willId !== null)
          .map((willId) => String(willId)),
      );
      await Promise.all([...willIds].map((willId) => this.readCache!.invalidateByWillId(willId)));
    }

    const count = (status: BatchOperationResult['status']): number =>
      results.filter((result) => result.status === status).length;
    const succeededCount = count('success');
    return {
      success: succeededCount === operations.length,
      results,
      succeededCount,
      failedCount: count('failed'),
      skippedCount: count('skipped'),
    };
  }

  /**
   * Builds a SEP-7 deep-link URI for a state-changing contract call, so a
   * mobile wallet can sign it outside the browser extension flow.
   *
   * **Operation Type:** Read-only (Builder)
   *
   * @readonly
   * @remarks Read-only builder operation. Simulates and prepares transaction XDR and creates a URI without submitting a transaction or modifying ledger state.
   *
   * @param method - The contract method name to invoke.
   * @param args - Arguments to pass to the method.
   * @param sourcePublicKey - Public key of the account executing the transaction.
   * @param options - Options for the SEP-7 URI construction.
   * @returns The `web+stellar:tx?...` URI string.
   * @throws {Error} If the RPC call to build the transaction fails.
   *
   * @example
   * ```ts
   * const uri = await client.buildSep7SigningUri(
   *   'check_in',
   *   { will_id: 1n },
   *   'GSOURCE...',
   *   { callback: 'https://example.com/callback' }
   * );
   * console.log(`SEP-7 URI: ${uri}`);
   * ```
   */
  async buildSep7SigningUri(
    method: string,
    args: Record<string, unknown>,
    sourcePublicKey: string,
    options: BuildSep7TxUriOptions,
  ): Promise<string> {
    await this.assertWalletNetwork({ networkPassphrase: this.networkPassphrase });
    const builtTx = await this.buildInvocationTransaction(method, args, sourcePublicKey);
    const prepared = await this.prepareInvocation(method, args, builtTx, sourcePublicKey);
    assertPreparedTransactionMatchesIntendedOperation({
      intendedTransactionXdr: builtTx.toXDR(),
      preparedTransactionXdr: prepared.toXDR(),
      networkPassphrase: this.networkPassphrase,
      context: `buildSep7SigningUri(${method})`,
    });
    return buildSep7TxUri(prepared.toXDR(), {
      ...options,
      networkPassphrase: options.networkPassphrase ?? this.networkPassphrase,
    });
  }

  /**
   * Simulates `method` with `args` and returns the Soroban resource fee the
   * network would charge, without signing or submitting anything. Useful for
   * showing a fee estimate in a UI before the user commits to a transaction.
   *
   * ## Fee calculation strategy
   *
   * The estimate is produced by a read-only Soroban simulation:
   *
   * 1. `resourceFee` = `simulation.minResourceFee` — the operation-specific
   *    Soroban resource cost (CPU instructions, memory, ledger reads/writes,
   *    storage rent). A `merge_wills` with many beneficiaries costs far more
   *    than a `check_in`.
   * 2. `totalFee` = `BASE_FEE` + `resourceFee` — the minimum total fee (in
   *    stroops) the network will accept for this call. `BASE_FEE` is the
   *    per-operation inclusion fee.
   *
   * The returned fees are strings (base-10 stroops) and can be displayed
   * directly or converted with {@link formatUSDC} / {@link formatTokenAmount}.
   *
   * ## Custom fee support
   *
   * The SDK does not expose an arbitrary per-transaction `maxFee` override.
   * Instead, fee control is handled through:
   *
   * - `autoFeeBumpOnTimeout` (client option): if a transaction doesn't land
   *   within the poll window, the SDK automatically rebuilds and resubmits it
   *   with a higher fee instead of throwing.
   * - `transactionTimeoutSeconds` (client option): the validity window set on
   *   every built transaction via `setTimeout()`.
   * - `previewFee`: simulate the actual cost before the user commits, so the
   *   UI can surface an accurate estimate rather than a hardcoded value.
   *
   * State-changing SDK calls always simulate via `prepareTransaction` before
   * submission, so the submitted fee already includes the simulated resource
   * fee — you generally do not need to size fees manually.
   *
   * ## Examples
   *
   * ```ts
   * const { resourceFee, totalFee } = await client.previewFee('check_in', {
   *   will_id: '42',
   *   owner: ownerPublicKey,
   * });
   * console.log(`Estimated total fee: ${totalFee} stroops`);
   *
   * // Show the estimate in a UI before the user signs.
   * if (BigInt(totalFee) > MAX_ACCEPTABLE_FEE) {
   *   warnUser('Fee is higher than expected');
   * }
   * ```
   *
   * @param method - The contract method name to simulate.
   * @param args - Native arguments to pass to the contract method.
   * @param options - Optional request options.
   * @returns Object containing `resourceFee` and `totalFee` as stringified Stroops.
   * @see https://developers.stellar.org/docs/learn/fundamentals/fees-resource-limits-metering
   *
   * @example
   * ```ts
   * const { resourceFee, totalFee } = await client.previewFee('check_in', { will_id: 1n });
   * console.log(`Estimated fee: ${totalFee} stroops (resource: ${resourceFee})`);
   * ```
   */
  async previewFee(
    method: string,
    args: Record<string, unknown>,
    options?: RequestOptions,
  ): Promise<{ resourceFee: string; totalFee: string }> {
    try {
      const spec = await this.getSpec(options);
      const scArgs = spec.funcArgsToScVals(method, args);
      const operation = this.contract.call(method, ...scArgs);

      const tx = this.buildInvocationEnvelope([operation], new Account(NULL_ACCOUNT, '0'));

      const simulation = await this.rpc(
        () => this.rpcPool.withFailover((server) => server.simulateTransaction(tx)),
        options,
        method,
      );
      if (rpc.Api.isSimulationError(simulation)) {
        throw new SimulationError(method, simulation.error);
      }
      return {
        resourceFee: simulation.minResourceFee,
        totalFee: (BigInt(BASE_FEE) + BigInt(simulation.minResourceFee)).toString(),
      };
    } catch (error) {
      throw mapContractError(error);
    }
  }

  /**
   * Estimates the fee and RPC call cost of invoking a contract method before
   * signing or submitting any transaction.
   *
   * **Operation Type:** Read-only (Simulation)
   *
   * @param method - The contract method name to simulate (e.g. `'check_in'`, `'create_will'`).
   * @param args - Native arguments to pass to the contract method.
   * @param options - Optional request options.
   * @returns Estimated resource fee, total fee (in stroops), and expected RPC call count.
   */
  async estimateCost(
    method: string,
    args: Record<string, unknown>,
    options?: RequestOptions,
  ): Promise<RequestCostEstimate> {
    const specFetchCalls = this.specPromise === undefined ? 1 : 0;
    const { resourceFee, totalFee } = await this.previewFee(method, args, options);
    // Execution performs: getAccount (1) + prepareTransaction (1) + sendTransaction (1) + waitForTransaction poll (>=1),
    // plus getSpec (1) if the contract spec has not yet been cached.
    const estimatedRpcCalls = 4 + specFetchCalls;
    return {
      resourceFee,
      totalFee,
      estimatedRpcCalls,
      method,
    };
  }

  /**
   * Subscribes to SoroWill contract events, delivering each decoded event to
   * `listener` as it arrives. Prefers a Server-Sent Events stream (via
   * `eventSseUrl`) when configured, then a WebSocket stream (via
   * `webSocketFactory` and `eventStreamUrl`) when both are configured,
   * automatically falling back to HTTP polling (via `fetch` and
   * `eventRpcUrl`) if the stream connection fails to open. Pass
   * `{ transport: 'sse' }` to require SSE (throws
   * {@link SseNotConfiguredError} when `eventSseUrl` is not configured), or
   * `{ transport: 'websocket' }` to require it — this throws
   * {@link WebSocketNotConfiguredError} instead of silently falling back to
   * polling if `webSocketFactory`/`eventStreamUrl` aren't configured.
   *
   * **Operation Type:** Read-only (Subscription)
   *
   * @readonly
   * @remarks Read-only subscription operation. Subscribes to contract events via SSE, WebSocket or polling without submitting transactions or modifying ledger state.
   *
   * @param listener - Callback receiving each incoming {@link SoroWillEvent}.
   * @param options - Subscription options (transport, cursor, intervals, etc.).
   * @returns A handle that can be used to close the subscription.
   *
   * @example
   * ```ts
   * const sub = await client.subscribeToEvents((event) => {
   *   console.log(`Event received: ${event.type}`);
   * });
   * // Later: sub.unsubscribe();
   * ```
   */
  async subscribeToEvents(
    listener: (event: SoroWillEvent) => void,
    options: EventSubscriptionOptions = {},
  ): Promise<EventSubscription> {
    validateEventCursor(options.cursor);
    const eventTypes = validateEventTypeFilter(options.eventTypes);
    if (eventTypes) {
      const userListener = listener;
      const allowed = new Set<string>(eventTypes);
      listener = (event) => {
        if (allowed.has(event.type)) userListener(event);
      };
      options = { ...options, eventTypes };
    }

    if (options.deduplicate !== false) {
      const userListener = listener;
      const deduplicator = new EventDeduplicator(
        options.deduplicationWindowSize !== undefined
          ? { maxSize: options.deduplicationWindowSize }
          : undefined,
      );
      listener = (event) => {
        if (deduplicator.shouldDeliver(event)) {
          userListener(event);
        }
      };
    }

    const wantsSse = options.transport === 'sse' || options.transport === undefined;
    if (wantsSse && this.eventSseUrl) {
      return this.startSseSubscription(listener, options);
    }
    if (options.transport === 'sse') {
      throw new SseNotConfiguredError();
    }

    const wantsWebSocket = options.transport !== 'polling';
    const canUseWebSocket = wantsWebSocket && !!this.webSocketFactory && !!this.eventStreamUrl;

    if (!canUseWebSocket) {
      if (options.transport === 'websocket') {
        throw new WebSocketNotConfiguredError();
      }
      return this.startPollingSubscription(listener, options);
    }

    return new Promise<EventSubscription>((resolve) => {
      const socket = this.webSocketFactory!(this.eventStreamUrl!);
      let settled = false;
      let closed = false;

      const connectTimeoutMs =
        options.websocketConnectTimeoutMs ?? DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS;
      let connectTimer: ReturnType<typeof setTimeout> | undefined;
      const clearConnectTimer = (): void => {
        if (connectTimer !== undefined) {
          clearTimeout(connectTimer);
          connectTimer = undefined;
        }
      };
      if (Number.isFinite(connectTimeoutMs) && connectTimeoutMs > 0) {
        connectTimer = setTimeout(() => {
          if (settled) return;
          settled = true;
          try {
            socket.close();
          } catch {
            // Best-effort close on a socket that never finished connecting.
          }
          options.onError?.(
            new Error(
              `SoroWill event WebSocket did not open within ${connectTimeoutMs}ms; falling back to polling.`,
            ),
          );
          resolve(this.startPollingSubscription(listener, options));
        }, connectTimeoutMs);
      }

      const subscription: EventSubscription = {
        transport: 'websocket',
        get closed() {
          return closed;
        },
        unsubscribe: () => {
          if (closed) return;
          closed = true;
          clearConnectTimer();
          try {
            socket.close();
          } catch {
            // Best-effort close; the socket may already be gone.
          }
        },
        close() {
          this.unsubscribe();
        },
      };

      socket.onopen = () => {
        if (settled) return;
        settled = true;
        clearConnectTimer();
        socket.send(
          JSON.stringify({
            type: 'subscribe',
            contractId: this.getContractId(),
            cursor: options.cursor,
            ...(options.eventTypes ? { eventTypes: options.eventTypes } : {}),
          }),
        );
        resolve(subscription);
      };

      socket.onmessage = (event) => {
        if (closed) return;
        try {
          const payload = JSON.parse(event.data) as { result?: { events?: RawEventRecord[] } };
          for (const raw of payload.result?.events ?? []) {
            if (closed) break;
            // Isolate listener failures per event so a throwing listener neither
            // stalls the rest of the batch nor tears down the subscription.
            try {
              listener(mapEventRecord(raw, this.getContractId()));
            } catch (listenerError) {
              const eventId = raw.id ?? raw.pagingToken ?? 'unknown';
              options.onError?.(
                new SoroWillError(`Event listener threw for event ${eventId}`, { cause: listenerError }),
              );
            }
          }
        } catch (err) {
          options.onError?.(err instanceof Error ? err : new Error(String(err)));
        }
      };

      socket.onerror = () => {
        if (settled) {
          // #210: a drop after the subscription already opened is not
          // auto-recovered (falling back to polling here would silently
          // change transport mid-stream) — surface the error and mark the
          // subscription closed so callers know to react themselves.
          closed = true;
          try {
            socket.close();
          } catch {
            // Best-effort close; the socket may already be gone.
          }
          options.onError?.(new Error('SoroWill event WebSocket stream error'));
          return;
        }
        settled = true;
        clearConnectTimer();
        try {
          socket.close();
        } catch {
          // Best-effort close on a connection that never opened.
        }
        resolve(this.startPollingSubscription(listener, options));
      };

      socket.onclose = () => {
        closed = true;
        if (settled) return;
        settled = true;
        clearConnectTimer();
        resolve(this.startPollingSubscription(listener, options));
      };
    });
  }

  /**
   * Subscribes to contract events over Server-Sent Events (SSE), decoding each
   * `data:` frame as an event record and delivering it to `listener`.
   *
   * The connection auto-reconnects with exponential backoff when the stream
   * drops, resuming from the last seen cursor. Connection failures are
   * reported through `options.onError`; if the initial connection cannot be
   * established the subscription falls back to polling (unless
   * `transport: 'sse'` was requested explicitly, in which case the error is
   * surfaced and the subscription is closed).
   */
  private async startSseSubscription(
    listener: (event: SoroWillEvent) => void,
    options: EventSubscriptionOptions,
  ): Promise<EventSubscription> {
    const baseUrl = this.eventSseUrl!;
    const connectTimeoutMs = options.sseConnectTimeoutMs ?? DEFAULT_SSE_CONNECT_TIMEOUT_MS;
    const baseReconnectDelayMs = options.sseReconnectDelayMs ?? DEFAULT_SSE_RECONNECT_DELAY_MS;
    const maxReconnectDelayMs = options.sseMaxReconnectDelayMs ?? DEFAULT_SSE_MAX_RECONNECT_DELAY_MS;
    const maxReconnectAttempts = options.sseMaxReconnectAttempts ?? Infinity;

    let closed = false;
    let settled = false;
    let cursor = options.cursor;
    let reconnectAttempts = 0;
    let controller: AbortController | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    const buildUrl = (): string => {
      const url = new URL(baseUrl);
      url.searchParams.set('contractId', this.getContractId());
      if (cursor !== undefined) url.searchParams.set('cursor', cursor);
      for (const type of options.eventTypes ?? []) url.searchParams.append('eventType', type);
      return url.toString();
    };

    const deliver = (data: string): void => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch (err) {
        options.onError?.(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      const records = Array.isArray(parsed)
        ? (parsed as RawEventRecord[])
        : ((parsed as { events?: RawEventRecord[] }).events ?? [parsed as RawEventRecord]);
      for (const raw of records) {
        if (closed) return;
        if (raw?.pagingToken ?? raw?.id) cursor = raw.pagingToken ?? raw.id;
        try {
          listener(mapEventRecord(raw, this.getContractId()));
        } catch (listenerError) {
          const eventId = raw?.id ?? raw?.pagingToken ?? 'unknown';
          options.onError?.(
            new SoroWillError(`Event listener threw for event ${eventId}`, { cause: listenerError }),
          );
        }
      }
    };

    const scheduleReconnect = (): void => {
      if (closed) return;
      if (reconnectAttempts >= maxReconnectAttempts) {
        closed = true;
        options.onError?.(new Error('SoroWill SSE stream reconnect attempts exhausted'));
        return;
      }
      const delay = Math.min(baseReconnectDelayMs * 2 ** reconnectAttempts, maxReconnectDelayMs);
      reconnectAttempts += 1;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined;
        void connect();
      }, delay);
    };

    const connect = async (): Promise<void> => {
      if (closed) return;
      const abort = new AbortController();
      controller = abort;
      let connectTimer: ReturnType<typeof setTimeout> | undefined;
      if (Number.isFinite(connectTimeoutMs) && connectTimeoutMs > 0) {
        connectTimer = setTimeout(() => abort.abort(), connectTimeoutMs);
      }
      try {
        const response = await this.fetchImpl(buildUrl(), {
          headers: { Accept: 'text/event-stream' },
          signal: abort.signal,
        });
        if (!response.ok || !response.body) {
          throw new Error(`SoroWill SSE endpoint responded with status ${response.status}`);
        }
        if (connectTimer !== undefined) {
          clearTimeout(connectTimer);
          connectTimer = undefined;
        }
        reconnectAttempts = 0;
        if (!settled) {
          settled = true;
          resolveSse(subscription);
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done || closed) break;
          buffer += decoder.decode(value, { stream: true });
          let boundary = buffer.indexOf('\n\n');
          while (boundary !== -1) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const dataLines: string[] = [];
            for (const line of frame.split('\n')) {
              const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line;
              if (trimmed.startsWith('data:')) {
                dataLines.push(trimmed.slice(trimmed.startsWith('data: ') ? 6 : 5));
              }
            }
            if (dataLines.length > 0) deliver(dataLines.join('\n'));
            boundary = buffer.indexOf('\n\n');
          }
        }
        if (closed) return;
        options.onError?.(new Error('SoroWill SSE stream closed'));
        scheduleReconnect();
      } catch (err) {
        if (closed) return;
        options.onError?.(err instanceof Error ? err : new Error(String(err)));
        if (!settled) {
          settled = true;
          resolveSse(this.startPollingSubscription(listener, options));
          return;
        }
        scheduleReconnect();
      } finally {
        if (connectTimer !== undefined) clearTimeout(connectTimer);
      }
    };

    let resolveSse!: (subscription: EventSubscription) => void;
    const subscription: EventSubscription = {
      transport: 'sse',
      get closed() {
        return closed;
      },
      unsubscribe: () => {
        if (closed) return;
        closed = true;
        if (reconnectTimer !== undefined) {
          clearTimeout(reconnectTimer);
          reconnectTimer = undefined;
        }
        try {
          controller?.abort();
        } catch {
          // Best-effort abort; the stream may already be gone.
        }
      },
      close() {
        this.unsubscribe();
      },
    };

    return new Promise<EventSubscription>((resolve) => {
      resolveSse = resolve;
      void connect();
    });
  }

  /** Polls for new events on an interval, decoding and delivering each to `listener`. */
  private async startPollingSubscription(
    listener: (event: SoroWillEvent) => void,
    options: EventSubscriptionOptions,
  ): Promise<EventSubscription> {
    const pollIntervalMs = options.pollIntervalMs ?? this.defaultPollIntervalMs;
    let cursor = options.cursor;
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const subscription: EventSubscription = {
      transport: 'polling',
      get closed() {
        return closed;
      },
      unsubscribe: () => {
        if (closed) return;
        closed = true;
        if (timer !== undefined) clearTimeout(timer);
      },
      close() {
        this.unsubscribe();
      },
    };

    const poll = async (): Promise<void> => {
      if (closed) return;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(this.eventRpcUrl, {
          method: 'POST',
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getEvents',
            params: {
              filters: buildEventFilters(this.getContractId(), options.eventTypes),
              pagination: { cursor, limit: options.pageSize },
            },
          }),
        });
        if (!response.ok) {
          throw new SoroWillError(`getEvents poll failed with HTTP status ${response.status}`);
        }
        const payload = (await response.json()) as {
          result?: { events?: RawEventRecord[]; nextCursor?: string };
          error?: { code?: number; message?: string };
        };
        if (payload.error) {
          throw new SoroWillError(
            `getEvents poll failed with JSON-RPC error ${payload.error.code}: ${payload.error.message ?? 'unknown error'}`,
          );
        }
        for (const raw of payload.result?.events ?? []) {
          if (closed) break;
          // Isolate listener failures per event so a throwing listener neither stalls
          // cursor progress nor causes the same events to be redelivered.
          try {
            listener(mapEventRecord(raw, this.getContractId()));
          } catch (listenerError) {
            const eventId = raw.id ?? raw.pagingToken ?? 'unknown';
            options.onError?.(
              new SoroWillError(`Event listener threw for event ${eventId}`, { cause: listenerError }),
            );
          }
        }
        if (payload.result?.nextCursor !== undefined) {
          cursor = payload.result.nextCursor;
        }
      } catch (err) {
        if (controller.signal.aborted) {
          options.onError?.(new RequestTimeoutError(this.timeoutMs, 'getEvents'));
        } else {
          options.onError?.(err instanceof Error ? err : new Error(String(err)));
        }
      } finally {
        clearTimeout(timeout);
        if (!closed) {
          timer = setTimeout(() => void poll(), pollIntervalMs);
        }
      }
    };

    await poll();
    return subscription;
  }

  /**
   * Attempts to cancel an in-flight operation by its will ID and method name.
   *
   * **Operation Type:** Read-only (No state change)
   *
   * @readonly
   * @remarks Returns true if an operation was found and aborted, false if no operation was in flight.
   */
  cancelOperation(willId: string | bigint, method: string): boolean {
    return this.inFlightTracker.abort(willId, method);
  }

  /**
   * Tears down the client: unsubscribes from any event source, aborts all
   * in-flight tracked operations, and rejects every queued-but-not-yet-started
   * request so nothing continues running in the background after teardown.
   *
   * **Operation Type:** Read-only (Teardown / Lifecycle)
   *
   * @readonly
   * @remarks Read-only lifecycle operation. Cleans up internal timers, subscriptions, and queues without modifying ledger state.
   *
   * @example
   * ```ts
   * client.destroy();
   * ```
   */
  destroy(): void {
    if (this.eventSubscription) {
      unsubscribeFromWillEvents(this.eventSubscription);
      this.eventSubscription = undefined;
    }
    this.stopWatchingWalletNetwork?.();
    this.inFlightTracker.clear();
    this.inFlightReads.clear();
    this.queue.rejectAll(new Error('SoroWillClient destroyed'));
  }

  /**
   * Returns the contract address this client was configured with.
   *
   * **Operation Type:** Read-only (Query)
   *
   * @readonly
   * @remarks Read-only query operation. Returns the contract ID from client configuration without network calls or state modification.
   *
   * Useful when a consumer needs to display which contract a client is
   * connected to (e.g. in a UI or a diagnostic log) without having to hold
   * onto the original `SoroWillClientOptions` object separately.
   *
   * @returns The contract ID string.
   *
   * @example
   * ```ts
   * const contractId = client.getContractId();
   * console.log(`Target contract: ${contractId}`);
   * ```
   */
  getContractId(): string {
    return this.contract.contractId();
  }

  /**
   * Returns the Stellar network this client was configured with.
   *
   * **Operation Type:** Read-only (Query)
   *
   * @readonly
   * @remarks Read-only query operation. Returns the network configuration without network calls or state modification.
   *
   * Useful when a consumer needs to make decisions based on which network a
   * client was built for — e.g. displaying "connected to testnet" in a UI,
   * or guarding against accidentally running mainnet logic in a test
   * environment.
   *
   * @returns The {@link SoroWillNetwork} identifier.
   *
   * @example
   * ```ts
   * const network = client.getNetwork();
   * console.log(`Configured network: ${network}`);
   * ```
   */
  getNetwork(): SoroWillNetwork {
    return this.network;
  }

  /**
   * Version information for the deployed contract's spec, or `null` until the
   * spec has been loaded (by any contract call, {@link getContractSpecVersion}
   * or {@link refreshSpec}).
   *
   * Compare `fingerprint` across sessions to detect contract upgrades, and
   * check `compatible` / `missingMethods` to detect an SDK/contract mismatch.
   */
  get contractSpecVersion(): ContractSpecVersion | null {
    return this.specVersion;
  }

  /**
   * Loads the contract spec if needed and returns its version information.
   * A mismatch with this SDK (or with `expectedContractVersion`) is logged
   * with `console.warn`.
   */
  async getContractSpecVersion(options?: RequestOptions): Promise<ContractSpecVersion> {
    await this.getSpec(options);
    return this.specVersion ?? computeContractSpecVersion(undefined);
  }

  /** Derives the spec version from a freshly loaded spec and warns once per distinct mismatch. */
  private recordSpecVersion(spec: unknown, wasm?: Uint8Array): void {
    const version = computeContractSpecVersion(spec, wasm);
    this.specVersion = version;
    const warning = describeContractVersionMismatch(version, this.expectedContractVersion);
    if (warning !== null && !this.warnedSpecVersions.has(warning)) {
      this.warnedSpecVersions.add(warning);
      console.warn(warning);
    }
  }

  /** Lazily fetches and caches the contract's spec from its deployed wasm. */
  private async getSpec(
    options?: RequestOptions,
  ): Promise<InstanceType<typeof Spec>> {
    // TTL-based expiry: if the spec was fetched from the network (not from an
    // explicit override) and the TTL has elapsed, treat it as stale and clear
    // the cache so it is re-fetched on the next call. This allows the client to
    // pick up new method signatures after a contract upgrade (#502).
    const isFetchedSpec = !this.specOverride && !this.specJsonOverride;
    if (
      isFetchedSpec &&
      this.specPromise !== undefined &&
      this.specResolvedAt !== undefined &&
      Number.isFinite(this.specCacheTtlMs) &&
      Date.now() - this.specResolvedAt > this.specCacheTtlMs
    ) {
      this.specPromise = undefined;
      this.specResolvedAt = undefined;
    }

    if (!this.specPromise) {
      if (this.specOverride) {
        this.specPromise = (Promise.resolve(this.specOverride) as Promise<InstanceType<typeof Spec>>).then(
          (spec) => {
            this.recordSpecVersion(spec);
            return spec;
          },
        );
      } else if (this.specJsonOverride) {
        const wasm = this.specJsonOverride;
        const spec = Spec.fromWasm(Buffer.from(wasm));
        this.recordSpecVersion(spec, wasm);
        this.specPromise = Promise.resolve(spec);
      } else {
        // A rejected spec fetch must not stay cached forever — clear it so
        // the next call retries instead of replaying the same failure.
        this.specPromise = this.rpc(
          () => this.server.getContractWasmByContractId(this.contract.contractId()),
          options,
          'getContractWasmByContractId',
        )
          .then((wasm) => {
            const spec = Spec.fromWasm(Buffer.from(wasm));
            // Record when the spec was successfully resolved so TTL expiry can
            // be checked on the next call (#502).
            this.specResolvedAt = Date.now();
            this.recordSpecVersion(spec, wasm);
            return spec;
          })
          .catch((error: unknown) => {
            this.specPromise = undefined;
            this.specResolvedAt = undefined;
            throw error;
          });
      }
    }
    return await this.specPromise;
  }

  /**
   * Simulates a read-only contract call, requiring no connected wallet or
   * signature. Identical concurrent calls (same method, arguments and
   * request options) are coalesced into a single RPC simulation (#619).
   */
  private async read<T>(
    method: string,
    args: Record<string, unknown>,
    options?: RequestOptions,
  ): Promise<T> {
    const rawCacheKey = this.readCache ? createReadCacheKey(`raw:${method}`, args) : undefined;
    if (this.readCache && rawCacheKey && !options?.skipCache) {
      await this.readCache.ready();
      const cached = this.readCache.get<T>(rawCacheKey);
      if (cached !== undefined) {
        return cached;
      }
    }

    const executeAndCache = async (): Promise<T> => {
      const value = await this.executeRead<T>(method, args, options);
      if (this.readCache && rawCacheKey) {
        const willIds =
          args.will_id !== undefined && args.will_id !== null ? [String(args.will_id)] : [];
        this.readCache.set(rawCacheKey, value, willIds);
      }
      return value;
    };

    if (!this.deduplicateReads || options?.signal) {
      return executeAndCache();
    }

    const key = createReadCacheKey(method, {
      args,
      retries: options?.retries,
      timeout: options?.timeout,
      timeoutMs: options?.timeoutMs,
    });
    const existing = this.inFlightReads.get(key);
    if (existing) {
      return existing as Promise<T>;
    }

    const pending = executeAndCache().finally(() => {
      if (this.inFlightReads.get(key) === pending) {
        this.inFlightReads.delete(key);
      }
    });
    this.inFlightReads.set(key, pending);
    return pending;
  }

  private async executeRead<T>(
    method: string,
    args: Record<string, unknown>,
    options?: RequestOptions,
  ): Promise<T> {
    // Never deduplicate reads with AbortSignals, since each caller should control
    // their own cancellation independently (#619).
    if (!this.deduplicateReads || options?.signal) {
      return this._readOnce<T>(method, args, options);
    }

    // Deduplicate concurrent identical read calls so that N concurrent callers
    // asking for the same data only fire one RPC simulation, preventing
    // connection exhaustion on high concurrency (#504).
    const dedupKey = `read::${method}::${JSON.stringify(args, (_k, v) =>
      typeof v === 'bigint' ? v.toString() : (v as unknown),
    )}`;
    return this.inFlightTracker.trackByKey(dedupKey, () => this._readOnce<T>(method, args, options)) as Promise<T>;
  }

  /** Executes a single read RPC simulation. Called by {@link read} after deduplication. */
  private async _readOnce<T>(
    method: string,
    args: Record<string, unknown>,
    options?: RequestOptions,
  ): Promise<T> {
    try {
      const spec = await this.getSpec(options);
      const scArgs = spec.funcArgsToScVals(method, args);
      const operation = this.contract.call(method, ...scArgs);

      const tx = this.buildInvocationEnvelope([operation], new Account(NULL_ACCOUNT, '0'));

      const simulation = await this.withRetry(() =>
        this.rpc(
          () => this.rpcPool.withFailover((server) => server.simulateTransaction(tx)),
          options,
          method,
        ),
      );
      if (rpc.Api.isSimulationError(simulation)) {
        throw new SimulationError(method, simulation.error);
      }
      if (rpc.Api.isSimulationRestore(simulation)) {
        throw new SoroWillRestoreRequiredError(
          `SoroWill simulation for ${method} requires ledger-entry restoration before this call can proceed. ` +
            'Build and submit a restoreFootprint operation using the restore preamble on this error, then retry.',
          simulation,
        );
      }
      if (!simulation.result) {
        throw new SoroWillError(`SoroWill simulation for ${method} returned no result`);
      }
      if (simulation.result.retval === undefined || simulation.result.retval === null) {
        throw new SoroWillError(
          `SoroWill simulation for ${method} returned a malformed result: retval is missing. ` +
            'This usually means the RPC node returned an unexpected response shape.',
        );
      }

      return spec.funcResToNative(method, simulation.result.retval) as T;
    } catch (error) {
      throw mapContractError(error);
    }
  }

  /**
   * Builds, simulates, signs, and submits a state-changing contract call.
   * Use public write methods such as `createWill` or `triggerWill` to change
   * ledger state. Read methods only simulate and return a value; they do not
   * sign or submit. Each invocation performs simulation plus submission and
   * finality polling, so it costs more RPC requests and time than a read.
   * RPC requests use the client timeout (30 seconds by default), overridden
   * for this call with `options.timeoutMs`.
   */
  private async invoke(
    method: string,
    args: Record<string, unknown>,
    options?: RequestOptions,
  ): Promise<{ txHash: string; createdAt: number; returnValue: ScVal | undefined; events?: Array<{ topics: string[]; data: unknown }> }> {
    // #635: Reject all write operations when the client is in read-only mode.
    if (this.readOnly) {
      throw new ReadOnlyModeError(method);
    }
    // #520: Validate that the connected wallet's network matches the client's
    // configured network before building or signing any transaction. This is a
    // defense-in-depth check; individual public methods also call
    // assertWalletNetwork before invoking.
    await this.assertWalletNetwork({ networkPassphrase: this.networkPassphrase });

    const willId = args.will_id === undefined ? undefined : String(args.will_id);
    const execute = async (options: RequestOptions | undefined, trackerSignal: AbortSignal): Promise<{
      txHash: string;
      createdAt: number;
      returnValue: ScVal | undefined;
      events?: Array<{ topics: string[]; data: unknown }>;
    }> => {
    // Combine tracker signal with user-provided signal from options
    const userSignal = options?.signal;
    const signals = userSignal ? [trackerSignal, userSignal] : [trackerSignal];

    // Run beforeInvoke hooks
    const beforeCtx: BeforeInvokeContext = {
      method,
      args,
      timestamp: new Date().toISOString(),
    };
    const proceed = await this.hooks.runBeforeInvoke(beforeCtx);
    if (!proceed) {
      await this.hooks.runAfterInvoke({
        method,
        args,
        timestamp: new Date().toISOString(),
        txHash: null,
        error: `SoroWill invocation aborted by beforeInvoke hook for ${method}`,
        durationMs: 0,
      });
      throw new SoroWillError(`SoroWill invocation aborted by beforeInvoke hook for ${method}`);
    }

    const startTime = Date.now();
    let txHash: string | null = null;
    let error: string | null = null;

    // Set up abort listeners for both signals (outside try so finally can clean up)
    const abortListeners: Array<() => void> = [];
    const abortPromises: Array<Promise<never>> = [];

    try {
      // Check if any signal is already aborted
      for (const sig of signals) {
        if (sig.aborted) {
          throw sig.reason;
        }
      }

      for (const sig of signals) {
        const abortPromise = new Promise<never>((_, reject) => {
          const listener = () => reject(sig.reason);
          abortListeners.push(listener);
          sig.addEventListener('abort', listener);
        });
        abortPromises.push(abortPromise);
      }

      const spec = await this.getSpec(options);
      this.debugLogger.logOperationBuild(method, willId);

      const operation = this.contract.call(method, ...spec.funcArgsToScVals(method, args));
      const result = await Promise.race([
        this.submit([operation], method, options),
        ...abortPromises,
      ]);

      txHash = result.txHash;

      this.debugLogger.logSuccess(
        method,
        willId,
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
      this.debugLogger.logError(method, willId, err instanceof Error ? err : String(err));
      throw err;
    } finally {
      // Always clean up abort listeners, even on error or abort
      for (let i = 0; i < signals.length; i++) {
        signals[i]!.removeEventListener('abort', abortListeners[i]!);
      }

      if (error) {
        const afterCtx: AfterInvokeContext = {
          method,
          args,
          timestamp: new Date().toISOString(),
          txHash,
          error,
          durationMs: Date.now() - startTime,
        };
        try {
          await this.hooks.runAfterInvoke(afterCtx);
        } catch (hookError) {
          this.debugLogger.logError(
            method,
            willId,
            hookError instanceof Error
              ? `afterInvoke hook threw: ${hookError.message}`
              : `afterInvoke hook threw: ${String(hookError)}`,
          );
        }
      }
    }
    };

    const run = (signal: AbortSignal) => {
      return execute(options, signal);
    };

    if (willId === undefined) {
      return run(new AbortController().signal);
    }
    // Some state-changing methods must never run two concurrent invocations
    // for the same will: a duplicate would submit a second transaction
    // on-chain. Those are routed through trackExclusive so the duplicate is
    // rejected with a DuplicateOperationError instead of being coalesced
    // onto the in-flight promise (#523).
    const tracked = EXCLUSIVE_INVOKE_METHODS.has(method)
      ? this.inFlightTracker.trackExclusive(willId, method, run)
      : this.inFlightTracker.track(willId, method, run);
    return tracked as Promise<{
          txHash: string;
          createdAt: number;
          returnValue: ScVal | undefined;
          events?: Array<{ topics: string[]; data: unknown }>;
        }>;
  }

  /**
   * Runs state-changing submissions for this client's account strictly one at a
   * time, in call order. Each write loads the account sequence number, signs,
   * submits, and waits for a terminal status (including any RPC retries or
   * fee-bump resubmission) before the next write starts, so a retried operation
   * can never land after an operation that was issued later.
   */
  private serializeWrite<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeChain.then(operation, operation);
    this.writeChain = result.catch(() => undefined);
    return result;
  }

  /** Builds, signs, submits, and polls a set of operations as one transaction, serialized per account. */
  private submit(
    operations: readonly xdr.Operation[],
    label: string,
    options?: RequestOptions,
  ): Promise<{
    txHash: string;
    createdAt: number;
    returnValue: ScVal | undefined;
    events?: Array<{ topics: string[]; data: unknown }>;
  }> {
    return this.serializeWrite(() => this.submitUnserialized(operations, label, options));
  }

  /** Builds, signs, submits, and polls a set of operations as one transaction. */
  private async submitUnserialized(
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

    // #573: Tracks the XDR key added to `signedTransactionHashes` by THIS
    // submission. Declared outside try/finally so the finally block can
    // release it after submission completes without clobbering a hash that
    // a concurrently-detected duplicate attempt is holding.
    let trackedHash: string | undefined;

    try {
      await this.assertWalletNetwork({ networkPassphrase: this.networkPassphrase });
      const publicKey = await this.getWalletPublicKey();
      options?.signal?.throwIfAborted();
      let account: Account;
      try {
        account = await this.rpc(
          () => this.rpcPool.withFailover((server) => server.getAccount(publicKey)),
          options,
          `${label}:getAccount`,
        );
      } catch (getAccountError) {
        // Surface a clear, actionable error when the account is not funded or
        // does not exist on the network, rather than leaking the raw RPC error.
        throw new AccountNotFundedError(publicKey, { cause: getAccountError });
      }
      const baseFee = BigInt(BASE_FEE) * BigInt(operations.length);
      const builder = new TransactionBuilder(account, {
        fee: baseFee.toString(),
        networkPassphrase: this.networkPassphrase,
      });
      for (const operation of operations) builder.addOperation(operation);
      options?.signal?.throwIfAborted();
      const builtTx = builder.setTimeout(this.transactionTimeoutSeconds).build();
      this.assertTransactionNetwork(builtTx);

      options?.signal?.throwIfAborted();
      // prepareTransaction simulates and assembles Soroban data for the whole transaction.
      options?.signal?.throwIfAborted();
      const prepared = await this.rpc(
        () => this.rpcPool.withFailover((server) => server.prepareTransaction(builtTx)),
        options,
        `${label}:prepareTransaction`,
      );
      this.assertTransactionNetwork(prepared);
      this.debugLogger.logSimulation(label, undefined, prepared.fee);

      if (options?.maxFee !== undefined) {
        const maxFeeBigInt = BigInt(options.maxFee);
        if (BigInt(prepared.fee) > maxFeeBigInt) {
          throw new ExorbitantFeeError(String(prepared.fee), maxFeeBigInt.toString());
        }
      }

      // #573: Prevent duplicate signing of the same transaction. The
      // prepared transaction's XDR encodes its full contents (source account,
      // sequence number, operations, fee, timeout) and is identical before
      // and after signing, so we can use it as a content-derived key to detect
      // duplicates before sending to the wallet. The hash is tracked for the
      // duration of this submission and released in the finally block so that
      // sequential submissions (e.g. retries) are not blocked.
      const txXdrKey = prepared.toXDR();
      if (this.signedTransactionHashes.has(txXdrKey)) {
        throw new SoroWillError(
          `Transaction ${txXdrKey.slice(0, 16)}... has already been signed by this client. ` +
            'Refusing to sign again to prevent duplicate submissions.',
        );
      }
      this.signedTransactionHashes.add(txXdrKey);
      trackedHash = txXdrKey;

      options?.signal?.throwIfAborted();
      const signedTxResponse = await this.wallet.signTransaction(prepared.toXDR(), {
        networkPassphrase: this.networkPassphrase,
      });
      options?.signal?.throwIfAborted();
      const signedTxXdr = normalizeSignatureResponse(signedTxResponse);
      const signedTx = TransactionBuilder.fromXDR(
        signedTxXdr,
        this.networkPassphrase,
      );
      if (!(signedTx instanceof Transaction)) {
        throw new SoroWillError(
          'Expected a plain Transaction envelope after signing, but received FeeBumpTransaction',
        );
      }
      assertSupportedSignatureAlgorithm(signedTx, { context: label });

      options?.signal?.throwIfAborted();
      // Failover only retries connection-level errors (see RpcEndpointPool). Re-sending the
      // same signed envelope is safe: it has the same hash and sequence number, so the
      // network applies it at most once and never double-executes the invocation.
      const sendResponse = await this.rpc(
        () => this.rpcPool.withFailover((server) => server.sendTransaction(signedTx)),
        options,
        `${label}:sendTransaction`,
      );
      this.debugLogger.logSubmission(label, undefined, sendResponse.hash);

      // Handle distinct sendTransaction statuses per the Soroban RPC spec.
      if (sendResponse.status === 'ERROR') {
        const errorXdr = sendResponse.errorResult?.toXDR?.('base64') ?? 'no error result';
        throw new InvokeFailedError(label, `sendTransaction returned ERROR`, {
          status: sendResponse.status,
          errorXdr,
          diagnosticEventsXdr: (sendResponse as unknown as Record<string, unknown>).diagnosticEventsXdr ?? null,
          hash: sendResponse.hash,
        });
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
      let txResponse: { createdAt: number; returnValue: xdr.ScVal | undefined };
      try {
        txResponse = await this.waitForTransaction(sendResponse.hash, options);
      } catch (pollError) {
        // If poll times out and auto fee-bump is enabled, retry with higher fee
        if (this.autoFeeBumpOnTimeout) {
          this.debugLogger.logPoll(label);

          const feeBumpFee = (await this.computeBumpedFee(baseFee, options)).toString();
          // Building the first transaction incremented `account`'s sequence number, so rebuild
          // from a fresh Account one below the pending transaction's sequence: the resubmission
          // then reuses that sequence and replaces the pending transaction instead of following it.
          const retrySource = new Account(publicKey, (BigInt(builtTx.sequence) - 1n).toString());
          const feeBumpBuilder = new TransactionBuilder(retrySource, {
            fee: feeBumpFee,
            networkPassphrase: this.networkPassphrase,
          });
          for (const operation of operations) feeBumpBuilder.addOperation(operation);
          const feeBumpTx = feeBumpBuilder.setTimeout(this.transactionTimeoutSeconds).build();
          this.assertTransactionNetwork(feeBumpTx);

          const feeBumpPrepared = await this.rpc(
            () => this.rpcPool.withFailover((server) => server.prepareTransaction(feeBumpTx)),
            options,
            `${label}:prepareTransaction`,
          );
          this.assertTransactionNetwork(feeBumpPrepared);

          const feeBumpSignedResponse = await this.signWithWallet(feeBumpPrepared.toXDR());
          const feeBumpSignedXdr = normalizeSignatureResponse(feeBumpSignedResponse);
          const feeBumpSignedTx = TransactionBuilder.fromXDR(
            feeBumpSignedXdr,
            this.networkPassphrase,
          );
          if (!(feeBumpSignedTx instanceof Transaction)) {
            throw new SoroWillError(
              'Expected a plain Transaction envelope after signing, but received FeeBumpTransaction',
            );
          }
          assertSupportedSignatureAlgorithm(feeBumpSignedTx, { context: `${label} (fee bump)` });

          const feeBumpResponse = await this.rpc(
            () => this.rpcPool.withFailover((server) => server.sendTransaction(feeBumpSignedTx)),
            options,
            `${label}:sendTransaction`,
          );

          if (feeBumpResponse.status === 'ERROR') {
            const errorXdr = feeBumpResponse.errorResult?.toXDR?.('base64') ?? 'no error result';
            throw new InvokeFailedError(label, `fee-bump sendTransaction returned ERROR`, {
              status: feeBumpResponse.status,
              errorXdr,
              diagnosticEventsXdr: (feeBumpResponse as unknown as Record<string, unknown>).diagnosticEventsXdr ?? null,
              hash: feeBumpResponse.hash,
            });
          }

          this.debugLogger.logSubmission(label, undefined, feeBumpResponse.hash);

          txResponse = await this.waitForTransaction(feeBumpResponse.hash, options);
        } else {
          throw pollError;
        }
      }

      // Extract events from the transaction result meta, if available.
      // waitForTransaction returns the raw response; cast to access events.
      const rawResponse = txResponse as unknown as Record<string, unknown>;
      let events: Array<{ topics: string[]; data: unknown }> | undefined;
      if (Array.isArray(rawResponse.events)) {
        events = rawResponse.events as Array<{ topics: string[]; data: unknown }>;
      }

      return {
        txHash: sendResponse.hash,
        createdAt: txResponse.createdAt,
        returnValue: txResponse.returnValue,
        ...(events !== undefined ? { events } : {}),
      };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw error;
      }
      throw mapContractError(error);
    } finally {
      // #573: Release the hash only if THIS submission added it, so a
      // rejected duplicate attempt cannot release a hash still held by the
      // in-flight original submission.
      if (trackedHash !== undefined) {
        this.signedTransactionHashes.delete(trackedHash);
      }
    }
  }

  /**
   * Hands a prepared transaction to the configured wallet for signing, first
   * verifying that the wallet's session has not expired so a stale session
   * fails fast with a {@link WalletSessionExpiredError} rather than an opaque
   * downstream wallet error.
   */
  private async signWithWallet(transactionXdr: string): Promise<string | SignatureResponse> {
    await assertWalletSessionActive(this.wallet);
    const envelope = TransactionBuilder.fromXDR(transactionXdr, this.networkPassphrase);
    this.assertTransactionNetwork(envelope);
    return this.wallet.signTransaction(transactionXdr, {
      networkPassphrase: this.networkPassphrase,
    });
  }

  /**
   * Builds an unsigned transaction for a contract invocation without simulating it.
   *
   * **Operation Type:** Read-only (Builder)
   *
   * @readonly
   * @remarks Read-only builder operation. Prepares an unsigned transaction without signing or submitting to the network.
   *
   * **IMPORTANT:** The returned transaction is **NOT prepared** (not simulated). It lacks the
   * footprint and resource fee estimates that Soroban simulation adds. Signing and submitting
   * this transaction directly will fail for any Soroban invocation that needs these estimates.
   *
   * Required preparation order (all four steps are required for state-changing calls):
   * 1. Call `buildTransaction(method, args, sourcePublicKey)` to build the unsigned,
   *    unprepared transaction XDR.
   * 2. Call `prepareTransaction(unsignedTx)` on the unsigned XDR to simulate and add
   *    footprint/resource-fee estimates.
   * 3. Sign the prepared XDR with your external signing mechanism.
   * 4. Call `submitSignedTransaction(signedPreparedXdr)` to submit and poll for finality.
   *
   * Skipping step 2 (preparation) will cause on-chain submission to fail, because Soroban
   * transactions require simulated resource fees and footprint entries.
   *
   * Alternatively, use the higher-level state-changing methods (e.g. `createWill()`) which
   * handle building, simulating, signing, and submitting atomically.
   *
   * @param method - The contract method name (e.g. `'create_will'`, `'check_in'`)
   * @param args - Arguments to the method as a record of name-value pairs
   * @param sourcePublicKey - Optional XLM-funded source account public key; defaults to the connected wallet
   * @returns An unsigned, unprepared transaction XDR
   * @throws {InvalidPublicKeyError} If the source or wallet key is not a valid Stellar account public key
   * @throws {SimulationError} If the method name or arguments are invalid (during XDR encoding)
   * @throws {AccountNotFundedError} If the source account does not exist on the ledger
   * @throws {RequestTimeoutError} If the RPC request exceeds its configured timeout
   *
   * @example
   * ```ts
   * const tx = await client.buildTransaction('check_in', { will_id: 1n });
   * console.log(`Transaction built with sequence: ${tx.sequence}`);
   * ```
   */
  async buildTransaction(
    method: string,
    args: Record<string, unknown>,
    sourcePublicKey?: string,
  ): Promise<Transaction> {
    await this.assertWalletNetwork({ networkPassphrase: this.networkPassphrase });
    return this.prepareInvocation(method, args, undefined, sourcePublicKey);
  }

  /**
   * Submits a signed transaction and waits for it to reach a terminal status.
   *
   * **Operation Type:** Write (State-changing)
   *
   * @remarks Write operation. Submits an externally signed transaction to the Soroban RPC and waits for confirmation, modifying ledger state.
   *
   * For custom signing flows using `buildTransaction()`, the transaction must be prepared
   * (simulated) BEFORE signing. The required workflow is:
   * 1. `buildTransaction()` to build an unsigned, unprepared transaction
   * 2. `prepareTransaction()` on the unsigned XDR to simulate and add fees
   * 3. Sign the prepared XDR with your signing mechanism
   * 4. Call this method with the signed XDR to submit and poll
   *
   * The signed envelope passed here must already be prepared — submitting an unprepared
   * Soroban transaction will fail on-chain because it lacks simulated resource fees and
   * footprint entries.
   *
   * @param signedTxXdr - A signed, prepared transaction XDR string
   * @param options - Optional per-call timeout and abort signal
   * @returns An object with the transaction hash, ledger creation timestamp, and contract return value
   * @throws {SoroWillError} If the XDR is a fee-bump envelope or if the transaction does not succeed
   * @throws {SoroWillError} If RPC submission fails or the node is under backpressure
   * @throws {RequestTimeoutError} If polling exceeds its configured timeout
   *
   * @example
   * ```ts
   * const result = await client.submitSignedTransaction(signedXdr);
   * console.log(`Transaction submitted with hash: ${result.txHash}`);
   * ```
   */
  async submitSignedTransaction(
    signedTxXdr: string,
    options?: RequestOptions,
  ): Promise<{ txHash: string; createdAt: number; returnValue: ScVal | undefined }> {
    // #635: Reject write operations in read-only mode.
    if (this.readOnly) {
      throw new ReadOnlyModeError('submitSignedTransaction');
    }
    await this.assertWalletNetwork({ networkPassphrase: this.networkPassphrase });
    const signedTx = TransactionBuilder.fromXDR(signedTxXdr, this.networkPassphrase);
    this.assertTransactionNetwork(signedTx);
    if (!(signedTx instanceof Transaction)) {
      throw new SoroWillError(
        'Expected a plain Transaction envelope after signing, but received FeeBumpTransaction',
      );
    }
    assertSupportedSignatureAlgorithm(signedTx, { context: 'submitSignedTransaction' });
    const publicKey = await this.getWalletPublicKey();
    await this.rpc(
      () => this.rpcPool.withFailover((server) => server.getAccount(publicKey)),
      options,
      'submitSignedTransaction:getAccount',
    );
    // Safe to fail over: the identical signed envelope can only be applied once.
    const sendResponse = await this.rpc(
      () => this.rpcPool.withFailover((server) => server.sendTransaction(signedTx)),
      options,
      'submitSignedTransaction:sendTransaction',
    );

    if (sendResponse.status === 'ERROR') {
      const errorXdr = sendResponse.errorResult?.toXDR?.('base64') ?? 'no error result';
      throw new SoroWillError(`SoroWill transaction submission failed: ${errorXdr}`);
    }

    if (sendResponse.status === 'TRY_AGAIN_LATER') {
      throw new SoroWillError(
        `SoroWill RPC node is under backpressure — the transaction could not be submitted. Retry later.`,
      );
    }

    const txResponse = await this.rpc(
      () =>
        this.rpcPool.withFailover((server) =>
          server.pollTransaction(sendResponse.hash, { attempts: this.pollAttempts }),
        ),
      options,
      'submitSignedTransaction:pollTransaction',
    );

    if (txResponse.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
      throw new SoroWillError(`SoroWill transaction did not succeed: ${txResponse.status}`);
    }

    return {
      txHash: sendResponse.hash,
      createdAt: txResponse.createdAt,
      returnValue: txResponse.returnValue,
    };
  }

  /**
   * Builds, simulates, and signs a contract invocation, returning the signed
   * envelope **without submitting it** to the network.
   *
   * **Operation Type:** Read-only (Signing)
   *
   * @readonly
   * @remarks Sign-only operation. Simulates the invocation (an RPC round trip)
   * and asks the wallet to sign, but never calls `sendTransaction`, so ledger
   * state is unchanged. Use this for offline, air-gapped, or relayer workflows
   * where the signed envelope is submitted later — for example by
   * {@link submitSignedTransaction} from another process or machine.
   *
   * The returned envelope is already prepared (footprint and resource fees
   * included), so it can be submitted as-is once the network is reachable.
   *
   * @param method - The contract method name (e.g. `'check_in'`, `'create_will'`)
   * @param args - Arguments to the method as a record of name-value pairs
   * @param options - Optional per-call timeout, abort signal, and `maxFee` guard
   * @returns The signed envelope XDR plus its hash, source, sequence, and fee
   * @throws {ReadOnlyModeError} If the client is in read-only mode
   * @throws {ExorbitantFeeError} If the prepared fee exceeds `options.maxFee`
   * @throws {SoroWillError} If the wallet returns a fee-bump envelope
   *
   * @example
   * ```ts
   * const signed = await client.signTransaction('check_in', { will_id: 1n });
   * // Later, from a machine with network access:
   * await client.submitSignedTransaction(signed.signedTxXdr);
   * ```
   */
  async signTransaction(
    method: string,
    args: Record<string, unknown>,
    options?: RequestOptions,
  ): Promise<SignedTransactionResult> {
    // #635: Signing is a write-path operation; reject in read-only mode.
    if (this.readOnly) {
      throw new ReadOnlyModeError(method);
    }
    await this.assertWalletNetwork({ networkPassphrase: this.networkPassphrase });
    options?.signal?.throwIfAborted();

    const builtTx = await this.buildInvocationTransaction(method, args);
    options?.signal?.throwIfAborted();
    const prepared = await this.prepareInvocation(method, args, builtTx);
    this.assertTransactionNetwork(prepared);

    if (options?.maxFee !== undefined) {
      const maxFeeBigInt = BigInt(options.maxFee);
      if (BigInt(prepared.fee) > maxFeeBigInt) {
        throw new ExorbitantFeeError(String(prepared.fee), maxFeeBigInt.toString());
      }
    }

    options?.signal?.throwIfAborted();
    const signedTxResponse = await this.signWithWallet(prepared.toXDR());
    options?.signal?.throwIfAborted();
    const signedTxXdr = normalizeSignatureResponse(signedTxResponse);
    const signedTx = TransactionBuilder.fromXDR(signedTxXdr, this.networkPassphrase);
    if (!(signedTx instanceof Transaction)) {
      throw new SoroWillError(
        'Expected a plain Transaction envelope after signing, but received FeeBumpTransaction',
      );
    }
    assertSupportedSignatureAlgorithm(signedTx, { context: `signTransaction(${method})` });

    return {
      signedTxXdr,
      networkPassphrase: this.networkPassphrase,
      txHash: stellarHash(signedTx.toXDR()).toString('hex'),
      sourcePublicKey: signedTx.source,
      sequence: signedTx.sequence,
      fee: signedTx.fee,
    };
  }

  /**
   * Signs an already-built (and ideally prepared) transaction envelope without
   * submitting it.
   *
   * **Operation Type:** Read-only (Signing)
   *
   * @readonly
   * @remarks Sign-only operation. Hands the envelope to the configured wallet
   * and returns the signed XDR. No RPC submission happens, so this works for
   * offline workflows where the envelope was prepared earlier (e.g. via
   * {@link buildSep7SigningUri} or {@link buildTransaction} +
   * `prepareTransaction`).
   *
   * @param transactionXdr - Unsigned (or partially signed) transaction envelope XDR
   * @param options - Optional abort signal
   * @returns The signed envelope XDR plus its hash, source, sequence, and fee
   * @throws {ReadOnlyModeError} If the client is in read-only mode
   * @throws {SoroWillError} If the XDR is a fee-bump envelope
   *
   * @example
   * ```ts
   * const signed = await client.signTransactionXdr(preparedXdr);
   * console.log(signed.signedTxXdr);
   * ```
   */
  async signTransactionXdr(
    transactionXdr: string,
    options?: RequestOptions,
  ): Promise<SignedTransactionResult> {
    if (this.readOnly) {
      throw new ReadOnlyModeError('signTransactionXdr');
    }
    options?.signal?.throwIfAborted();
    const envelope = TransactionBuilder.fromXDR(transactionXdr, this.networkPassphrase);
    this.assertTransactionNetwork(envelope);
    if (!(envelope instanceof Transaction)) {
      throw new SoroWillError(
        'Expected a plain Transaction envelope to sign, but received FeeBumpTransaction',
      );
    }

    const signedTxResponse = await this.signWithWallet(transactionXdr);
    options?.signal?.throwIfAborted();
    const signedTxXdr = normalizeSignatureResponse(signedTxResponse);
    const signedTx = TransactionBuilder.fromXDR(signedTxXdr, this.networkPassphrase);
    if (!(signedTx instanceof Transaction)) {
      throw new SoroWillError(
        'Expected a plain Transaction envelope after signing, but received FeeBumpTransaction',
      );
    }
    assertSupportedSignatureAlgorithm(signedTx, { context: 'signTransactionXdr' });

    return {
      signedTxXdr,
      networkPassphrase: this.networkPassphrase,
      txHash: stellarHash(signedTx.toXDR()).toString('hex'),
      sourcePublicKey: signedTx.source,
      sequence: signedTx.sequence,
      fee: signedTx.fee,
    };
  }

  /**
   * Builds a JSON-serializable error report (name, message, code, stack,
   * cause, SDK context) that users can attach to a support request.
   *
   * **Operation Type:** Read-only (Utility)
   *
   * @readonly
   * @remarks Read-only utility operation. Formats an error into a structured diagnostic report without network requests or state changes.
   *
   * Stack traces are always included here since the caller explicitly asks
   * for the report; routine logging only includes stacks when `debug` is on.
   *
   * @param error - The error to format.
   * @returns A structured record suitable for error logging or support tickets.
   *
   * @example
   * ```ts
   * try {
   *   await client.createWill({ ... });
   * } catch (err) {
   *   const report = client.reportError(err);
   *   console.error('Support ticket payload:', report);
   * }
   * ```
   */
  reportError(error: unknown): Record<string, unknown> {
    const err = error instanceof Error ? error : new Error(String(error));
    const cause = (err as { cause?: unknown }).cause;
    return {
      timestamp: new Date().toISOString(),
      name: err.name,
      message: err.message,
      code: (err as { code?: unknown }).code,
      stack: err.stack,
      cause: cause instanceof Error ? { name: cause.name, message: cause.message, stack: cause.stack } : cause,
      contractId: this.contract.contractId(),
      networkPassphrase: this.networkPassphrase,
    };
  }

  /**
   * Clears the cached contract specification and re-fetches it from the RPC.
   *
   * **Operation Type:** Read-only (Query)
   *
   * @readonly
   * @remarks Read-only query operation. Clears the cached contract specification and re-fetches it from the RPC without modifying ledger state.
   *
   * @param options - Optional request options.
   * @returns The refreshed {@link Spec} instance.
   *
   * @example
   * ```ts
   * const spec = await client.refreshSpec();
   * console.log(`Refreshed contract spec methods: ${spec.funcs().length}`);
   * ```
   */
  async refreshSpec(options?: RequestOptions): Promise<InstanceType<typeof Spec>> {
    this.specPromise = undefined;
    this.specResolvedAt = undefined;
    return this.getSpec(options);
  }

  /**
   * Returns network-wide inclusion-fee statistics (`rpc.Api.GetFeeStatsResponse`).
   *
   * **Operation Type:** Read-only (Query)
   *
   * @readonly
   * @remarks Read-only query operation. Queries current network fee statistics from the RPC node without modifying ledger state.
   *
   * **Note:** these stats cover only the *inclusion* fee. Soroban invocations
   * also pay a resource fee (CPU instructions, memory, ledger reads/writes,
   * storage rent) that depends on the specific operation — e.g. `merge_wills`
   * with many beneficiaries costs far more than `check_in`. Do not size a
   * transaction fee from these stats alone; use {@link previewFee} to simulate
   * the actual cost. State-changing SDK calls always simulate via
   * `prepareTransaction` before submission, so the submitted fee already
   * includes the simulated resource fee.
   *
   * Results are cached per network passphrase (keyed by the wallet's current
   * passphrase) and flushed automatically when the wallet switches networks,
   * so you never see stale fees from a previous network. Call
   * {@link flushFeeStatsCache} to force a refresh after a network switch.
   *
   * ## Example
   *
   * ```ts
   * const stats = await client.getNetworkFeeStats();
   * console.log('Fee stats:', stats);
   * // Use `previewFee` for an operation-specific estimate rather than these
   * // network-wide stats alone.
   * ```
   *
   * @see https://developers.stellar.org/docs/learn/fundamentals/fees-resource-limits-metering
   * @throws {SoroWillError} If the configured RPC server does not support `getFeeStats`.
   *
   * @example
   * ```ts
   * const stats = await client.getNetworkFeeStats();
   * console.log(`Fee stats p90: ${stats.sorobanInclusionFee.p90}`);
   * ```
   */
  async getNetworkFeeStats(options?: RequestOptions): Promise<rpc.Api.GetFeeStatsResponse> {
    const server = this.server;
    if (typeof server.getFeeStats !== 'function') {
      throw new SoroWillError('The configured RPC server does not support getFeeStats');
    }

    // Detect network changes: if the wallet reports a different passphrase than
    // the one we last cached stats for, flush the whole cache first (#500).
    const currentPassphrase = await this.resolveCurrentNetworkPassphrase();
    if (currentPassphrase !== this.lastFeeStatsCachedPassphrase && this.lastFeeStatsCachedPassphrase !== undefined) {
      // The wallet is on a different network than when we last cached.
      // Clear every cached entry so nothing stale leaks through.
      this.feeStatsCache.clear();
    }

    const cacheKey = currentPassphrase;
    const cached = this.feeStatsCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    const result = await this.rpc(() => server.getFeeStats!(), options, 'getFeeStats');
    this.feeStatsCache.set(cacheKey, result);
    this.lastFeeStatsCachedPassphrase = currentPassphrase;
    return result;
  }

  /**
   * Flushes the in-memory fee-stats cache for all networks.
   *
   * **Operation Type:** Read-only (Cache Invalidation)
   *
   * @readonly
   * @remarks Read-only cache maintenance operation. Clears the in-memory fee stats cache without modifying ledger state.
   *
   * Call this after detecting a wallet network switch to guarantee the next
   * `getNetworkFeeStats()` call fetches fresh data from the RPC node.
   *
   * @example
   * ```ts
   * client.flushFeeStatsCache();
   * ```
   */
  flushFeeStatsCache(): void {
    this.feeStatsCache.clear();
  }

  /**
   * Inclusion fee for a replacement transaction: the network's p90 Soroban inclusion
   * fee (from fee stats) per operation, but never below the 10x multiplier stellar-core
   * requires to replace a pending transaction with the same sequence number.
   */
  private async computeBumpedFee(originalFee: bigint, options?: RequestOptions): Promise<bigint> {
    const minimum = originalFee * 10n;
    try {
      const stats = await this.getNetworkFeeStats(options);
      const p90 = BigInt(stats.sorobanInclusionFee.p90);
      const fromStats = p90 * BigInt(originalFee / BigInt(BASE_FEE) || 1n);
      return fromStats > minimum ? fromStats : minimum;
    } catch {
      return minimum;
    }
  }

  /**
   * Verifies the wallet is on the expected network before signing.
   *
   * **Operation Type:** Read-only (Validation)
   *
   * @readonly
   * @remarks Read-only validation operation. Checks the wallet network against expected passphrase without modifying ledger state.
   *
   * - Wallets that do not implement `getNetwork` are not checked (explicit opt-out).
   * - If `getNetwork` rejects, a {@link SoroWillError} is thrown with the original error as `cause`.
   * - An empty or missing passphrase cannot be verified and is treated as a mismatch
   *   ({@link WalletNetworkMismatchError} with an empty `actualNetworkPassphrase`).
   *
   * @param network - Object containing expected `networkPassphrase`.
   * @throws {SoroWillError} If reading wallet network fails.
   * @throws {WalletNetworkMismatchError} If wallet network doesn't match expected.
   *
   * @example
   * ```ts
   * await client.assertWalletNetwork({ networkPassphrase: 'Test SDF Network ; September 2015' });
   * ```
   */
  async assertWalletNetwork(network?: { networkPassphrase: string }): Promise<void> {
    const targetNetwork = network?.networkPassphrase ?? this.networkPassphrase;

    if (!this.wallet.getNetwork) {
      if (this.requireWalletNetwork) {
        throw new SoroWillError(
          'The wallet adapter cannot report its network (no getNetwork method), and requireWalletNetwork is enabled; refusing to sign',
        );
      }
      return;
    }

    let details: { networkPassphrase?: string };
    try {
      details = await this.wallet.getNetwork();
    } catch (error) {
      throw new SoroWillError('Failed to read the wallet network; refusing to sign', { cause: error });
    }
    const actual = details?.networkPassphrase ?? '';
    if (actual !== targetNetwork) {
      throw new WalletNetworkMismatchError(targetNetwork, actual);
    }
  }

  /**
   * Reconnects the underlying wallet adapter and automatically recovers
   * client state (clearing stale caches, in-flight deduplication/tracking
   * state, fee stats, and refreshing session/event subscriptions) so
   * subsequent operations do not fail silently against stale state (#665).
   *
   * @throws {ReadOnlyModeError} When the client was constructed with `readOnly: true`.
   * @throws {WalletSessionError} When the reconnected wallet has an invalid or expired session.
   * @throws {Error} When the wallet adapter fails to reconnect.
   */
  async reconnect(): Promise<WalletConnection> {
    if (this.readOnly) {
      throw new ReadOnlyModeError('reconnect');
    }
    try {
      const connection = await this.wallet.reconnect();
      await this.recoverStateAfterReconnect(connection);
      this.lifecycleEvents.emit('connect', {
        publicKey: connection.publicKey,
        network: connection.network,
        networkPassphrase: connection.networkPassphrase,
        reconnect: true,
      });
      return connection;
    } catch (error) {
      this.lifecycleEvents.emit('error', { operation: 'reconnect', error });
      throw error;
    }
  }

  /**
   * Connects the underlying wallet adapter and emits a `connect` lifecycle
   * event on success (or an `error` event on failure).
   *
   * @throws {ReadOnlyModeError} When the client was constructed with `readOnly: true`.
   */
  async connect(): Promise<WalletConnection> {
    if (this.readOnly) {
      throw new ReadOnlyModeError('connect');
    }
    try {
      const connection = await this.wallet.connect();
      this.lifecycleEvents.emit('connect', {
        publicKey: connection.publicKey,
        network: connection.network,
        networkPassphrase: connection.networkPassphrase,
        reconnect: false,
      });
      return connection;
    } catch (error) {
      this.lifecycleEvents.emit('error', { operation: 'connect', error });
      throw error;
    }
  }

  /**
   * Disconnects the underlying wallet adapter (when supported) and emits a
   * `disconnect` lifecycle event.
   */
  async disconnect(): Promise<void> {
    try {
      await this.wallet.disconnect();
      this.lifecycleEvents.emit('disconnect', {});
    } catch (error) {
      this.lifecycleEvents.emit('error', { operation: 'disconnect', error });
      throw error;
    }
  }

  /**
   * Resets transient client state after a wallet reconnection so subsequent
   * reads and writes operate against fresh wallet/network/session state.
   */
  private async recoverStateAfterReconnect(connection?: WalletConnection): Promise<void> {
    this.inFlightReads.clear();
    this.inFlightTracker.clear();
    this.feeStatsCache.clear();
    this.lastFeeStatsCachedPassphrase = undefined;
    this.signedTransactionHashes.clear();

    if (connection?.publicKey) {
      this.lastKnownPublicKey = connection.publicKey;
    }

    if (this.readCache) {
      if (connection?.networkPassphrase) {
        this.readCache.setNetwork(connection.networkPassphrase);
      }
      await this.readCache.invalidateAll();
    }

    await assertWalletSessionActive(this.wallet);

    if (this.readCache && this.eventSource && !this.eventSubscription) {
      this.eventSubscription = this.eventSource.subscribe((event) => {
        void this.readCache?.invalidateByWillId(event.willId);
      });
    }
  }

  handleNetworkChange(newNetworkPassphrase: string): boolean {
    if (newNetworkPassphrase !== this.lastWalletNetworkPassphrase) {
      this.lastWalletNetworkPassphrase = newNetworkPassphrase;
      this.wallet.clearKeyCache?.();
      this.feeStatsCache.clear();
      if (!this.readOnly) {
        void this.wallet.getPublicKey().catch(() => {});
      }
    }
    if (!this.readCache) {
      return false;
    }
    return this.readCache.setNetwork(newNetworkPassphrase);
  }

  /**
   * Validates that a built or prepared transaction envelope targets this
   * client's configured network passphrase before signing (#659, #664).
   *
   * @throws {SoroWillError} If the client's configured network passphrase is empty.
   * @throws {TransactionNetworkMismatchError} If the transaction envelope's network
   *   passphrase is missing or does not match the client's network passphrase.
   */
  assertTransactionNetwork(transaction: Transaction | FeeBumpTransaction): void {
    if (!this.networkPassphrase || !this.networkPassphrase.trim()) {
      throw new SoroWillError(
        'Client networkPassphrase must be a non-empty string; refusing to sign.',
      );
    }
    const txNetwork = transaction.networkPassphrase ?? '';
    if (txNetwork !== this.networkPassphrase) {
      throw new TransactionNetworkMismatchError(this.networkPassphrase, txNetwork);
    }
  }

  /**
   * Returns the `xdr.LedgerKey` for this client's contract instance storage
   * entry, allowing advanced callers to query contract instance state directly
   * via Soroban RPC `getLedgerEntries` (#663).
   */
  getContractInstanceLedgerKey(): xdr.LedgerKey {
    return buildContractInstanceLedgerKey(this.contract.contractId());
  }

  /**
   * Returns the base64-encoded XDR of this client's contract instance storage
   * ledger entry key (#663).
   */
  getContractInstanceLedgerKeyXdr(): string {
    return this.getContractInstanceLedgerKey().toXDR('base64');
  }

  /**
   * Returns an `xdr.LedgerKey` for a contract data storage entry on this
   * client's contract (#663).
   *
   * @param key - Storage key as an `xdr.ScVal` or a JS value convertible via `nativeToScVal`.
   * @param durability - Storage durability tier (`'persistent'` or `'temporary'`). Defaults to `'persistent'`.
   */
  getContractDataLedgerKey(
    key: xdr.ScVal | unknown,
    durability: ContractStorageDurability = 'persistent',
  ): xdr.LedgerKey {
    return buildContractDataLedgerKey(this.contract.contractId(), key, durability);
  }

  /**
   * Returns the base64-encoded XDR of a contract data storage ledger entry key
   * on this client's contract (#663).
   *
   * @param key - Storage key as an `xdr.ScVal` or a JS value convertible via `nativeToScVal`.
   * @param durability - Storage durability tier (`'persistent'` or `'temporary'`). Defaults to `'persistent'`.
   */
  getContractDataLedgerKeyXdr(
    key: xdr.ScVal | unknown,
    durability: ContractStorageDurability = 'persistent',
  ): string {
    return this.getContractDataLedgerKey(key, durability).toXDR('base64');
  }

  // -----------------------------------------------------------------------
  // Private: RPC wrapper through queue
  // -----------------------------------------------------------------------

  /** Sends every RPC through the shared FIFO queue with the selected timeout. */
  private rpc<T>(request: () => Promise<T>, options?: RequestOptions, method?: string): Promise<T> {
    options?.signal?.throwIfAborted();
    return this.queue.enqueue(
      request,
      options?.timeoutMs ?? this.timeoutMs,
      options?.signal,
      undefined,
      method,
    );
  }

  /**
   * Retries `operation` up to `this.retryOptions.maxAttempts` times with
   * exponential backoff, for transient read-path failures. Defaults to a
   * single attempt (no retry) unless the caller opts in via
   * `SoroWillClientOptions.retry`.
   *
   * Typed errors ({@link RequestTimeoutError}, `AbortError`) and failures of a
   * single-attempt call propagate unchanged; only a failure that exhausted
   * more than one attempt is wrapped in a `SoroWillError` (original in `cause`).
   */
  private async withRetry<T>(operation: () => Promise<T>): Promise<T> {
    const { maxAttempts, initialDelayMs, maxDelayMs, backoffFactor } = this.retryOptions;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        if (
          error instanceof RequestTimeoutError ||
          (error instanceof Error && error.name === 'AbortError') ||
          maxAttempts === 1
        ) {
          throw error;
        }
        lastError = error;
        if (attempt === maxAttempts) {
          break;
        }
        const delay = Math.min(initialDelayMs * backoffFactor ** (attempt - 1), maxDelayMs);
        if (delay > 0) {
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    throw new SoroWillError(
      `SoroWill RPC call failed after ${maxAttempts} attempt${maxAttempts === 1 ? '' : 's'}: ` +
        (lastError instanceof Error ? lastError.message : String(lastError)),
      { cause: lastError },
    );
  }

  // -----------------------------------------------------------------------
  // Private: transaction building helpers
  // -----------------------------------------------------------------------

  private async buildInvocationTransaction(
    method: string,
    args: Record<string, unknown>,
    sourcePublicKey?: string,
  ): Promise<Transaction> {
    const publicKey = sourcePublicKey ?? (await this.getWalletPublicKey());
    if (!StrKey.isValidEd25519PublicKey(publicKey)) {
      throw new InvalidPublicKeyError('sourcePublicKey');
    }
    const spec = await this.getSpec();
    const scArgs = spec.funcArgsToScVals(method, args);
    const operation = this.contract.call(method, ...scArgs);

    const account = await this.rpcPool.withFailover((server) => server.getAccount(publicKey));
    return this.buildInvocationEnvelope([operation], account);
  }

  private buildInvocationEnvelope(
    operations: readonly xdr.Operation[],
    account: Account,
  ): Transaction {
    const builder = new TransactionBuilder(account, {
      fee: (BigInt(BASE_FEE) * BigInt(operations.length)).toString(),
      networkPassphrase: this.networkPassphrase,
    });

    for (const operation of operations) {
      builder.addOperation(operation);
    }

    const transaction = builder.setTimeout(this.transactionTimeoutSeconds).build();
    this.assertTransactionNetwork(transaction);
    return transaction;
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

  /**
   * Simulate a contract invocation without signing or submitting it (#797).
   *
   * Builds the invocation transaction, runs a Soroban simulation and returns a
   * preview of the outcome. Nothing is committed to the ledger and no wallet
   * signature is requested. On failure the raw simulation error is exposed as
   * the typed `simulationError` property (never in `message`).
   */
  async simulateInvocation(
    method: string,
    args: Record<string, unknown> = {},
    options?: { sourcePublicKey?: string },
  ): Promise<SimulationPreview> {
    const transaction = await this.buildInvocationTransaction(
      method,
      args,
      options?.sourcePublicKey,
    );
    const response = await this.rpcPool.withFailover((server) =>
      server.simulateTransaction(transaction),
    );

    const success = rpc.Api.isSimulationSuccess(response);
    const rawError = success ? undefined : rpc.Api.isSimulationError(response) ? response.error : undefined;
    const minResourceFee = success ? response.minResourceFee : undefined;
    const transactionData = success ? response.transactionData : undefined;
    const result = success ? response.result : undefined;

    return {
      success,
      method,
      minResourceFee,
      fee: minResourceFee !== undefined ? String(BigInt(BASE_FEE) + BigInt(minResourceFee)) : undefined,
      returnValue: result?.retval,
      transactionData,
      simulationError: rawError,
      error: rawError,
    };
  }

  private async getWalletPublicKey(): Promise<string> {
    const publicKey = await this.wallet.getPublicKey();
    if (!StrKey.isValidEd25519PublicKey(publicKey)) {
      throw new InvalidPublicKeyError('publicKey');
    }
    if (this.lastKnownPublicKey !== undefined && this.lastKnownPublicKey !== publicKey) {
      this.inFlightReads.clear();
      this.feeStatsCache.clear();
      this.lastFeeStatsCachedPassphrase = undefined;
      void this.readCache?.invalidateAll();
    }
    this.lastKnownPublicKey = publicKey;
    return publicKey;
  }

  /**
   * Returns the wallet's currently reported network passphrase, falling back
   * to the client's configured passphrase when the wallet does not implement
   * `getNetwork()`. Used by `getNetworkFeeStats` to key the per-network cache
   * and detect mid-session network switches (#500).
   */
  private async resolveCurrentNetworkPassphrase(): Promise<string> {
    if (typeof this.wallet.getNetwork === 'function') {
      try {
        const details = await this.wallet.getNetwork();
        if (details.networkPassphrase) {
          return details.networkPassphrase;
        }
      } catch {
        // If getNetwork() fails for any reason, fall back to the configured passphrase.
      }
    }
    return this.networkPassphrase;
  }
}

// Re-export utility functions for convenience (commonly imported with SoroWillClient)
export { validateGuardianSignature };
