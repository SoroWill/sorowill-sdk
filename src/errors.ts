/** Machine-readable error codes for all SoroWill SDK error scenarios (#704). */
export enum ErrorCode {
  // Contract errors (1-37 + unknown)
  WILL_NOT_FOUND = 'WILL_NOT_FOUND',
  NOT_OWNER = 'NOT_OWNER',
  WILL_NOT_ACTIVE = 'WILL_NOT_ACTIVE',
  WILL_NOT_TRIGGERED = 'WILL_NOT_TRIGGERED',
  GRACE_PERIOD_NOT_EXPIRED = 'GRACE_PERIOD_NOT_EXPIRED',
  GRACE_PERIOD_EXPIRED = 'GRACE_PERIOD_EXPIRED',
  INVALID_PERCENTAGES = 'INVALID_PERCENTAGES',
  ALREADY_VOTED = 'ALREADY_VOTED',
  NOT_GUARDIAN = 'NOT_GUARDIAN',
  CHECKIN_NOT_DUE = 'CHECKIN_NOT_DUE',
  ZERO_AMOUNT = 'ZERO_AMOUNT',
  TOO_MANY_BENEFICIARIES = 'TOO_MANY_BENEFICIARIES',
  WILL_NOT_SETTLED = 'WILL_NOT_SETTLED',
  WILL_NOT_BOTH_ACTIVE = 'WILL_NOT_BOTH_ACTIVE',
  SAME_WILL_ID = 'SAME_WILL_ID',
  MERGE_WOULD_EXCEED_LIMITS = 'MERGE_WOULD_EXCEED_LIMITS',
  OWNER_CANNOT_BE_GUARDIAN = 'OWNER_CANNOT_BE_GUARDIAN',
  BENEFICIARY_NOT_FOUND = 'BENEFICIARY_NOT_FOUND',
  KEEPER_BOUNTY_EXCEEDS_MAX = 'KEEPER_BOUNTY_EXCEEDS_MAX',
  INVALID_GUARDIAN_THRESHOLD = 'INVALID_GUARDIAN_THRESHOLD',
  FIXED_AMOUNT_EXCEEDS_BALANCE = 'FIXED_AMOUNT_EXCEEDS_BALANCE',
  INVALID_PERCENTAGE = 'INVALID_PERCENTAGE',
  WILL_NOT_RELEASED = 'WILL_NOT_RELEASED',
  NOT_SAME_OWNER = 'NOT_SAME_OWNER',
  INVALID_PERIOD = 'INVALID_PERIOD',
  DUPLICATE_GUARDIAN = 'DUPLICATE_GUARDIAN',
  GUARDIAN_COOLDOWN_ACTIVE = 'GUARDIAN_COOLDOWN_ACTIVE',
  INVALID_TOKEN = 'INVALID_TOKEN',
  DUPLICATE_BENEFICIARY = 'DUPLICATE_BENEFICIARY',
  WILL_NOT_CONFIRMED = 'WILL_NOT_CONFIRMED',
  CONFIRMATION_WINDOW_EXPIRED = 'CONFIRMATION_WINDOW_EXPIRED',
  TOO_MANY_IDS = 'TOO_MANY_IDS',
  INSUFFICIENT_BALANCE = 'INSUFFICIENT_BALANCE',
  INVALID_SPLIT = 'INVALID_SPLIT',
  INVALID_PREIMAGE = 'INVALID_PREIMAGE',
  ALREADY_CLAIMED = 'ALREADY_CLAIMED',
  TOO_MANY_WILLS = 'TOO_MANY_WILLS',
  UNKNOWN_CONTRACT_ERROR = 'UNKNOWN_CONTRACT_ERROR',

  // RPC, simulation & transaction errors
  CONTRACT_STATE_ERROR = 'CONTRACT_STATE_ERROR',
  SIMULATION_FAILED = 'SIMULATION_FAILED',
  TRANSACTION_FAILED = 'TRANSACTION_FAILED',
  RPC_UNAVAILABLE = 'RPC_UNAVAILABLE',
  RPC_TIMEOUT = 'RPC_TIMEOUT',
  RATE_LIMITED = 'RATE_LIMITED',
  ACCOUNT_NOT_FUNDED = 'ACCOUNT_NOT_FUNDED',
  RESTORE_REQUIRED = 'RESTORE_REQUIRED',

  // Wallet & validation errors
  WALLET_ERROR = 'WALLET_ERROR',
  WALLET_TIMEOUT = 'WALLET_TIMEOUT',
  WALLET_NETWORK_MISMATCH = 'WALLET_NETWORK_MISMATCH',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  UNKNOWN_ERROR = 'UNKNOWN_ERROR',
}

/** Structured user-facing error representation with recovery guidance. */
export interface UserFriendlyErrorInfo {
  errorCode: ErrorCode;
  message: string;
  recoverySteps: string;
}

/** Base class for errors raised by the SoroWill SDK. */
export class SoroWillError extends Error {
  /** Machine-readable error code for programmatic handling, when available. */
  readonly errorCode?: ErrorCode;
  /** Actionable recovery steps the user can take to resolve the error. */
  readonly recoverySteps?: string;

  constructor(
    message: string,
    options?: ErrorOptions & { errorCode?: ErrorCode; recoverySteps?: string },
  ) {
    super(message, options);
    this.name = new.target.name;
    if (options?.errorCode !== undefined) {
      this.errorCode = options.errorCode;
    }
    if (options?.recoverySteps !== undefined) {
      this.recoverySteps = options.recoverySteps;
    }
  }
}

/**
 * Raised when a `beforeInvoke` hook throws an error. The original error is
 * available as the standard `cause` property. When this error is thrown, the
 * transaction has not been built or signed — no state-changing operation was
 * submitted to the network.
 *
 * @example
 * ```ts
 * hooks.onBeforeInvoke((ctx) => {
 *   if (!ctx.args.willId) throw new Error('willId is required');
 * });
 *
 * try {
 *   await client.checkIn('42');
 * } catch (err) {
 *   if (err instanceof HookExecutionError) {
 *     console.error('Hook failed:', err.hookName, err.cause);
 *   }
 * }
 * ```
 */
export class HookExecutionError extends SoroWillError {
  /** The name of the lifecycle phase where the hook failed ('beforeInvoke'). */
  readonly hookName: string;

  constructor(hookName: string, cause: unknown, options?: ErrorOptions) {
    const message =
      cause instanceof Error
        ? `${hookName} hook threw an error: ${cause.message}`
        : `${hookName} hook threw an error: ${String(cause)}`;
    super(message, { ...options, cause });
    this.hookName = hookName;
  }
}

/**
 * Raised when a hook triggers a nested contract invocation while another
 * invocation is already in progress (e.g. a `beforeInvoke` hook calls another
 * operation through the same `SoroWillClient`). Without this guard the hooks
 * would re-enter `HookManager.runBeforeInvoke`/`runAfterInvoke` and could
 * recurse indefinitely.
 *
 * The offending nested invocation is never executed — the client state is
 * left unchanged and the caller receives a clear, synchronous error instead of
 * a stack overflow.
 *
 * @example
 * ```ts
 * hooks.onBeforeInvoke(async (ctx) => {
 *   // ❌ Never call another client operation from within a hook.
 *   await client.checkIn('42');
 * });
 *
 * try {
 *   await client.checkIn('42');
 * } catch (err) {
 *   if (err instanceof HookRecursionError) {
 *     console.error('Recursive hook execution blocked:', err.message);
 *   }
 * }
 * ```
 */
export class HookRecursionError extends SoroWillError {
  constructor(message?: string) {
    super(
      message ??
        'Recursive hook execution detected: a hook triggered a nested contract invocation while another invocation was already in progress. ' +
          'Hooks must not call client operations that re-enter HookManager.runBeforeInvoke or runAfterInvoke.',
    );
    this.name = 'HookRecursionError';
  }
}

/**
 * Raised when an amount string passed to {@link SoroWillClient.createWill} or
 * {@link SoroWillClient.topUp} is not a valid positive integer. This catches
 * zero, negative, and malformed (non-numeric) strings before they reach
 * `BigInt()` or the contract's own validation round-trip.
 */
export class SoroWillInvalidAmountError extends SoroWillError {
  readonly amount: string;

  constructor(amount: string, options?: ErrorOptions) {
    super(
      `Invalid amount "${amount}": must be a string representing a positive integer (e.g. "1000000").`,
      options,
    );
    this.amount = amount;
  }
}

/** Raised when an RPC call exceeds its configured deadline. */
export class RequestTimeoutError extends SoroWillError {
  readonly timeoutMs: number;
  /** The name of the method or operation that timed out, if known. */
  readonly method?: string | undefined;
  /** The operation name that timed out, alias for {@link method}. */
  readonly operation?: string | undefined;

