/** Base class for errors raised by the SoroWill SDK. */
export class SoroWillError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
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

  constructor(timeoutMs: number, options?: ErrorOptions) {
    super(`SoroWill RPC request timed out after ${timeoutMs}ms`, options);
    this.timeoutMs = timeoutMs;
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
      `"${contractId}" is not a valid SoroWill contract address. ` +
        'A Stellar contract address must be a 56-character StrKey starting with "C".',
      options,
    );
    this.contractId = contractId;
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
      `The connected wallet is on network "${actualNetworkPassphrase}", but this client is configured for "${expectedNetworkPassphrase}". Switch the wallet's network or reconfigure the client before signing.`,
      options,
    );
    this.expectedNetworkPassphrase = expectedNetworkPassphrase;
    this.actualNetworkPassphrase = actualNetworkPassphrase;
  }
}

/** Base class for typed errors returned by the SoroWill contract. */
export class WillContractError extends SoroWillError {
  constructor(
    readonly code: number,
    readonly contractError: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
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
};

function errorText(error: unknown): string {
  if (error instanceof Error) {
    return `${error.message} ${error.cause === undefined ? '' : errorText(error.cause)}`;
  }
  if (typeof error === 'string') {
    return error;
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

  constructor(cursor: string, options?: ErrorOptions) {
    super('Invalid pagination cursor', options);
    this.cursor = cursor;
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

/** Converts a Soroban contract error code embedded in an RPC error into its typed SDK error. */
export function mapContractError(error: unknown): Error {
  if (error instanceof WillContractError || error instanceof RequestTimeoutError) {
    return error;
  }
  const text = errorText(error);
  const match =
    /Error\(Contract,\s*#?(\d+)\)/i.exec(text) ??
    /(?:contract error|contracterror|error code)[^\d#]*#?(\d+)/i.exec(text);
  const codeText = match?.[1];
  const ErrorClass = codeText === undefined ? undefined : CONTRACT_ERRORS[Number(codeText)];
  return ErrorClass === undefined ? (error instanceof Error ? error : new SoroWillError(text)) : new ErrorClass({ cause: error });
}
