/**
 * A single beneficiary entry: an address and the percentage of the will's
 * balance it is entitled to receive when the inheritance is released.
 */
export interface Beneficiary {
  address: string;
  percentage: number;
}

/** Lifecycle state of a will, mirroring `WillStatus` in the SoroWill contract. */
export enum WillStatus {
  /** The will is funded and the owner is checking in on schedule. */
  Active = 'Active',
  /** The owner missed a check-in deadline; the grace period is running. */
  Triggered = 'Triggered',
  /** The grace period expired (or guardians reached quorum) and funds were released. */
  Released = 'Released',
  /** The owner cancelled the will and withdrew the remaining balance. */
  Cancelled = 'Cancelled',
}

/** The full on-chain state of a single will, decoded into native JS types. */
export interface Will {
  /** Unique identifier for this will, as a decimal string (contract-side `u64`). */
  id: string;
  /** The address that created and funds the will. */
  owner: string;
  /** The token contract address (e.g. a USDC Stellar Asset Contract) held by the will. */
  token: string;
  /** The amount of `token` currently locked, in base units, as a decimal string. */
  balance: string;
  /** The beneficiaries and their percentage shares. Always sums to 100. */
  beneficiaries: Beneficiary[];
  /** How many days the owner may go without checking in before the will can be triggered. */
  checkinPeriodDays: number;
  /** How many days after being triggered the owner has to prove they are alive. */
  gracePeriodDays: number;
  /** When the owner last checked in. */
  lastCheckin: Date;
  /** When the will was triggered, or `null` if it has never been triggered. */
  triggerTime: Date | null;
  /** Current lifecycle state of the will. */
  status: WillStatus;
  /** Optional guardian addresses (up to 3) who may force an early release. */
  guardians: string[];
  /** Number of distinct guardians who have voted in the current release cycle. */
  guardianVotes: number;
}

/** Parameters for {@link SoroWillClient.createWill}. */
export interface CreateWillParams {
  /** The token contract address (e.g. a USDC Stellar Asset Contract) to lock. */
  token: string;
  /** The amount of `token` to lock, in base units, as a decimal string. */
  amount: string;
  /** 1 to 10 beneficiaries whose percentages sum to exactly 100. */
  beneficiaries: Beneficiary[];
  /** How many days the owner may go without checking in. */
  checkinPeriodDays: number;
  /** How many days after being triggered the owner has to prove they are alive. */
  gracePeriodDays: number;
  /** 0 to 3 guardian addresses that may jointly force an early release. */
  guardians: string[];
}

/** Parameters for {@link SoroWillClient.updateBeneficiaries}. */
export interface UpdateBeneficiariesParams {
  willId: string;
  beneficiaries: Beneficiary[];
}

/** Optional client-side pagination controls for list-style SDK methods. */
export interface PaginationOptions {
  /** Maximum number of wills to return in this page. */
  pageSize?: number;
  /** Opaque cursor returned by the previous page, if any. */
  cursor?: string;
}

/** A page of wills plus the cursor needed to fetch the next page, if any. */
export interface PaginatedWillsResult {
  wills: Will[];
  nextCursor: string | null;
}

/** Normalized contract event emitted by the SoroWill contract. */
export interface SoroWillEvent {
  id: string;
  cursor: string;
  ledger: number | null;
  ledgerClosedAt: Date | null;
  contractId: string | null;
  txHash: string | null;
  type: string | null;
  topics: unknown[];
  value: unknown;
  raw: unknown;
}

/** Which transport backs an active event subscription. */
export type EventSubscriptionTransport = 'polling' | 'websocket';

/** Controls how event subscriptions are established and paged. */
export interface EventSubscriptionOptions {
  /** Cursor to resume from. Omit to start from the latest available cursor. */
  cursor?: string;
  /** Maximum number of events to request per fetch/stream chunk. */
  pageSize?: number;
  /** Polling interval when the polling transport is used. */
  pollIntervalMs?: number;
  /** Force a specific transport, or auto-negotiate with WebSocket fallback. */
  transport?: 'auto' | EventSubscriptionTransport;
  /** Optional callback for transport-level errors. */
  onError?: (error: Error) => void;
}

/** Handle for an active event subscription. */
export interface EventSubscription {
  readonly transport: EventSubscriptionTransport;
  readonly closed: boolean;
  close(): void;
}

/** Options accepted by individual SDK calls. */
export interface RequestOptions {
  /** Overrides the client's default RPC timeout for this call. */
  timeoutMs?: number;
  /** An AbortSignal that can be used to cancel the in-flight request. */
  signal?: AbortSignal;
}

/** A contract invocation to include in a single batch transaction. */
export interface BatchOperation {
  /** Contract function name, such as `create_will` or `check_in`. */
  method: string;
  /** Native named arguments expected by the deployed contract spec. */
  args: Record<string, unknown>;
}

/** Result of submitting a batch as one atomic Stellar transaction. */
export interface BatchResult {
  txHash: string;
  createdAt: number;
}