  constructor(
    timeoutMs: number,
    methodOrOptions?: string | ErrorOptions,
    options?: ErrorOptions,
  ) {
    const method = typeof methodOrOptions === 'string' ? methodOrOptions : undefined;
    const errOptions =
      typeof methodOrOptions === 'object' && methodOrOptions !== null
        ? methodOrOptions
        : options;
    const message = method
      ? `SoroWill RPC request for "${method}" timed out after ${timeoutMs}ms`
      : `SoroWill RPC request timed out after ${timeoutMs}ms`;
    super(message, errOptions);
    this.timeoutMs = timeoutMs;
    this.method = method;
    this.operation = method;
  }
}

/**
 * Raised when a {@link RequestQueue} is asked to enqueue a request beyond its
 * configured maximum queue size (`maxQueueSize`). The excess request is
 * rejected without ever being scheduled, so the queue can never grow without
 * bound when requests are produced faster than the configured concurrency and
 * rate limits allow them to be processed (#525).
 */
export class RequestQueueOverflowError extends SoroWillError {
  /** The configured maximum number of pending requests that was exceeded. */
  readonly maxQueueSize: number;

  constructor(maxQueueSize: number, options?: ErrorOptions) {
    super(
      `RequestQueue is full: cannot enqueue more than ${maxQueueSize} pending requests. ` +
        'The queue is processing requests slower than they are being submitted. ' +
        'Retry shortly, reduce the submission rate, or increase the queue\'s maxQueueSize / concurrency.',
      options,
    );
    this.maxQueueSize = maxQueueSize;
  }
}

/**
 * Raised when an operation is submitted while an identical operation (same
 * will id and method) is already in flight and the caller asked for exclusive
 * execution. Unlike the default deduplication behaviour — which coalesces
 * concurrent duplicates onto the in-flight promise — exclusive operations
 * reject the duplicate immediately so it can never issue a second, duplicate
 * transaction on-chain (#523). The original in-flight operation is unaffected
 * and continues to completion.
 */
export class DuplicateOperationError extends SoroWillError {
  /** The will id whose operation was already in flight. */
  readonly willId: string;
  /** The contract method that was already in flight for {@link willId}. */
  readonly method: string;

  constructor(willId: string | bigint, method: string, options?: ErrorOptions) {
    const id = typeof willId === 'bigint' ? willId.toString() : willId;
    super(
      `A "${method}" operation for will ${id} is already in flight. ` +
        'Wait for the in-flight operation to settle before submitting another one.',
      options,
    );
    this.willId = id;
    this.method = method;
  }
}

/**
 * Raised when Freighter's `isConnected()` API reports an error other than
 * the extension simply being absent — e.g. it was called outside a browser,
 * or Freighter itself hit an internal error. Distinguishing this from "not
 * installed" avoids prompting an install when Freighter is actually present
 * but in an unexpected state.
 */
export class FreighterInstallCheckError extends SoroWillError {
  readonly code: number;

  constructor(code: number, message: string, options?: ErrorOptions) {
    super(`Unable to determine whether Freighter is installed: ${message}`, options);
    this.code = code;
  }
}

/**
 * Raised by {@link FreighterWalletAdapter} when the Freighter extension has
 * still not injected itself into the page (`window.freighter` /
 * `window.stellar`) after every configured retry. Usually means Freighter is
 * not installed, is disabled, or the page loaded before the extension could
 * attach.
 */
export class FreighterNotAvailableError extends SoroWillError {
  /** Number of injection checks performed before giving up. */
  readonly attempts: number;

  constructor(attempts: number, options?: ErrorOptions) {
    super(
      `Freighter is not available: the extension was not injected into the page after ${attempts} attempts. ` +
        'Make sure Freighter is installed and enabled, then reload the page.',
      options,
    );
    this.name = new.target.name;
    this.attempts = attempts;
  }
}

/**
 * Raised when the `contractId` passed to the {@link SoroWillClient} constructor
 * is not a syntactically valid Stellar contract address (wrong length, wrong
 * StrKey version byte, or not valid base32). Thrown synchronously before any
 * RPC call is made, giving callers a clear SDK-level error rather than a
 * low-level StrKey-decoding message.
 */
export class InvalidContractIdError extends SoroWillError {
  /** The invalid contract ID that was supplied. */
  readonly contractId: string;

  constructor(contractId: string, options?: ErrorOptions) {
    super(
      `"${contractId}" is an invalid SoroWill contract address. ` +
        'A Stellar contract address must be a 56-character StrKey starting with "C".',
      options,
    );
    this.contractId = contractId;
  }
}

/**
 * Raised when a configuration option passed to the {@link SoroWillClient}
 * constructor is invalid (unknown network, malformed URL, out-of-range number,
 * wrong type, …). Thrown synchronously before any RPC call is made so
 * misconfiguration fails fast with an actionable message.
 *
 * The offending option name is exposed as {@link SoroWillConfigError.option}
 * and the rejected value as {@link SoroWillConfigError.value}.
 *
 * @example
 * ```ts
 * try {
 *   new SoroWillClient({ network: 'devnet' as never, contractId: 'C...' });
 * } catch (err) {
 *   if (err instanceof SoroWillConfigError) {
 *     console.error(`${err.option}: ${err.message}`);
 *   }
 * }
 * ```
 */
export class SoroWillConfigError extends SoroWillError {
  /** Name of the invalid configuration option (e.g. `"rpcUrl"`). */
  readonly option: string;
  /** The rejected value, when it is safe to expose. */
  readonly value?: unknown;

  constructor(option: string, message: string, value?: unknown, options?: ErrorOptions) {
    super(`Invalid SoroWill configuration option "${option}": ${message}`, {
      ...options,
      errorCode: ErrorCode.VALIDATION_ERROR,
    });
    this.option = option;
    if (value !== undefined) {
      this.value = value;
    }
  }
}

/**
 * Raised when the `guardians` list passed to {@link SoroWillClient.createWill}
 * exceeds the contract's `MAX_GUARDIANS` limit. Thrown synchronously before
 * any transaction is built or signed, saving a full round-trip.
 */
export class TooManyGuardiansError extends SoroWillError {
  /** Number of guardians supplied. */
  readonly supplied: number;
  /** Maximum guardians allowed (mirrors the contract's MAX_GUARDIANS). */
  readonly max: number;

  constructor(supplied: number, max: number, options?: ErrorOptions) {
    super(
      `Too many guardians: ${supplied} supplied but the contract allows at most ${max}.`,
      options,
    );
    this.supplied = supplied;
    this.max = max;
  }
}

/**
 * Raised when a secret key passed to {@link signWithSecretKey} or
 * {@link signFeeBumpXdr} is not a syntactically valid Stellar secret key.
 * Checks include wrong length, wrong StrKey version byte, or invalid base32 encoding.
 * Thrown synchronously before signing begins, giving callers a clear SDK-level
 * error rather than a low-level StrKey-decoding message.
 */
export class InvalidSecretKeyError extends SoroWillError {
  constructor(functionName: string, options?: ErrorOptions) {
    super(
      `The secret key passed to ${functionName}() is not a valid Stellar secret key. ` +
        'A Stellar secret key must be a 56-character StrKey starting with "S" and containing valid base32 characters.',
      options,
    );
  }
}

/**
 * Raised when a public key passed to an SDK function (for example the
 * `feeSourcePublicKey` of {@link buildFeeBumpXdr}) is not a valid Stellar
 * account public key, so callers get a typed error naming the offending field
 * rather than a low-level StrKey-decoding message.
 */
export class InvalidPublicKeyError extends SoroWillError {
  constructor(
    public readonly field: string,
    options?: ErrorOptions,
  ) {
    super(
      `${field} is not a valid Stellar public key. ` +
        'A Stellar public key must be a 56-character StrKey starting with "G" and containing valid base32 characters.',
      options,
    );
  }
}

/**
 * Raised when {@link SoroWillClient.batch} is given more than one operation.
 * Soroban transactions may contain only a single `InvokeHostFunction`
 * operation, so a multi-operation batch would always be rejected by the
 * network at submission time.
 */
export class UnsupportedBatchSizeError extends SoroWillError {
  constructor(
    public readonly operationCount: number,
    options?: ErrorOptions,
  ) {
    super(
      `A batch may contain only one operation, but ${operationCount} were provided. ` +
        'Soroban transactions allow a single contract invocation (InvokeHostFunction operation) each; ' +
        'submit each call as its own transaction instead.',
      options,
    );
  }
}

/**
 * Raised when the operations passed to {@link SoroWillClient.batch} do not all
 * target the same Stellar network, or when the network they target differs
 * from the network the client is configured for (#550).
 *
 * The check runs before any transaction is built, signed, or submitted, so a
 * batch can never silently mix testnet and mainnet operations.
 */
export class BatchNetworkMismatchError extends SoroWillError {
  /** The network the client is configured for. */
  readonly clientNetwork: string;
  /** The network the offending operation targets. */
  readonly operationNetwork: string;
  /** Index of the offending operation within the batch. */
  readonly operationIndex: number;
  /** Index of the operation declaring a conflicting network, when set. */
  readonly conflictingOperationIndex: number | undefined;
  /** The network declared by the conflicting operation, when set. */
  readonly conflictingNetwork: string | undefined;

  constructor(
    clientNetwork: string,
    operationNetwork: string,
    operationIndex: number,
    conflicting?: { operationIndex: number; network: string },
    options?: ErrorOptions,
  ) {
    const message = conflicting
      ? `Batch operations must all target the same network: operation ${operationIndex} targets ` +
        `"${operationNetwork}" but operation ${conflicting.operationIndex} targets ` +
        `"${conflicting.network}".`
      : `Batch operation ${operationIndex} targets network "${operationNetwork}" but the client is ` +
        `configured for "${clientNetwork}".`;
    super(message, options);
    this.clientNetwork = clientNetwork;
    this.operationNetwork = operationNetwork;
    this.operationIndex = operationIndex;
    this.conflictingOperationIndex = conflicting?.operationIndex;
    this.conflictingNetwork = conflicting?.network;
  }
}

/**
 * Raised when the transaction XDR passed to {@link MultisigCollector} constructor
 * or {@link MultisigCollector.fromJSON} is not a syntactically valid Stellar
 * transaction envelope XDR. This includes malformed base64 or unsupported
 * envelope types.
 *
 * Validation happens synchronously at construction time, before the collector
 * is distributed to signers, saving a full multi-party signing round-trip.
 */
export class InvalidTransactionXdrError extends SoroWillError {
  constructor(options?: ErrorOptions) {
    super(
      'The transaction XDR is not a valid Stellar transaction envelope. ' +
        'Ensure the XDR is base64-encoded and represents a valid TransactionEnvelope (v1 or fee-bump).',
      options,
    );
  }
}

/**
 * Raised when a wallet signer returns a signed transaction that is not valid
 * base64. Stellar transaction envelopes are always standard (RFC 4648),
 * padded base64-encoded XDR, so anything else would only fail later — and
 * far more cryptically — when the envelope is decoded or submitted to the
 * contract.
 *
 * The offending value is intentionally not embedded in the message; only its
 * length is kept so the error is safe to forward to error-tracking pipelines.
 */
export class InvalidSignedXdrEncodingError extends SoroWillError {
  /** Length of the rejected XDR string. */
  readonly length: number;

  constructor(length: number, options?: ErrorOptions) {
    super(
      'Wallet signer returned a signed transaction XDR that is not valid base64. ' +
        'Expected a standard, padded base64-encoded TransactionEnvelope.',
      options,
    );
    this.length = length;
  }
}

/**
 * Raised when the wallet's `signTransaction` call does not resolve within the
 * configured timeout. This can happen when the Freighter popup is dismissed in
 * a way that leaves the underlying promise pending, or when the extension hangs.
 */
export class SignTransactionTimeoutError extends SoroWillError {
  /** The timeout value (in milliseconds) that was exceeded. */
  readonly timeoutMs: number;

  constructor(timeoutMs: number, options?: ErrorOptions) {
    super(
      `Wallet signTransaction timed out after ${timeoutMs}ms. ` +
        'The signing popup may have been dismissed or the extension may have hung.',
      options,
    );
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Raised when connecting to Freighter does not complete within the configured
 * timeout (30 seconds by default). Carries actionable recovery steps for users.
 */
export class FreighterConnectionTimeoutError extends SoroWillError {
  /** The timeout value (in milliseconds) that was exceeded. */
  readonly timeoutMs: number;
  /** Ordered recovery steps suggested to the user. */
  readonly recoverySteps: readonly string[] = ['Refresh', 'Check extension', 'Retry'];

  constructor(timeoutMs: number = 30_000, options?: ErrorOptions) {
    super('Freighter not responding. Try: 1) Refresh 2) Check extension 3) Retry', options);
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Raised when a beneficiary list fails client-side validation before a
 * transaction is built or sent. Thrown by {@link SoroWillClient.createWill}
 * and {@link SoroWillClient.updateBeneficiaries} when
 * {@link validateBeneficiaries} returns `false`.
 *
 * Possible reasons include: empty list, more than 10 entries, a non-positive
 * or non-integer percentage, or percentages that do not sum to 100.
 */
export class BeneficiaryValidationError extends SoroWillError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * Raised by {@link SoroWillClient.createWill} and
 * {@link SoroWillClient.updateBeneficiaries} when a beneficiary address is not
 * a valid Stellar account address (a `G...` Ed25519 public key). Catching it
 * before submission prevents a will from being created whose funds can never
 * be released to that beneficiary.
 */
export class InvalidBeneficiaryAddressError extends BeneficiaryValidationError {
  /** The offending beneficiary address, exactly as supplied. */
  readonly address: unknown;
  /** Human-readable reason the address was rejected. */
  readonly reason: string;

  constructor(address: unknown, reason: string, options?: ErrorOptions) {
    const shown = typeof address === 'string' ? `"${address}"` : String(address);
    super(
      `Invalid beneficiary address ${shown}: ${reason}. ` +
        'Beneficiaries must be Stellar account addresses: 56-character uppercase strings starting with "G".',
      options,
    );
    this.address = address;
    this.reason = reason;
  }
}

/**
 * Raised by `createWill` before any RPC call when the guardian list is
 * invalid: a malformed Stellar address, a duplicate entry, or the owner's own
 * address. `reason` names the problem and `guardian` the offending address.
 */
export class GuardianValidationError extends SoroWillError {
  readonly reason: 'invalid_address' | 'duplicate' | 'owner_is_guardian';
  readonly guardian: string;

  constructor(
    reason: 'invalid_address' | 'duplicate' | 'owner_is_guardian',
    guardian: string,
    options?: ErrorOptions,
  ) {
    const detail =
      reason === 'invalid_address'
        ? 'is not a valid Stellar public key'
        : reason === 'duplicate'
          ? 'appears more than once'
          : 'is the will owner and cannot also be a guardian';
    super(`Invalid guardian "${guardian}": address ${detail}.`, options);
    this.name = new.target.name;
    this.reason = reason;
    this.guardian = guardian;
  }
}

/** Why a value was rejected by {@link InvalidStellarAddressError}. */
export type InvalidStellarAddressReason =
  | 'not_a_string'
  | 'empty'
  | 'whitespace'
  | 'wrong_length'
  | 'invalid_characters'
  | 'unsupported_type'
  | 'invalid_checksum';

/**
 * Raised before any RPC call when a Stellar address (an account `G...` or,
 * where allowed, a contract `C...` / muxed `M...` StrKey) fails validation.
 * `field` names the offending parameter and `reason` the specific problem.
 * `address` holds the raw (untrusted) input; the error message only includes
 * a truncated, escaped preview of it so the value cannot inject into logs.
 */
export class InvalidStellarAddressError extends SoroWillError {
  readonly field: string;
  readonly address: string;
  readonly reason: InvalidStellarAddressReason;

  constructor(
    field: string,
    address: unknown,
    reason: InvalidStellarAddressReason,
    options?: ErrorOptions,
  ) {
    const raw = typeof address === 'string' ? address : String(address);
    const preview = JSON.stringify(raw.length > 64 ? `${raw.slice(0, 64)}…` : raw);
    super(`${field} is not a valid Stellar address (${reason.replace(/_/g, ' ')}): ${preview}`, options);
    this.name = new.target.name;
    this.field = field;
    this.address = raw;
    this.reason = reason;
  }
}

/**
 * Raised when a guardian signature provided to `emergencyCheckIn` or guardian operations
 * is invalid: empty, malformed, incorrect length, or not a valid Ed25519 or DecoratedSignature format.
 */
export class InvalidGuardianSignatureError extends SoroWillError {
  readonly signature?: string | undefined;

  constructor(signature?: string, message?: string, options?: ErrorOptions) {
    super(
      message ??
        `Invalid guardian signature: signature must not be empty and must be a valid 64-byte Ed25519 signature or decorated signature.`,
      options,
    );
    this.name = new.target.name;
    this.signature = signature;
  }
}

/**
 * Raised when the connected wallet's active network does not match the
 * network {@link SoroWillClient} was configured with — e.g. Freighter is set
 * to mainnet while the app instantiated a testnet client. Thrown before a
 * transaction is built and sent for signing.
 */
export class WalletNetworkMismatchError extends SoroWillError {
  readonly expectedNetworkPassphrase: string;
  readonly actualNetworkPassphrase: string;

  constructor(expectedNetworkPassphrase: string, actualNetworkPassphrase: string, options?: ErrorOptions) {
    super(
      `The connected wallet is on network ${describeNetworkPassphrase(actualNetworkPassphrase)}, but this client is configured for ${describeNetworkPassphrase(expectedNetworkPassphrase)}. Switch the wallet's network or reconfigure the client before signing.`,
      options,
    );
    this.name = new.target.name;
    this.expectedNetworkPassphrase = expectedNetworkPassphrase;
    this.actualNetworkPassphrase = actualNetworkPassphrase;
  }
}

/**
 * Raised when a built or prepared transaction envelope's network passphrase
 * does not match the client's configured network passphrase before signing.
 */
export class TransactionNetworkMismatchError extends SoroWillError {
  readonly expectedNetworkPassphrase: string;
  readonly actualNetworkPassphrase: string;

  constructor(
    expectedNetworkPassphrase: string,
    actualNetworkPassphrase: string,
    options?: ErrorOptions,
  ) {
    super(
      `Transaction envelope targets network ${describeNetworkPassphrase(actualNetworkPassphrase)}, but this client is configured for ${describeNetworkPassphrase(expectedNetworkPassphrase)}. Refusing to sign to prevent cross-network signature attacks.`,
      options,
    );
    this.name = new.target.name;
    this.expectedNetworkPassphrase = expectedNetworkPassphrase;
    this.actualNetworkPassphrase = actualNetworkPassphrase;
  }
}

/** Well-known Stellar network passphrases, mapped to a readable name. */
const KNOWN_NETWORK_NAMES: Record<string, string> = {
  'Public Global Stellar Network ; September 2015': 'mainnet',
  'Test SDF Network ; September 2015': 'testnet',
  'Test SDF Future Network ; October 2022': 'futurenet',
};

/** Renders a passphrase for an error message, naming well-known networks. */
function describeNetworkPassphrase(passphrase: string): string {
  if (!passphrase) {
    return '(unknown — the wallet did not report a network)';
  }
  const name = KNOWN_NETWORK_NAMES[passphrase];
  return name ? `${name} ("${passphrase}")` : `"${passphrase}"`;
}

const CONTRACT_ERROR_METADATA: Readonly<Record<number, { errorCode: ErrorCode; recoverySteps: string }>> = {
  1: { errorCode: ErrorCode.WILL_NOT_FOUND, recoverySteps: 'Verify the will ID and ensure you are connected to the right network.' },
  2: { errorCode: ErrorCode.NOT_OWNER, recoverySteps: 'Connect with the wallet that owns this will and try again.' },
  3: { errorCode: ErrorCode.WILL_NOT_ACTIVE, recoverySteps: 'Check the will status; only active wills support this operation.' },
  4: { errorCode: ErrorCode.WILL_NOT_TRIGGERED, recoverySteps: 'Wait until the check-in deadline passes and trigger the will first.' },
  5: { errorCode: ErrorCode.GRACE_PERIOD_NOT_EXPIRED, recoverySteps: 'Wait for the grace period to finish before claiming or releasing funds.' },
  6: { errorCode: ErrorCode.GRACE_PERIOD_EXPIRED, recoverySteps: 'The grace period has ended; check the will status for next available actions.' },
  7: { errorCode: ErrorCode.INVALID_PERCENTAGES, recoverySteps: 'Adjust beneficiary percentages so they add up to exactly 100%.' },
  8: { errorCode: ErrorCode.ALREADY_VOTED, recoverySteps: 'This guardian has already cast their vote; wait for other guardians.' },
  9: { errorCode: ErrorCode.NOT_GUARDIAN, recoverySteps: 'Connect with an authorized guardian wallet for this will.' },
  10: { errorCode: ErrorCode.CHECKIN_NOT_DUE, recoverySteps: 'No action needed yet; check in closer to your next deadline.' },
  11: { errorCode: ErrorCode.ZERO_AMOUNT, recoverySteps: 'Enter a positive amount greater than zero and try again.' },
  12: { errorCode: ErrorCode.TOO_MANY_BENEFICIARIES, recoverySteps: 'Reduce the number of beneficiaries to within the allowed limit.' },
  13: { errorCode: ErrorCode.WILL_NOT_SETTLED, recoverySteps: 'Wait until all claims or settlements complete before retrying.' },
  14: { errorCode: ErrorCode.WILL_NOT_BOTH_ACTIVE, recoverySteps: 'Ensure both wills are in an active state before merging.' },
  15: { errorCode: ErrorCode.SAME_WILL_ID, recoverySteps: 'Select two different will IDs and try again.' },
  16: { errorCode: ErrorCode.MERGE_WOULD_EXCEED_LIMITS, recoverySteps: 'Remove excess beneficiaries or guardians before merging.' },
  17: { errorCode: ErrorCode.OWNER_CANNOT_BE_GUARDIAN, recoverySteps: 'Choose a different Stellar address for the guardian.' },
  18: { errorCode: ErrorCode.BENEFICIARY_NOT_FOUND, recoverySteps: 'Verify the beneficiary address is listed on this will.' },
  19: { errorCode: ErrorCode.KEEPER_BOUNTY_EXCEEDS_MAX, recoverySteps: 'Lower the keeper bounty percentage and try again.' },
  20: { errorCode: ErrorCode.INVALID_GUARDIAN_THRESHOLD, recoverySteps: 'Set a threshold between 1 and the total number of guardians.' },
  21: { errorCode: ErrorCode.FIXED_AMOUNT_EXCEEDS_BALANCE, recoverySteps: 'Top up the will balance or reduce the fixed payout amount.' },
  22: { errorCode: ErrorCode.INVALID_PERCENTAGE, recoverySteps: 'Use a valid percentage between 1 and 100.' },
  23: { errorCode: ErrorCode.WILL_NOT_RELEASED, recoverySteps: 'Trigger the will and wait for the grace period before claiming.' },
  24: { errorCode: ErrorCode.NOT_SAME_OWNER, recoverySteps: 'Select wills that belong to the same owner address.' },
  25: { errorCode: ErrorCode.INVALID_PERIOD, recoverySteps: 'Enter a valid check-in or grace period within allowed bounds.' },
  26: { errorCode: ErrorCode.DUPLICATE_GUARDIAN, recoverySteps: 'Remove duplicate guardian addresses and try again.' },
  27: { errorCode: ErrorCode.GUARDIAN_COOLDOWN_ACTIVE, recoverySteps: 'Wait for the guardian cooldown period to elapse before retrying.' },
  28: { errorCode: ErrorCode.INVALID_TOKEN, recoverySteps: 'Select a supported Stellar token contract address.' },
  29: { errorCode: ErrorCode.DUPLICATE_BENEFICIARY, recoverySteps: 'Remove duplicate beneficiary addresses and try again.' },
  30: { errorCode: ErrorCode.WILL_NOT_CONFIRMED, recoverySteps: 'Confirm the will before performing this operation.' },
  31: { errorCode: ErrorCode.CONFIRMATION_WINDOW_EXPIRED, recoverySteps: 'Create a new will or request a new confirmation window.' },
  32: { errorCode: ErrorCode.TOO_MANY_IDS, recoverySteps: 'Reduce the number of will IDs in a single request.' },
  33: { errorCode: ErrorCode.INSUFFICIENT_BALANCE, recoverySteps: 'Ensure your wallet has enough token balance and XLM for fees.' },
  34: { errorCode: ErrorCode.INVALID_SPLIT, recoverySteps: 'Review the beneficiary split configuration and try again.' },
  35: { errorCode: ErrorCode.INVALID_PREIMAGE, recoverySteps: 'Verify the claim secret/preimage and try again.' },
  36: { errorCode: ErrorCode.ALREADY_CLAIMED, recoverySteps: 'This share has already been claimed; no further action is needed.' },
  37: { errorCode: ErrorCode.TOO_MANY_WILLS, recoverySteps: 'Close or settle an existing will before creating a new one.' },
};

/** Base class for typed errors returned by the SoroWill contract. */
export class WillContractError extends SoroWillError {
  constructor(
    readonly code: number,
    readonly contractError: string,
    message: string,
    options?: ErrorOptions,
  ) {
    const meta = CONTRACT_ERROR_METADATA[code];
    const recoverySteps = meta?.recoverySteps;
    const fullMessage = recoverySteps ? `${message}. ${recoverySteps}` : message;
    super(fullMessage, {
      ...options,
      ...(meta ? { errorCode: meta.errorCode, recoverySteps } : {}),
    });
  }
}

type ContractErrorConstructor = new (options?: ErrorOptions) => WillContractError;

function defineContractError(
  code: number,
  contractError: string,
  message: string,
): ContractErrorConstructor {
  return class extends WillContractError {
    constructor(options?: ErrorOptions) {
      super(code, contractError, message, options);
      this.name = `${contractError}Error`;
    }
  };
}

export const WillNotFoundError = defineContractError(1, 'WillNotFound', 'The will was not found');
export const NotOwnerError = defineContractError(2, 'NotOwner', 'The caller is not the will owner');
export const WillNotActiveError = defineContractError(
  3,
  'WillNotActive',
  'The will is not active',
);
export const WillNotTriggeredError = defineContractError(
  4,
  'WillNotTriggered',
  'The will has not been triggered',
);
export const GracePeriodNotExpiredError = defineContractError(
  5,
  'GracePeriodNotExpired',
  'The grace period has not expired',
);
export const GracePeriodExpiredError = defineContractError(
  6,
  'GracePeriodExpired',
  'The grace period has expired',
);
export const InvalidPercentagesError = defineContractError(
  7,
  'InvalidPercentages',
  'Beneficiary percentages must sum to 100',
);
export const AlreadyVotedError = defineContractError(
  8,
  'AlreadyVoted',
  'The guardian has already voted',
);
export const NotGuardianError = defineContractError(
  9,
  'NotGuardian',
  'The caller is not a guardian',
);
export const CheckinNotDueError = defineContractError(
  10,
  'CheckinNotDue',
  'The check-in deadline has not passed',
);
export const ZeroAmountError = defineContractError(
  11,
  'ZeroAmount',
  'The amount must be greater than zero',
);
export const TooManyBeneficiariesError = defineContractError(
  12,
  'TooManyBeneficiaries',
  'Too many beneficiaries or guardians were supplied',
);
export const WillNotSettledError = defineContractError(
  13,
  'WillNotSettled',
  'The will must be released or cancelled for this action',
);
export const WillNotBothActiveError = defineContractError(
  14,
  'WillNotBothActive',
  'Both wills must be active to merge them',
);
export const SameWillIdError = defineContractError(
  15,
  'SameWillId',
  'The same will id was provided for both sides of the merge',
);
export const MergeWouldExceedLimitsError = defineContractError(
  16,
  'MergeWouldExceedLimits',
  'Merging would exceed the beneficiary or guardian limits',
);
export const OwnerCannotBeGuardianError = defineContractError(
  17,
  'OwnerCannotBeGuardian',
  'The owner cannot be a guardian of their own will',
);
export const BeneficiaryNotFoundError = defineContractError(
  18,
  'BeneficiaryNotFound',
  'The beneficiary was not found in the will',
);
export const KeeperBountyExceedsMaxError = defineContractError(
  19,
  'KeeperBountyExceedsMax',
  'The keeper bounty exceeds the maximum allowed (100 bps / 1%)',
);
export const InvalidGuardianThresholdError = defineContractError(
  20,
  'InvalidGuardianThreshold',
  'The guardian threshold must be between 1 and the number of guardians',
);
export const FixedAmountExceedsBalanceError = defineContractError(
  21,
  'FixedAmountExceedsBalance',
  "The fixed-amount allocations exceed the will's balance",
);
export const InvalidPercentageError = defineContractError(
  22,
  'InvalidPercentage',
  'A beneficiary percentage is outside the valid range',
);
export const WillNotReleasedError = defineContractError(
  23,
  'WillNotReleased',
  'The will must be released for this action',
);
export const NotSameOwnerError = defineContractError(
  24,
  'NotSameOwner',
  'Both wills must be owned by the same address to merge them',
);
export const InvalidPeriodError = defineContractError(
  25,
  'InvalidPeriod',
  'The check-in or grace period is zero or too large',
);
export const DuplicateGuardianError = defineContractError(
  26,
  'DuplicateGuardian',
  'The same guardian address was supplied more than once',
);
export const GuardianCooldownActiveError = defineContractError(
  27,
  'GuardianCooldownActive',
  'The guardian-list cooldown has not yet elapsed',
);
export const InvalidTokenError = defineContractError(
  28,
  'InvalidToken',
  'The supplied token is not a valid SEP-41 token',
);
export const DuplicateBeneficiaryError = defineContractError(
  29,
  'DuplicateBeneficiary',
  'The same beneficiary address was supplied more than once',
);
export const WillNotConfirmedError = defineContractError(
  30,
  'WillNotConfirmed',
  'The will is not awaiting confirmation',
);
export const ConfirmationWindowExpiredError = defineContractError(
  31,
  'ConfirmationWindowExpired',
  'The confirmation window has expired',
);
export const TooManyIdsError = defineContractError(
  32,
  'TooManyIds',
  'Too many will ids were supplied',
);
export const InsufficientBalanceError = defineContractError(
  33,
  'InsufficientBalance',
  "The requested split exceeds the will's current balance",
);
export const InvalidSplitError = defineContractError(
  34,
  'InvalidSplit',
  'The split beneficiary list is empty or otherwise invalid',
);
export const InvalidPreimageError = defineContractError(
  35,
  'InvalidPreimage',
  'The revealed pre-image does not match any stored commitment',
);
export const AlreadyClaimedError = defineContractError(
  36,
  'AlreadyClaimed',
  'This hashed beneficiary slot has already been claimed',
);
export const TooManyWillsError = defineContractError(
  37,
  'TooManyWills',
  'An owner or beneficiary index is already at its will-count limit',
);

const CONTRACT_ERRORS: Readonly<Record<number, ContractErrorConstructor>> = {
  1: WillNotFoundError,
  2: NotOwnerError,
  3: WillNotActiveError,
  4: WillNotTriggeredError,
  5: GracePeriodNotExpiredError,
  6: GracePeriodExpiredError,
  7: InvalidPercentagesError,
  8: AlreadyVotedError,
  9: NotGuardianError,
  10: CheckinNotDueError,
  11: ZeroAmountError,
  12: TooManyBeneficiariesError,
  13: WillNotSettledError,
  14: WillNotBothActiveError,
  15: SameWillIdError,
  16: MergeWouldExceedLimitsError,
  17: OwnerCannotBeGuardianError,
  18: BeneficiaryNotFoundError,
  19: KeeperBountyExceedsMaxError,
  20: InvalidGuardianThresholdError,
  21: FixedAmountExceedsBalanceError,
  22: InvalidPercentageError,
  23: WillNotReleasedError,
  24: NotSameOwnerError,
  25: InvalidPeriodError,
  26: DuplicateGuardianError,
  27: GuardianCooldownActiveError,
  28: InvalidTokenError,
  29: DuplicateBeneficiaryError,
  30: WillNotConfirmedError,
  31: ConfirmationWindowExpiredError,
  32: TooManyIdsError,
  33: InsufficientBalanceError,
  34: InvalidSplitError,
  35: InvalidPreimageError,
  36: AlreadyClaimedError,
  37: TooManyWillsError,
};

function errorText(
  error: unknown,
  seen = new WeakSet<object>(),
  depth = 0,
): string {
  if (depth >= 5) {
    return '[error depth limit reached]';
  }
  if (error instanceof Error) {
    if (seen.has(error)) {
      return error.message;
    }
    seen.add(error);
    return `${error.message} ${error.cause === undefined ? '' : errorText(error.cause, seen, depth + 1)}`;
  }
  if (typeof error === 'string') {
    return error;
  }
  if (error && typeof error === 'object') {
    if (seen.has(error)) {
      return '[circular error object]';
    }
    seen.add(error);
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/**
 * Raised when a Soroban simulation returns an error result.
 *
 * The raw simulation error string (which may contain contract addresses or
 * other request details) is kept as a structured property — not embedded in
 * the message — so callers can decide whether to log or redact it before
 * forwarding to an error-tracking service.
 */
export class SimulationError extends SoroWillError {
  /**
   * The raw error string returned by the Soroban RPC simulation. May contain
   * contract addresses or other context. Do not forward this to third-party
   * error trackers without redaction.
   */
  readonly simulationError: string;

  constructor(method: string, simulationError: string, options?: ErrorOptions) {
    super(`SoroWill simulation failed for ${method}`, options);
    this.simulationError = simulationError;
  }
}

/**
 * Raised when a Soroban transaction submission returns an ERROR status.
 *
 * The raw XDR error result blob is kept as a structured property — not
 * embedded in the message — so callers can decide whether to log or redact it
 * before forwarding to an error-tracking service.
 */
export class TransactionSubmissionError extends SoroWillError {
  /**
   * The base64-encoded XDR error result returned by the Soroban RPC node.
   * Contains encoded transaction details. Do not forward this to third-party
   * error trackers without redaction.
   */
  readonly errorXdr: string;

  constructor(label: string, errorXdr: string, options?: ErrorOptions) {
    super(`SoroWill transaction submission failed for ${label}`, options);
    this.errorXdr = errorXdr;
  }
}

/**
 * Raised when the account returned by `getAccount()` is not found or has
 * never been funded on the current network. A common situation for brand-new
 * testnet addresses or mainnet addresses that have not yet received the
 * minimum XLM reserve. Source accounts need XLM for the reserve and transaction
 * fees before submitting transactions. Use
 * {@link https://friendbot.stellar.org | Friendbot} for free testnet XLM;
 * mainnet accounts must receive real XLM.
 *
 * The `publicKey` is stored as a structured property rather than being
 * embedded in the message so callers can decide how to handle it (e.g.
 * redacting or hashing it before forwarding to an error-tracking service).
 *
 * @see https://developers.stellar.org/docs/learn/fundamentals/lumens
 */
export class AccountNotFundedError extends SoroWillError {
  /** The Stellar public key whose account could not be loaded. */
  readonly publicKey: string;

  constructor(publicKey: string, options?: ErrorOptions) {
    super(
      `The Stellar account for the connected wallet has not been funded on this network. ` +
        `Fund the account with XLM for the minimum reserve and transaction fees before submitting transactions. ` +
        `For free testnet XLM, visit https://friendbot.stellar.org (testnet only). ` +
        `On mainnet, transfer real XLM to the account. See https://developers.stellar.org/docs/learn/fundamentals/lumens.`,
      options,
    );
    this.publicKey = publicKey;
  }
}

/**
 * Raised when a state-changing contract invocation fails — either because
 * `sendTransaction` returned `ERROR`, or because the polled transaction did
 * not reach `SUCCESS`. Unlike the previous bare `Error` throws, this class
 * preserves the underlying RPC diagnostic payload so callers (and debugging
 * tools) can inspect the root cause.
 */
export class InvokeFailedError extends SoroWillError {
  /**
   * Diagnostic data from the RPC response. May include fields such as
   * `errorXdr`, `diagnosticEventsXdr`, `resultXdr`, or `status` depending
   * on which failure branch was hit. Treat as untrusted/sensitive before
   * forwarding to third-party error-tracking services.
   */
  readonly diagnostics: Record<string, unknown>;

  constructor(method: string, reason: string, diagnostics: Record<string, unknown>, options?: ErrorOptions) {
    super(`SoroWill transaction for ${method} failed: ${reason}`, options);
    this.diagnostics = diagnostics;
  }
}

/**
 * Raised when {@link SoroWillClient.getTransaction} cannot find a transaction
 * with the requested hash on the network.
 *
 * The hash is kept as a structured property — not embedded in the message —
 * because it is caller-supplied data that would otherwise surface in any
 * error-tracking pipeline.
 */
export class TransactionNotFoundError extends SoroWillError {
  /** The transaction hash that was not found. Treat as untrusted before logging. */
  readonly txHash: string;

  constructor(txHash: string, options?: ErrorOptions) {
    super('Transaction not found on the network', options);
    this.txHash = txHash;
  }
}

/**
 * Raised when a pagination cursor supplied by the caller fails validation.
 *
 * The offending cursor string is kept as a structured property — not embedded
 * in the message — because it is user-supplied data that could contain
 * arbitrary content, and embedding it in the message would surface it in any
 * error-tracking pipeline.
 */
export class InvalidCursorError extends SoroWillError {
  /**
   * The cursor value that failed validation. User-supplied; treat as
   * untrusted before logging.
   */
  readonly cursor: string;
  /** Human-readable explanation of why the cursor was rejected, if known. */
  readonly reason: string | undefined;

  constructor(cursor: string, reason?: string, options?: ErrorOptions) {
    super(reason ? `Invalid pagination cursor: ${reason}` : 'Invalid pagination cursor', options);
    this.cursor = cursor;
    this.reason = reason;
  }
}

/**
 * Raised when `subscribeToEvents` is given an `eventTypes` filter containing
 * values outside the supported Soroban event type enum. Without this check an
 * invalid type would produce a subscription that silently matches nothing.
 */
export class InvalidEventTypeFilterError extends SoroWillError {
  /** The filter entries that are not supported event types. */
  readonly invalidTypes: unknown[];
  /** The event types that are accepted in a filter. */
  readonly supportedTypes: readonly string[];

  constructor(invalidTypes: unknown[], supportedTypes: readonly string[], options?: ErrorOptions) {
    super(
      `Invalid event type filter: ${invalidTypes.map((t) => JSON.stringify(t) ?? String(t)).join(', ')}. ` +
        `Supported event types are: ${supportedTypes.join(', ')}.`,
      options,
    );
    this.invalidTypes = invalidTypes;
    this.supportedTypes = supportedTypes;
  }
}

export class InvalidPaginationOptionsError extends SoroWillError {
  readonly option: string;
  readonly value: number | undefined;

  constructor(option: string, value: number | undefined, options?: ErrorOptions) {
    super(`${option} must be a positive integer`, options);
    this.option = option;
    this.value = value;
  }
}

export class InvalidDayCountError extends SoroWillError {
  readonly paramName: string;
  readonly value: number;

  constructor(paramName: string, value: number, options?: ErrorOptions) {
    super(
      `"${paramName}" must be a positive integer (received ${value}). ` +
        `Fractional or non-positive day counts are not supported.`,
      options,
    );
    this.paramName = paramName;
    this.value = value;
  }
}

/**
 * Thrown by `createWill` when `gracePeriodDays` is larger than
 * `checkinPeriodDays`. The contract invariant requires the grace period to be
 * no longer than the check-in period; a larger grace period breaks will logic.
 */
export class GracePeriodExceedsCheckinPeriodError extends SoroWillError {
  readonly gracePeriodDays: number;
  readonly checkinPeriodDays: number;

  constructor(gracePeriodDays: number, checkinPeriodDays: number, options?: ErrorOptions) {
    super(
      `Invalid gracePeriodDays ${gracePeriodDays}: the grace period must be less than or equal to ` +
        `checkinPeriodDays (${checkinPeriodDays}). Reduce gracePeriodDays to at most ${checkinPeriodDays} ` +
        'or increase checkinPeriodDays.',
      options,
    );
    this.name = new.target.name;
    this.gracePeriodDays = gracePeriodDays;
    this.checkinPeriodDays = checkinPeriodDays;
  }
}

/**
 * Raised when `checkinPeriodDays` passed to {@link SoroWillClient.createWill}
 * exceeds the contract storage TTL window the will entry can survive without
 * a check-in extending it. A will whose check-in deadline outlives the
 * ledger-entry TTL would be archived before it can be triggered, bricking it
 * until a manual restore.
 *
 * Thrown synchronously before any RPC call is made.
 *
 * @since 0.1.2
 */
export class CheckinPeriodExceedsTtlError extends SoroWillError {
  /** Check-in period supplied (in days). */
  readonly suppliedDays: number;
  /** Maximum check-in period allowed (in days). */
  readonly maxDays: number;

  constructor(suppliedDays: number, maxDays: number, options?: ErrorOptions) {
    super(
      `Invalid checkinPeriodDays ${suppliedDays}: exceeds the maximum of ${maxDays} days ` +
        'imposed by the contract storage TTL window. A will whose check-in deadline outlives ' +
        'its ledger-entry TTL would be archived before it can be triggered.',
      options,
    );
    this.suppliedDays = suppliedDays;
    this.maxDays = maxDays;
  }
}

/**
 * Raised when a Soroban simulation returns a "restore required" result,
 * indicating that archived/expired ledger entries must be restored via a
 * separate {@link https://developers.stellar.org/docs/smart-contracts/guides/archival | footprint-restoration transaction}
 * before the call can proceed.
 *
 * The caller should build and submit a `restoreFootprint` operation using
 * the {@link restorePreamble} from this error, wait for confirmation, and
 * then retry the original contract call.
 */
export class SoroWillRestoreRequiredError extends SoroWillError {
  /** The simulation response containing the restore preamble needed to build
   * the footprint-restoration transaction. */
  readonly simulation: unknown;

  constructor(message: string, simulation: unknown, options?: ErrorOptions) {
    super(message, options);
    this.simulation = simulation;
  }
}

/**
 * Raised when {@link SoroWillClient.subscribeToEvents} is called with
 * `{ transport: 'websocket' }` but the client was not constructed with both
 * `webSocketFactory` and `eventStreamUrl`. Thrown instead of silently
 * downgrading to polling, since an explicit `'websocket'` request implies the
 * caller relies on WebSocket-specific behavior (e.g. push latency).
 */
export class WebSocketNotConfiguredError extends SoroWillError {
  constructor(options?: ErrorOptions) {
    super(
      'transport: "websocket" was requested but this client was not configured with ' +
        'both webSocketFactory and eventStreamUrl. Configure both, or use transport: "auto" ' +
        'to allow falling back to polling.',
      options,
    );
  }
}

/**
 * Raised when {@link SoroWillClient.subscribeToEvents} is called with
 * `{ transport: 'sse' }` but the client was not constructed with
 * `eventSseUrl`. Thrown instead of silently downgrading to polling, since an
 * explicit `'sse'` request implies the caller relies on push delivery.
 */
export class SseNotConfiguredError extends SoroWillError {
  constructor(options?: ErrorOptions) {
    super(
      'transport: "sse" was requested but this client was not configured with ' +
        'eventSseUrl. Configure it, or use transport: "auto" to allow falling back to polling.',
      options,
    );
  }
}

/**
 * Raised when {@link mapContractError} encounters a numeric contract error
 * code that has no registered mapping in the SDK. This can happen when the
 * on-chain contract is upgraded and adds new error codes before the SDK is
 * updated to match.
 *
 * The raw `code` and the full `rawMessage` from the RPC response are exposed
 * as structured properties so callers (and monitoring pipelines) can log them
 * with full context without embedding potentially sensitive data in the error
 * message itself.
 */
export class UnknownContractErrorCodeError extends SoroWillError {
  /** The numeric error code returned by the contract. */
  readonly code: number;
  /**
   * The full raw error text from the RPC response. May contain contract
   * addresses or other context. Do not forward to third-party error trackers
   * without redaction.
   */
  readonly rawMessage: string;

  constructor(code: number, rawMessage: string, options?: ErrorOptions) {
    const recoverySteps =
      'Please update the SoroWill SDK or refresh the page and try again. If the issue persists, contact support.';
    super(
      `An unexpected contract error occurred (code ${code}). ${recoverySteps}`,
      {
        ...options,
        errorCode: ErrorCode.UNKNOWN_CONTRACT_ERROR,
        recoverySteps,
      },
    );
    this.code = code;
    this.rawMessage = rawMessage;
  }
}

const INTERNAL_CONTRACT_ERROR_PATTERNS: ReadonlyArray<{
  pattern: RegExp;
  errorCode: ErrorCode;
  message: string;
  recoverySteps: string;
}> = [
  {
    pattern: /contract state mismatch|offset \d+|storage|MissingValue|ledger entry/i,
    errorCode: ErrorCode.CONTRACT_STATE_ERROR,
    message: 'The will state could not be verified on the network.',
    recoverySteps: 'Refresh the will details and try your transaction again.',
  },
  {
    pattern: /HostError|wasm|trap|UnreachableCodeReached|ExceededLimit|Budget|ScVal|XDR|diagnostic/i,
    errorCode: ErrorCode.SIMULATION_FAILED,
    message: 'The transaction could not be prepared by the network.',
    recoverySteps: 'Verify your inputs and wallet balance, then try again.',
  },
  {
    pattern: /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|fetch failed|network error|502|503|504/i,
    errorCode: ErrorCode.RPC_UNAVAILABLE,
    message: 'Unable to reach the Stellar network right now.',
    recoverySteps: 'Check your internet connection and try again in a few moments.',
  },
  {
    pattern: /429|too many requests|rate limit/i,
    errorCode: ErrorCode.RATE_LIMITED,
    message: 'Too many requests were sent to the Stellar network.',
    recoverySteps: 'Wait a few seconds before trying again.',
  },
];

/**
 * Sanitizes an arbitrary RPC or contract error so internal implementation
 * details (e.g., byte offsets, WASM traps, HostError, XDR) are never shown
 * directly to end users.
 */
export function sanitizeRpcError(error: unknown): SoroWillError {
  if (error instanceof SoroWillError) {
    return error;
  }
  const text = errorText(error);
  for (const entry of INTERNAL_CONTRACT_ERROR_PATTERNS) {
    if (entry.pattern.test(text)) {
      return new SoroWillError(`${entry.message} ${entry.recoverySteps}`, {
        cause: error,
        errorCode: entry.errorCode,
        recoverySteps: entry.recoverySteps,
      });
    }
  }
  const recoverySteps = 'Please check your connection and wallet, then try again.';
  return new SoroWillError(`An unexpected error occurred. ${recoverySteps}`, {
    cause: error,
    errorCode: ErrorCode.UNKNOWN_ERROR,
    recoverySteps,
  });
}

/**
 * Formats any error into a user-friendly {@link UserFriendlyErrorInfo} object
 * with an {@link ErrorCode}, safe message, and actionable recovery steps.
 */
export function formatUserFriendlyError(error: unknown): UserFriendlyErrorInfo {
  const mapped = mapContractError(error);
  if (mapped instanceof SoroWillError && mapped.errorCode !== undefined) {
    return {
      errorCode: mapped.errorCode,
      message: mapped.message,
      recoverySteps:
        mapped.recoverySteps ?? 'Please verify your inputs and try again.',
    };
  }
  const sanitized = sanitizeRpcError(mapped);
  return {
    errorCode: sanitized.errorCode ?? ErrorCode.UNKNOWN_ERROR,
    message: sanitized.message,
    recoverySteps:
      sanitized.recoverySteps ?? 'Please verify your inputs and try again.',
  };
}

/** Converts a Soroban contract error code embedded in an RPC error into its typed SDK error. */
export function mapContractError(error: unknown): Error {
  if (error instanceof WillContractError || error instanceof RequestTimeoutError) {
    return error;
  }
  // SimulationError wraps a contract simulation error; extract the contract
  // error code from its `simulationError` property so that typed contract
  // errors (e.g. WillNotFoundError) are properly mapped.
  if (error instanceof SimulationError) {
    const simText = error.simulationError;
    const simMatch =
      /Error\(Contract,\s*#?(\d+)\)/i.exec(simText) ??
      /(?:contract error|contracterror|error code)[^\d#]*#?(\d+)/i.exec(simText) ??
      /^#?(\d+)$/i.exec(simText.trim());
    const simCodeText = simMatch?.[1];
    if (simCodeText !== undefined) {
      const simCode = Number(simCodeText);
      const ErrorClass = CONTRACT_ERRORS[simCode];
      if (ErrorClass !== undefined) {
        return new ErrorClass({ cause: error });
      }
    }
  }
  const text = errorText(error);
  const match =
    /Error\(Contract,\s*#?(\d+)\)/i.exec(text) ??
    /(?:contract error|contracterror|error code)[^\d#]*#?(\d+)/i.exec(text) ??
    /^#?(\d+)$/i.exec(text.trim());
  const codeText = match?.[1];

  if (codeText === undefined) {
    // Sanitize internal contract/VM/RPC errors so raw internals are never exposed to users.
    for (const entry of INTERNAL_CONTRACT_ERROR_PATTERNS) {
      if (entry.pattern.test(text)) {
        return new SoroWillError(`${entry.message} ${entry.recoverySteps}`, {
          cause: error,
          errorCode: entry.errorCode,
          recoverySteps: entry.recoverySteps,
        });
      }
    }
    // No numeric error code or internal pattern found — return the original error or wrap in SoroWillError.
    return error instanceof Error ? error : new SoroWillError(text);
  }

  const code = Number(codeText);
  const ErrorClass = CONTRACT_ERRORS[code];

  if (ErrorClass !== undefined) {
    return new ErrorClass({ cause: error });
  }

  // Unknown error code — the contract may have been upgraded with new codes
  // that the SDK does not yet know about.  Log the full context so developers
  // and monitoring pipelines can diagnose the problem, then surface a
  // user-friendly message via UnknownContractErrorCodeError.
  console.warn(
    `[SoroWill] Unrecognised contract error code ${code}. ` +
      'The contract may have been upgraded. Update @sorowill/sdk to get typed errors for new codes.',
    { code, rawMessage: text },
  );
  return new UnknownContractErrorCodeError(code, text, { cause: error });
}

export class MultisigTimeoutError extends Error {
  constructor(signedCount: number, threshold: number, timeoutMs: number) {
    super(`Multisig coordination timed out after ${timeoutMs}ms with only ${signedCount}/${threshold} signatures`);
    this.name = 'MultisigTimeoutError';
  }
}

/**
 * Raised by {@link SoroWillClient.releaseInheritance} when the will's grace
 * period has not yet expired. The grace period begins when the will is
 * triggered and must elapse before the inheritance can be released.
 * Throwing this client-side avoids a wasted signing round-trip that the
 * contract would reject with {@link GracePeriodNotExpiredError}.
 */
export class GracePeriodActiveError extends SoroWillError {
  /** The will ID whose grace period is still active. */
  readonly willId: string;
  /** The UTC time at which the grace period expires. */
  readonly expiresAt: Date;

  constructor(willId: string, expiresAt: Date, options?: ErrorOptions) {
    const isoExpiry = expiresAt.toISOString();
    super(
      `Cannot release inheritance for will "${willId}": the grace period is still active and expires at ${isoExpiry}. ` +
        'Wait until the grace period has elapsed before calling releaseInheritance().',
      options,
    );
    this.name = 'GracePeriodActiveError';
    this.willId = willId;
    this.expiresAt = expiresAt;
  }
}

export class ExorbitantFeeError extends Error {
  constructor(fee: string, maxFee: string) {
    super(`Fee ${fee} exceeds maximum allowed ${maxFee}`);
    this.name = 'ExorbitantFeeError';
  }
}

/**
 * Raised when a WalletConnect signing request specifies a `requestChainId`
 * that does not match the chain ID of the active session. Sending a
 * transaction to the wrong chain silently succeeds at the wallet level but
 * would be applied to a different network than intended.
 *
 * @example
 * ```ts
 * try {
 *   await adapter.signTransaction(xdr, { networkPassphrase, requestChainId: 'stellar:testnet' });
 * } catch (err) {
 *   if (err instanceof WalletConnectChainIdMismatchError) {
 *     console.error('Chain ID mismatch:', err.requestedChainId, 'vs', err.sessionChainId);
 *   }
 * }
 * ```
 */
export class WalletConnectChainIdMismatchError extends SoroWillError {
  /** The chain ID that was requested via `requestChainId`. */
  readonly requestedChainId: string;
  /** The chain ID derived from the active WalletConnect session. */
  readonly sessionChainId: string;

  constructor(requestedChainId: string, sessionChainId: string, options?: ErrorOptions) {
    super(
      `WalletConnect chain ID mismatch: requested "${requestedChainId}" but the active session ` +
        `is on "${sessionChainId}". Connect a session for the correct chain before signing.`,
      options,
    );
    this.requestedChainId = requestedChainId;
    this.sessionChainId = sessionChainId;
  }
}

/**
 * Raised when an `eventStreamUrl` passed to {@link SoroWillClient} is not a
 * valid `wss://` URL. Plaintext `ws://` connections are rejected because they
 * expose event traffic to eavesdropping and manipulation.
 *
 * @example
 * ```ts
 * // Throws InvalidWebSocketUrlError
 * new SoroWillClient({ ..., eventStreamUrl: 'ws://example.com/events' });
 * ```
 */
export class InvalidWebSocketUrlError extends SoroWillError {
  /** The invalid URL that was supplied. */
  readonly url: string;

  constructor(url: string, options?: ErrorOptions) {
    super(
      `Invalid WebSocket URL "${url}": only secure wss:// URLs are accepted. ` +
        'Plain ws:// connections are not allowed because they expose event traffic to interception.',
      options,
    );
    this.url = url;
  }
}

/**
 * Raised when {@link SoroWillClient.checkIn} is called for a will that is in
 * the `Triggered` state (i.e. currently in its grace period). The contract
 * will reject a `check_in` call in this state; use `emergencyCheckIn` instead
 * to cancel the grace period and reset the countdown.
 *
 * @example
 * ```ts
 * try {
 *   await client.checkIn(willId);
 * } catch (err) {
 *   if (err instanceof CheckInDuringGracePeriodError) {
 *     // Offer the owner the emergency check-in option instead.
 *     await client.emergencyCheckIn(willId);
 *   }
 * }
 * ```
 */
export interface CheckInDuringGracePeriodDetails {
  /** When the grace period ends (`triggerTime` + `gracePeriodDays`). */
  graceEndsAt?: Date | undefined;
  /** Next check-in deadline for the will, if known. */
  nextDeadline?: Date | undefined;
  /** Clock used to compute time remaining. Defaults to `Date.now()`. */
  now?: number | undefined;
}

export class CheckInDuringGracePeriodError extends SoroWillError {
  /** The will ID that is currently in its grace period. */
  readonly willId: string;
  /** When the grace period ends, if known. */
  readonly graceEndsAt: Date | undefined;
  /** Next check-in deadline for the will, if known. */
  readonly nextDeadline: Date | undefined;
  /** Milliseconds left in the grace period (0 if already ended), if known. */
  readonly timeRemainingMs: number | undefined;

  constructor(willId: string, details: CheckInDuringGracePeriodDetails = {}, options?: ErrorOptions) {
    const now = details.now ?? Date.now();
    const graceEndsAt = details.graceEndsAt;
    const nextDeadline = details.nextDeadline;
    const timeRemainingMs =
      graceEndsAt === undefined ? undefined : Math.max(0, graceEndsAt.getTime() - now);

    let message =
      `Cannot check in during grace period: will "${willId}" is in its grace period (Triggered state). `;
    if (graceEndsAt !== undefined && timeRemainingMs !== undefined) {
      const hours = Math.ceil(timeRemainingMs / 3_600_000);
      message +=
        `The grace period ends at ${graceEndsAt.toISOString()} (${hours} hour${hours === 1 ? '' : 's'} remaining). ` +
        'Check in after the grace period ends';
    } else {
      message += 'Check in after the grace period ends';
    }
    if (nextDeadline !== undefined) {
      message += `; the next check-in deadline is ${nextDeadline.toISOString()}`;
    }
    message += '. To cancel the grace period and reset the countdown now, use emergencyCheckIn().';

    super(message, options);
    this.willId = willId;
    this.graceEndsAt = graceEndsAt;
    this.nextDeadline = nextDeadline;
    this.timeRemainingMs = timeRemainingMs;
  }
}

export function registerContractError(_code: number, _errorFactory: ContractErrorFactory): void {
  // Stub implementation - actual error registry would be managed elsewhere
}

export function registerContractErrors(_errors: Record<number, ContractErrorFactory>): void {
  // Stub implementation
}

export function setContractErrorMap(_map: Map<number, ContractErrorFactory>): void {
  // Stub implementation
}

export function getContractErrorMap(): Map<number, ContractErrorFactory> {
  return new Map();
}

export class ReadOnlyModeError extends SoroWillError {
  readonly method: string;

  constructor(operation: string, options?: ErrorOptions) {
    super(
      `Operation "${operation}" is not allowed in read-only mode`,
      options,
    );
    this.name = 'ReadOnlyModeError';
    this.method = operation;
  }
}

export class WalletSessionError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause ? { cause } : undefined);
    this.name = 'WalletSessionError';
  }
}

export class WalletSessionExpiredError extends WalletSessionError {
  readonly expiresAt: number | undefined;

  constructor(expiresAt?: number, options?: ErrorOptions) {
    super('Wallet session has expired or is no longer valid', options?.cause);
    this.name = 'WalletSessionExpiredError';
    this.expiresAt = expiresAt;
  }
}

export class HookReturnValueError extends SoroWillError {
  readonly hookName: string;
  readonly returnValue: unknown;

  constructor(hookName: string, returnValue: unknown, options?: ErrorOptions) {
    const valueStr = returnValue === null ? 'null' : (typeof returnValue === 'object' ? JSON.stringify(returnValue) : String(returnValue));
    const allowedValues = hookName === 'beforeInvoke' ? 'true or undefined' : 'true, false, or undefined';
    super(
      `${hookName} hook returned an invalid value: ${valueStr}. Hooks must return ${allowedValues}.`,
      options,
    );
    this.name = 'HookReturnValueError';
    this.hookName = hookName;
    this.returnValue = returnValue;
  }
}

/**
 * Raised when a user explicitly cancels or rejects a wallet prompt (e.g.
 * connection approval or transaction signing), distinguishing user intent from
 * network, RPC, or internal wallet failures.
 */
export class WalletCancelledError extends SoroWillError {
  readonly operation: string | undefined;

  constructor(
    message = 'Wallet request was cancelled by the user.',
    options?: ErrorOptions & { operation?: string },
  ) {
    super(message, options);
    this.operation = options?.operation;
  }
}

const USER_CANCELLATION_MESSAGE_PATTERNS: readonly RegExp[] = [
  /user\s*(declined|rejected|cancel+ed|denied)/i,
  /declined\s*by\s*(the\s*)?user/i,
  /rejected\s*by\s*(the\s*)?user/i,
  /denied\s*by\s*(the\s*)?user/i,
  /action\s*request\s*was\s*rejected/i,
  /transaction\s*(was\s*)?(rejected|cancelled|canceled|declined)/i,
  /request\s*(was\s*)?(rejected|cancelled|canceled|declined)\s*(by\s*(the\s*)?user)?/i,
];

/**
 * Returns `true` when `error` represents an explicit user cancellation or
 * rejection in a wallet UI/device (rather than a network, timeout, or internal
 * wallet failure).
 */
export function isUserCancellationError(error: unknown): boolean {
  if (error instanceof WalletCancelledError) {
    return true;
  }
  if (!error || (typeof error !== 'object' && typeof error !== 'string')) {
    return false;
  }

  if (typeof error === 'object') {
    const record = error as Record<string, unknown>;
    // Freighter / Albedo (-4), EIP-1193 (4001), WalletConnect v2 (5000)
    if (record.code === -4 || record.code === 4001 || record.code === 5000) {
      return true;
    }
    // Ledger APDU status 0x6985 (Condition of use not satisfied / User rejected)
    if (record.statusCode === 0x6985) {
      return true;
    }
  }

  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : typeof (error as Record<string, unknown>).message === 'string'
          ? String((error as Record<string, unknown>).message)
          : '';

  if (!message) {
    return false;
  }
  if (message.includes('0x6985')) {
    return true;
  }
  return USER_CANCELLATION_MESSAGE_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * Converts a user-cancellation error into a {@link WalletCancelledError},
 * preserving the original error as `cause`. Returns `null` when `error` is
 * not a user cancellation so callers can rethrow non-cancellation errors as-is.
 */
export function toWalletCancelledError(
  error: unknown,
  operation?: string,
): WalletCancelledError | null {
  if (error instanceof WalletCancelledError) {
    return error;
  }
  if (!isUserCancellationError(error)) {
    return null;
  }
  const message =
    operation !== undefined
      ? `Wallet ${operation} was cancelled by the user.`
      : 'Wallet request was cancelled by the user.';
  return new WalletCancelledError(message, {
    cause: error,
    ...(operation !== undefined ? { operation } : {}),
  });
}

export type ContractErrorFactory = (details: unknown) => Error;
