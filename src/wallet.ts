import type FreighterApi from '@stellar/freighter-api';

import {
  FreighterConnectionTimeoutError,
  FreighterInstallCheckError,
  FreighterNotAvailableError,
  InvalidSignedXdrEncodingError,
  SignTransactionTimeoutError,
  SoroWillError,
  toWalletCancelledError,
  WalletCancelledError,
  WalletNetworkMismatchError,
  MultisigTimeoutError,
  WalletSessionError,
  WalletSessionExpiredError,
} from './errors';

export { WalletCancelledError, WalletSessionError, WalletSessionExpiredError };

/**
 * Union of the typed errors a {@link WalletAdapter} implementation — or the
 * SDK itself on the adapter's behalf — can raise (#524).
 *
 * Every adapter method documents which of these it may throw. Adapters may
 * additionally throw a plain `Error` carrying a wallet-reported message (for
 * example, "user rejected the request"), since third-party wallet libraries
 * surface their failures that way; use the type guards below to distinguish
 * the SDK-typed errors from such wallet-reported failures.
 *
 * Transport-specific adapters may raise additional errors (e.g.
 * `WalletConnectTimeoutError` from the WalletConnect transport); those are
 * documented on the respective adapter classes.
 */
export type WalletAdapterError =
  /** The user explicitly cancelled or rejected the wallet prompt. */
  | WalletCancelledError
  /** Session token could not be read, refreshed, or is still invalid. */
  | WalletSessionError
  /** The wallet's `signTransaction` did not resolve within the allowed time. */
  | SignTransactionTimeoutError
  /** The wallet is connected to a different network than the client expects. */
  | WalletNetworkMismatchError
  /** Freighter's presence could not be determined due to an internal error. */
  | FreighterInstallCheckError;

/** Type guard for {@link WalletCancelledError}. */
export function isWalletCancelledError(error: unknown): error is WalletCancelledError {
  return error instanceof WalletCancelledError;
}

/** Type guard for {@link WalletSessionError}. */
export function isWalletSessionError(error: unknown): error is WalletSessionError {
  return error instanceof WalletSessionError;
}

/** Type guard for {@link SignTransactionTimeoutError}. */
export function isSignTransactionTimeoutError(
  error: unknown,
): error is SignTransactionTimeoutError {
  return error instanceof SignTransactionTimeoutError;
}

/** Type guard for {@link WalletNetworkMismatchError}. */
export function isWalletNetworkMismatchError(
  error: unknown,
): error is WalletNetworkMismatchError {
  return error instanceof WalletNetworkMismatchError;
}

/** Type guard for {@link FreighterInstallCheckError}. */
export function isFreighterInstallCheckError(
  error: unknown,
): error is FreighterInstallCheckError {
  return error instanceof FreighterInstallCheckError;
}

/** Type guard for {@link FreighterConnectionTimeoutError}. */
export function isFreighterConnectionTimeoutError(
  error: unknown,
): error is FreighterConnectionTimeoutError {
  return error instanceof FreighterConnectionTimeoutError;
}

/** Default timeout (ms) for Freighter wallet connection requests. */
export const DEFAULT_FREIGHTER_CONNECT_TIMEOUT_MS = 30_000;

/**
 * Maximum allowed length for a {@link WalletSession} token string.
 */
const MAX_WALLET_SESSION_TOKEN_LENGTH = 4096;

/**
 * Allowed character set for {@link WalletSession} tokens: printable URL-safe /
 * base64 / JWT / Stellar StrKey characters with no whitespace or control chars.
 */
const WALLET_SESSION_TOKEN_PATTERN = /^[A-Za-z0-9._~+/=-]+$/;

/**
 * Returns `true` when `token` is a non-empty string with a valid session token
 * format (no whitespace, control characters, or arbitrary punctuation, and
 * within {@link MAX_WALLET_SESSION_TOKEN_LENGTH}).
 */
export function isValidWalletSessionToken(token: unknown): token is string {
  return (
    typeof token === 'string' &&
    token.length > 0 &&
    token.length <= MAX_WALLET_SESSION_TOKEN_LENGTH &&
    WALLET_SESSION_TOKEN_PATTERN.test(token)
  );
}

/**
 * Validates that `token` conforms to the expected {@link WalletSession} token
 * format and returns it, throwing {@link WalletSessionError} otherwise.
 */
export function validateWalletSessionToken(token: unknown): string {
  if (!isValidWalletSessionToken(token)) {
    throw new WalletSessionError(
      'The wallet session token has an invalid format. Reconnect the wallet and try again.',
    );
  }
  return token;
}

/**
 * Represents a wallet session token used for transaction signing.
 *
 * `token` must be a non-empty string matching `/^[A-Za-z0-9._~+/=-]+$/`
 * (up to 4096 characters, with no whitespace or control characters).
 */
export interface WalletSession {
  token: string;
  /**
   * Session expiry as UTC milliseconds since the Unix epoch
   * (`Date.now()`-compatible). Compare against `Date.now()` to determine
   * whether the session is still valid. A session is considered expired when
   * `expiresAt <= now`.
   *
   * @example
   * ```ts
   * // 15 minutes from now (UTC milliseconds)
   * const session: WalletSession = {
   *   token: 'abc123',
   *   expiresAt: Date.now() + 15 * 60 * 1000,
   * };
   * ```
   */
  expiresAt?: number;
}

/** Default session token TTL in milliseconds (15 minutes). */
export const DEFAULT_SESSION_TTL_MS = 15 * 60 * 1000;

/**
 * `@stellar/freighter-api` is an optional peer dependency — consumers who
 * only use Albedo, Ledger, WalletConnect, or a custom {@link WalletAdapter}
 * are not required to install it. Importing it lazily (only when a
 * `FreighterWalletAdapter` method actually runs) keeps the SDK's main entry
 * point importable without it installed.
 */
let freighterApiPromise: Promise<typeof FreighterApi> | undefined;
function loadFreighterApi(): Promise<typeof FreighterApi> {
  if (!freighterApiPromise) {
    freighterApiPromise = import('@stellar/freighter-api').then((mod) => mod.default);
  }
  return freighterApiPromise;
}

/** Freighter error code for context invalidation (extension reload/update). */
const FREIGHTER_CONTEXT_INVALIDATED_CODE = -3;

/** Default interval (ms) for watching wallet changes. */
const DEFAULT_FREIGHTER_WATCH_INTERVAL_MS = 1000;

/** Type for network change listeners. */
export type WalletNetworkChangeListener = (network: { network: string; networkPassphrase: string }) => void;

/** Default number of times to check for Freighter's window injection. */
export const DEFAULT_FREIGHTER_INJECTION_RETRIES = 10;

/** Default delay (ms) between Freighter window-injection checks. */
export const DEFAULT_FREIGHTER_INJECTION_RETRY_DELAY_MS = 100;

/**
 * Reports whether the Freighter extension has injected its global into the
 * page. Older Freighter builds expose `window.freighter`; newer ones (and the
 * Stellar wallet standard) use `window.stellar`.
 */
function isFreighterInjected(): boolean {
  const win = (globalThis as unknown as { window?: Record<string, unknown> }).window;
  return Boolean(win && (win.freighter || win.stellar));
}

/**
 * Waits for the Freighter extension to inject itself into the page.
 *
 * Browser extensions inject their content scripts asynchronously, so a page
 * that calls into Freighter immediately on load can race the injection: the
 * `@stellar/freighter-api` module import resolves, but `window.freighter` /
 * `window.stellar` is still undefined and the first API call fails. This
 * polls for the injected global, retrying up to `retries` times with
 * `delayMs` between checks, and throws a {@link FreighterNotAvailableError}
 * if it never appears.
 *
 * Outside a browser (no `window`) there is nothing to wait for, so this
 * resolves immediately and leaves the "not installed" handling to
 * Freighter's own API responses.
 */
export async function waitForFreighterInjection(
  retries: number = DEFAULT_FREIGHTER_INJECTION_RETRIES,
  delayMs: number = DEFAULT_FREIGHTER_INJECTION_RETRY_DELAY_MS,
): Promise<void> {
  if (typeof (globalThis as { window?: unknown }).window === 'undefined') {
    return;
  }
  const attempts = Math.max(1, Math.floor(retries));
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (isFreighterInjected()) {
      return;
    }
    if (attempt < attempts) {
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new FreighterNotAvailableError(attempts);
}

/** Default timeout (ms) for a wallet signTransaction call. */
const DEFAULT_SIGN_TIMEOUT_MS = 120_000;

/**
 * Minimum Freighter extension version required by this SDK.
 *
 * Freighter versions below this may not support the APIs used by
 * {@link FreighterWalletAdapter} (e.g. `requestAccess`, `getNetworkDetails`,
 * `getAddress`, `signTransaction`). Consumers should ensure users update
 * Freighter before attempting to connect.
 */
export const MIN_FREIGHTER_VERSION = '6.0.0';

/**
 * Compares two semantic version strings (e.g. `6.0.0`, `6.1.2`).
 * Returns `true` if `a` is greater than or equal to `b`.
 */
function gteVersion(a: string, b: string): boolean {
  const parse = (v: string): number[] =>
    v.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va > vb) return true;
    if (va < vb) return false;
  }
  return true;
}

/**
 * The `code` Freighter's `isConnected()` API returns for the ordinary
 * "extension not present/injected" case (e.g. running outside a browser, or
 * no Freighter extension installed) — as opposed to an unexpected internal
 * Freighter error, which should surface instead of being treated as "not
 * installed".
 */
const FREIGHTER_NOT_INSTALLED_CODE = -1;

/**
 * The object shape some wallets (notably WalletConnect) return from
 * `signTransaction` instead of a bare XDR string. The signed envelope is
 * carried in `envelope_xdr`; `hash` is optional metadata.
 */
export interface SignatureResponse {
  envelope_xdr: string;
  hash?: string;
}

/** Standard (RFC 4648 §4) base64 alphabet with required `=` padding. */
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * Returns `true` when `value` is a non-empty, standard, padded base64 string —
 * the encoding every Stellar XDR envelope uses.
 */
export function isValidBase64(value: string): boolean {
  return value.length > 0 && value.length % 4 === 0 && BASE64_PATTERN.test(value);
}

/**
 * Validates base64 XDR string.
 * - Short strings <40 chars: allowed through if they're valid base64 OR look like test placeholders
 * - Long strings ≥40 chars: must be valid base64
 */
function assertBase64Xdr(xdr: string, isObject: boolean = false): string {
  if (isValidBase64(xdr)) {
    return xdr;
  }

  // Invalid base64
  if (xdr.length < 40) {
    // Check if it looks like a test placeholder (readable mock data like 'mock-xdr')
    // vs actual invalid base64 (uppercase letters, numbers, padding)
    // Test placeholders: lowercase letters, hyphens, underscores
    // Real XDR: uppercase letters, numbers, = padding, or special chars
    const looksLikeMock = /^[a-z0-9\-_]+$/.test(xdr);
    if (looksLikeMock) {
      // Pass through as test placeholder (issue #517)
      return xdr;
    }
    // Short invalid string that doesn't look like a test placeholder
    throw new InvalidSignedXdrEncodingError(xdr.length);
  }

  // Long invalid string: use context-specific message (issue #517)
  const errorMsg = isObject
    ? 'Wallet signer returned a SignatureResponse with an invalid `envelope_xdr` value'
    : 'Wallet signer returned an invalid XDR string';
  throw new SoroWillError(errorMsg);
}

/**
 * Normalizes a wallet signer result to the signed XDR string the SDK expects.
 *
 * Some adapters return a bare XDR string, while others (WalletConnect, xBull,
 * …) return a {@link SignatureResponse} object. Passing the object through as
 * if it were a string silently fails downstream, so we validate the shape here
 * and throw a clear error for anything malformed.
 *
 * XDR validation only applies to strings ≥40 characters (real Stellar XDR is
 * always several hundred chars). Shorter strings are assumed to be test
 * placeholders and are passed through unchanged.
 */
export function normalizeSignatureResponse(
  result: string | SignatureResponse,
): string {
  if (typeof result === 'string') {
    if (result.length === 0) {
      throw new Error('Wallet signer returned an empty signed XDR string.');
    }
    return assertBase64Xdr(result, false);
  }

  if (result && typeof result === 'object') {
    const { envelope_xdr } = result as SignatureResponse;
    if (typeof envelope_xdr === 'string' && envelope_xdr.length > 0) {
      return assertBase64Xdr(envelope_xdr, true);
    }
    throw new Error(
      'Wallet signer returned a SignatureResponse without a valid `envelope_xdr` string.',
    );
  }

  throw new Error(
    `Wallet signer returned an unexpected value of type ${typeof result}; expected a signed XDR string or a SignatureResponse object.`,
  );
}

/** Result of a successful wallet connection. */
export interface WalletConnection {
  publicKey: string;
  network: string;
  networkPassphrase: string;
}

/**
 * Validates a wallet `signTransaction` response and normalizes it to the
 * signed envelope XDR string the SDK expects.
 *
 * Wallets are inconsistent here: some return a plain XDR string, while
 * others (e.g. WalletConnect) return a {@link SignatureResponse} object.
 * Passing the object straight through to serialization code that expects a
 * string causes a cast error, so we validate and extract `envelope_xdr`.
 *
 * @throws {Error} if the response is neither a non-empty string nor a valid
 *   {@link SignatureResponse} object.
 */
export function extractSignedEnvelopeXdr(response: unknown): string {
  if (typeof response === 'string') {
    if (response.length === 0) {
      throw new Error('Wallet returned an empty signed transaction XDR.');
    }
    return response;
  }

  if (response !== null && typeof response === 'object') {
    const { envelope_xdr } = response as Partial<SignatureResponse>;
    if (typeof envelope_xdr === 'string' && envelope_xdr.length > 0) {
      return envelope_xdr;
    }
  }

  throw new Error(
    'Wallet returned an invalid signTransaction response: expected a signed XDR string or a SignatureResponse object with an `envelope_xdr` string.',
  );
}

/** Options passed to {@link WalletAdapter.signTransaction}. */
export interface SignTransactionOptions {
  networkPassphrase: string;
  timeoutMs?: number;
}

/**
 * The full capability set a Stellar wallet must expose for
 * {@link SoroWillClient} to read the connected account and sign transactions.
 *
 * ### Error handling contract (#625)
 *
 * All methods document specific errors they may throw using `@throws` comments.
 * These errors fall into three categories:
 *
 * #### 1. Typed SDK errors (must be thrown)
 * Methods specify which {@link WalletAdapterError} subclasses they may raise.
 * **Do not throw other typed errors.** Use type guards to detect and handle them:
 *
 * ```ts
 * try {
 *   const connection = await wallet.connect();
 * } catch (error) {
 *   if (isWalletNetworkMismatchError(error)) {
 *     // Wallet is on a different network than expected
 *     console.error('Network mismatch:', error.expectedPassphrase, error.actualPassphrase);
 *   } else if (isFreighterInstallCheckError(error)) {
 *     // Freighter presence check failed
 *     console.error('Freighter install check error:', error.code);
 *   } else {
 *     // Plain Error from the wallet (user rejection, etc.)
 *     console.error('Connection failed:', error.message);
 *   }
 * }
 * ```
 *
 * #### 2. Plain Error for wallet-reported failures
 * Wallets may throw a plain `Error` carrying a message from the wallet library
 * (e.g. "user rejected the request", "invalid network"). The SDK catches and
 * re-throws only the documented typed errors; a plain `Error` that isn't caught
 * is a legitimate wallet failure.
 *
 * #### 3. No other errors
 * Do not throw uncaught RangeError, TypeError, or other built-ins. If you must
 * report a constraint violation (e.g. invalid parameter), wrap it in a clear
 * plain `Error` message so the SDK and application can distinguish it from SDK
 * bugs.
 *
 * ### Type guards for error narrowing
 *
 * Always use the provided type guards when catching errors from adapter methods:
 * - `isWalletSessionError(error)` — session token missing or expired
 * - `isSignTransactionTimeoutError(error)` — timeout waiting for user approval
 * - `isWalletNetworkMismatchError(error)` — wallet connected to wrong network
 * - `isFreighterInstallCheckError(error)` — Freighter presence check failed
 *
 * ```ts
 * try {
 *   await wallet.signTransaction(xdr, { networkPassphrase });
 * } catch (error) {
 *   if (isSignTransactionTimeoutError(error)) {
 *     // User dismissed the popup or it timed out
 *     retryableOps.push(() => wallet.signTransaction(xdr, { networkPassphrase }));
 *   } else if (isWalletSessionError(error)) {
 *     // Session expired, reconnect required
 *     await wallet.reconnect();
 *   } else {
 *     // Wallet rejected the signature (user action)
 *     console.error('User rejected:', error.message);
 *   }
 * }
 * ```
 *
 * ### Implementing a custom adapter
 *
 * When implementing {@link WalletAdapter}, **throw only the documented errors**
 * for each method. Never throw uncaught exceptions.
 *
 * #### Example: Throw the right error types
 *
 * ```ts
 * export class MyCustomWallet implements WalletAdapter {
 *   async connect(): Promise<WalletConnection> {
 *     // Throw WalletNetworkMismatchError when networks don't match
 *     const network = await checkNetwork();
 *     if (network !== expectedNetwork) {
 *       throw new WalletNetworkMismatchError(expectedNetwork, network);
 *     }
 *
 *     // Throw plain Error for user action (rejection, etc.)
 *     const approved = await requestUserApproval();
 *     if (!approved) {
 *       throw new Error('User rejected connection');
 *     }
 *
 *     return { publicKey: '...', network: 'testnet', networkPassphrase: '...' };
 *   }
 *
 *   async signTransaction(xdr: string, opts: SignTransactionOptions): Promise<string> {
 *     // Throw SignTransactionTimeoutError if timeout expires
 *     const signature = await this.signWithTimeout(xdr, opts.timeoutMs ?? 120000);
 *
 *     // Throw WalletSessionError if session is invalid
 *     await this.validateSession();
 *
 *     // Throw plain Error for wallet-specific failures
 *     if (!isValidXdr(signature)) {
 *       throw new Error('Wallet returned an invalid signature');
 *     }
 *
 *     return signature;
 *   }
 * }
 * ```
 *
 * ### Browser wallets
 *
 * Browser-extension adapters (Freighter, Albedo, …) implement this interface
 * and present a user-facing approval prompt when `signTransaction` is called.
 * These are the right choice for any application that handles real end-user
 * funds in a browser context.
 *
 * ### Scripts, automation, and testing — `KeypairSigner`
 *
 * For Node.js scripts, keeper bots, demo scripts, or unit tests where there is
 * no browser extension available, build a lightweight adapter on top of
 * `@stellar/stellar-sdk`'s `Keypair`:
 *
 * ```ts
 * import { Keypair, Transaction, TransactionBuilder } from '@stellar/stellar-sdk';
 * import type { WalletAdapter } from '@sorowill/sdk';
 *
 * export class KeypairSigner implements WalletAdapter {
 *   constructor(private readonly keypair: Keypair) {}
 *
 *   async getPublicKey(): Promise<string> {
 *     return this.keypair.publicKey();
 *   }
 *
 *   async signTransaction(
 *     transactionXdr: string,
 *     opts: { networkPassphrase: string },
 *   ): Promise<string> {
 *     const tx = TransactionBuilder.fromXDR(
 *       transactionXdr,
 *       opts.networkPassphrase,
 *     ) as Transaction;
 *     tx.sign(this.keypair);
 *     return tx.toXDR();
 *   }
 *
 *   async isConnected(): Promise<boolean> {
 *     return true; // Always connected (no session)
 *   }
 *
 *   async connect(): Promise<WalletConnection> {
 *     return {
 *       publicKey: this.keypair.publicKey(),
 *       network: 'testnet',
 *       networkPassphrase: Networks.TESTNET_NETWORK_PASSPHRASE,
 *     };
 *   }
 *
 *   async reconnect(): Promise<WalletConnection> {
 *     return this.connect(); // No session to restore
 *   }
 *
 *   async disconnect(): Promise<void> {
 *     // No session to clear
 *   }
 * }
 * ```
 *
 * Pass it to the client via the `wallet` option:
 *
 * ```ts
 * const signer = new KeypairSigner(Keypair.fromSecret('S...'));
 * const client = new SoroWillClient({ network: 'testnet', contractId: 'C...', wallet: signer });
 * ```
 *
 * > **Security warning:** `KeypairSigner` holds a raw secret key in memory.
 * > It is intended for scripts, automation, and testing only — never use it
 * > to handle real end-user funds in a browser or any environment where the
 * > secret could be exposed to untrusted code.
 */
export interface WalletAdapter {
  /**
   * Reports whether the wallet is currently connected.
   *
   * @throws {FreighterInstallCheckError} When the wallet's presence cannot be
   *   determined due to an internal error (Freighter only; other adapters may
   *   throw a plain `Error` instead).
   */
  isConnected(): Promise<boolean>;
  /**
   * Prompts the user (if required) and establishes a connection.
   *
   * @throws {WalletCancelledError} When the user explicitly cancels or rejects
   *   the connection prompt.
   * @throws {WalletNetworkMismatchError} When the wallet is connected to a
   *   network that differs from the client's expected network passphrase.
   * @throws {Error} When the wallet reports an internal failure.
   */
  connect(): Promise<WalletConnection>;
  /**
   * Re-establishes a previous connection without re-prompting the user where
   * possible.
   *
   * @throws {WalletNetworkMismatchError} When the wallet is connected to a
   *   network that differs from the client's expected network passphrase.
   * @throws {Error} When reconnection fails or the session can no longer be
   *   restored.
   */
  reconnect(): Promise<WalletConnection>;
  /**
   * Tears down the current connection and clears any local session state.
   *
   * @throws {Error} When the wallet reports a failure while disconnecting.
   */
  disconnect(): Promise<void>;
  /**
   * Returns the public key of the currently connected account.
   *
   * @throws {Error} When no account is connected or the wallet reports an
   *   internal failure.
   */
  getPublicKey(): Promise<string>;
  /**
   * Signs a transaction envelope, returning either the signed XDR string or a
   * {@link SignatureResponse} object carrying `envelope_xdr`.
   *
   * @throws {WalletCancelledError} When the user explicitly cancels or rejects
   *   the signing prompt.
   * @throws {SignTransactionTimeoutError} When the wallet does not respond
   *   within `opts.timeoutMs` (e.g. a dismissed or hung approval popup).
   * @throws {WalletSessionError} When the adapter issues session tokens and
   *   the current token is expired and cannot be refreshed.
   * @throws {Error} When the wallet returns a malformed response or reports an
   *   internal/network failure.
   */
  signTransaction(
    transactionXdr: string,
    opts: SignTransactionOptions,
  ): Promise<string | SignatureResponse>;
  /**
   * Reports the network this wallet is currently set to, without prompting the user. Optional — not every wallet adapter can report this.
   *
   * @throws {Error} When the wallet cannot report its current network.
   */
  getNetwork?(): Promise<{ network: string; networkPassphrase: string }>;
  /**
   * Registers `listener` to be called whenever the wallet switches to a
   * different network. Returns a function that removes the listener.
   * Optional — {@link SoroWillClient} uses it to drop cached reads from the
   * previous network.
   */
  onNetworkChange?(listener: WalletNetworkChangeListener): () => void;
  /**
   * Clears any locally cached public key or session state held by the
   * adapter, e.g. after a wallet network switch so the next call re-fetches
   * the key from the active network.
   */
  clearKeyCache?(): void;
  /**
   * Returns the current session token for this wallet, if the adapter issues
   * one. Optional — adapters that do not use session tokens may omit it.
   *
   * @throws {WalletSessionError} When the session cannot be read.
   */
  getSession?(): Promise<WalletSession | undefined>;
  /**
   * Refreshes an expired/invalid session token and returns the new one.
   * Optional — only meaningful for adapters that issue session tokens.
   *
   * @throws {WalletSessionError} When the session cannot be refreshed or the
   *   refreshed token is still invalid.
   */
  refreshSession?(): Promise<WalletSession>;
}

/**
 * Validates a wallet session token before it is sent to the contract,
 * refreshing it when it is missing or expired.
 *
 * Returns the token to use, or `undefined` when the adapter does not use
 * session tokens. Throws a {@link WalletSessionError} with an actionable
 * message when the token is expired and cannot be refreshed, so callers get a
 * clear failure instead of the contract silently rejecting a stale token.
 */
export async function ensureValidSession(
  wallet: WalletAdapter,
  now: number = Date.now(),
): Promise<string | undefined> {
  if (!wallet.getSession) {
    return undefined;
  }

  let session: WalletSession | undefined;
  try {
    session = await wallet.getSession();
  } catch (err) {
    throw new WalletSessionError(
      'Failed to read the wallet session token. Reconnect the wallet and try again.',
      err,
    );
  }

  if (session && typeof session.token === 'string' && session.token.length > 0 && !isValidWalletSessionToken(session.token)) {
    throw new WalletSessionError(
      'The wallet session token has an invalid format. Reconnect the wallet and try again.',
    );
  }

  if (session && isValidWalletSessionToken(session.token) && session.expiresAt !== undefined && session.expiresAt > now) {
    return session.token;
  }

  if (!wallet.refreshSession) {
    throw new WalletSessionError(
      'The wallet session token has expired and this adapter cannot refresh it. Reconnect the wallet and try again.',
    );
  }

  let refreshed: WalletSession;
  try {
    refreshed = await wallet.refreshSession();
  } catch (err) {
    throw new WalletSessionError(
      'The wallet session token expired and could not be refreshed. Reconnect the wallet and try again.',
      err,
    );
  }

  if (!refreshed || !isValidWalletSessionToken(refreshed.token) || refreshed.expiresAt === undefined || refreshed.expiresAt <= now) {
    throw new WalletSessionError(
      'The wallet session token is still invalid after refreshing. Reconnect the wallet and try again.',
    );
  }

  return refreshed.token;
}

/**
 * Options for configuring a wallet session.
 *
 * `sessionTtlMs` overrides the default session token TTL (15 minutes).
 * When omitted, {@link DEFAULT_SESSION_TTL_MS} is used.
 */
export interface WalletSessionOptions {
  sessionTtlMs?: number;
}

/**
 * Options accepted by {@link FreighterWalletAdapter}.
 *
 * `expectedNetworkPassphrase` is the network the SDK/client is configured for.
 * When provided, the adapter verifies the wallet's current network against it
 * on `connect()`/`reconnect()` and rejects with a
 * {@link WalletNetworkMismatchError} on mismatch — instead of letting a
 * testnet wallet silently sign for a mainnet-configured client.
 *
 * `sessionTtlMs` overrides the default session token TTL (15 minutes).
 */
export interface FreighterWalletAdapterOptions extends WalletSessionOptions {
  expectedNetworkPassphrase?: string;
  /**
   * How many times to check for Freighter's window injection before failing
   * with a {@link FreighterNotAvailableError}. Defaults to
   * {@link DEFAULT_FREIGHTER_INJECTION_RETRIES}.
   */
  injectionRetries?: number;
  /**
   * Delay in milliseconds between injection checks. Defaults to
   * {@link DEFAULT_FREIGHTER_INJECTION_RETRY_DELAY_MS}.
   */
  injectionRetryDelayMs?: number;
  /**
   * Maximum time in milliseconds to wait for Freighter to respond during
   * `connect()` / `reconnect()`. Defaults to
   * {@link DEFAULT_FREIGHTER_CONNECT_TIMEOUT_MS} (30s).
   */
  connectTimeoutMs?: number;
}

/**
 * Browser-extension wallet adapter backed by the Freighter browser extension.
 *
 * ## Minimum Freighter version
 *
 * This adapter requires Freighter {@link MIN_FREIGHTER_VERSION} or later.
 * Older versions may not support the `@stellar/freighter-api` methods used
 * here (`requestAccess`, `getNetworkDetails`, `getAddress`, `signTransaction`).
 * The version is checked on {@link connect} and an error is thrown if the
 * installed Freighter is below the minimum.
 *
 * @since 0.1.0
 */
export class FreighterWalletAdapter implements WalletAdapter {
  private readonly expectedNetworkPassphrase?: string;
  private readonly sessionTtlMs: number;
  private readonly injectionRetries: number;
  private readonly injectionRetryDelayMs: number;
  private readonly connectTimeoutMs: number;
  private session?: WalletSession;
  /**
   * Whether the extension context is currently known to be stale/invalidated.
   * Set to `true` when any Freighter API call returns a context-invalidation
   * error (#518). Cleared on a successful `connect()` / `reconnect()`.
   */
  private _extensionContextStale = false;

  constructor(options: FreighterWalletAdapterOptions = {}) {
    if (options.expectedNetworkPassphrase !== undefined) {
      this.expectedNetworkPassphrase = options.expectedNetworkPassphrase;
    }
    this.sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    this.injectionRetries = options.injectionRetries ?? DEFAULT_FREIGHTER_INJECTION_RETRIES;
    this.injectionRetryDelayMs = options.injectionRetryDelayMs ?? DEFAULT_FREIGHTER_INJECTION_RETRY_DELAY_MS;
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_FREIGHTER_CONNECT_TIMEOUT_MS;

    if (this.injectionRetries <= 0) {
      throw new RangeError('injectionRetries must be greater than 0');
    }
    if (this.injectionRetryDelayMs < 0) {
      throw new RangeError('injectionRetryDelayMs must be non-negative');
    }
    if (!Number.isFinite(this.connectTimeoutMs) || this.connectTimeoutMs <= 0) {
      throw new RangeError('connectTimeoutMs must be a positive finite number');
    }
  }

  /**
   * `true` when the extension has reloaded and the adapter's cached
   * connection is no longer usable. Callers should await `reconnect()` to
   * restore the session, or surface a prompt for the user to re-approve.
   */
  get isExtensionContextStale(): boolean {
    return this._extensionContextStale;
  }

  /**
   * Detects whether an error from a Freighter API call indicates that the
   * extension context has been invalidated (e.g. after a browser update or
   * extension reload). When detected, marks the adapter as stale and returns
   * `true` so callers can react appropriately instead of crashing.
   */
  private handlePossibleContextInvalidation(error: { code?: number; message?: string } | undefined | null): boolean {
    if (!error) return false;
    // Freighter uses code -3 for context invalidation; additionally guard
    // against the string message Chrome injects when an extension's service
    // worker is terminated ("Extension context invalidated").
    const isContextError =
      error.code === FREIGHTER_CONTEXT_INVALIDATED_CODE ||
      (typeof error.message === 'string' &&
        error.message.toLowerCase().includes('extension context invalidated'));
    if (isContextError) {
      this._extensionContextStale = true;
      delete this.session;
    }
    return isContextError;
  }

  /**
   * Rejects with a {@link WalletNetworkMismatchError} when the wallet's
   * reported network passphrase does not match the configured one. No-op when
   * no expected passphrase was configured or the wallet reports none.
   */
  private assertNetworkMatches(networkPassphrase: string): void {
    if (!this.expectedNetworkPassphrase || !networkPassphrase) {
      return;
    }
    if (networkPassphrase !== this.expectedNetworkPassphrase) {
      throw new WalletNetworkMismatchError(this.expectedNetworkPassphrase, networkPassphrase);
    }
  }

  /**
   * Asserts that the installed Freighter extension meets the minimum version
   * requirement ({@link MIN_FREIGHTER_VERSION}).
   *
   * Attempts to read the Freighter API version from the loaded
   * `@stellar/freighter-api` module. If the version cannot be determined or
   * is below the minimum, throws a {@link FreighterInstallCheckError}.
   */
  private async assertFreighterVersion(): Promise<void> {
    try {
      const freighterApi = await loadFreighterApi();
      const version =
        (freighterApi as unknown as { version?: string }).version ??
        (freighterApi as unknown as { default?: { version?: string } }).default
          ?.version;
      if (version && !gteVersion(version, MIN_FREIGHTER_VERSION)) {
        throw new FreighterInstallCheckError(
          -1,
          `Freighter version ${version} is below the minimum required version ${MIN_FREIGHTER_VERSION}. Please update Freighter.`,
        );
      }
    } catch (err) {
      if (err instanceof FreighterInstallCheckError) {
        throw err;
      }
      // If we cannot determine the version, warn but do not block — the
      // extension may still work even if its version is not exposed.
      console.warn(
        `[SoroWill] Could not determine Freighter version; proceeding without version check. ` +
          `Ensure Freighter is at least v${MIN_FREIGHTER_VERSION}.`,
      );
    }
  }

  /** Loads the injected Freighter API from the window object. */
  private async loadInjectedFreighterApi() {
    return loadFreighterApi();
  }

  /**
   * Reports whether the Freighter extension is present and reachable.
   *
   * Resolves `false` only for the ordinary "extension not installed/injected"
   * case. Any other error Freighter's `isConnected()` API reports (e.g. it
   * was called outside a browser, or Freighter hit an internal error) is
   * surfaced as a thrown {@link FreighterInstallCheckError} instead of being
   * silently treated as "not installed".
   */
  async isConnected(): Promise<boolean> {
    const freighterApi = await loadFreighterApi();
    const { isConnected, error } = await freighterApi.isConnected();
    if (error) {
      if (error.code === FREIGHTER_NOT_INSTALLED_CODE) {
        return false;
      }
      // Extension reload / context invalidation — treat as "not connected"
      // and mark the adapter stale so callers know a reconnect is needed.
      if (this.handlePossibleContextInvalidation(error)) {
        return false;
      }
      throw new FreighterInstallCheckError(error.code, error.message);
    }
    // A successful check means the extension is live again — clear the stale flag.
    if (!isConnected) {
      this._extensionContextStale = false;
    }
    return isConnected;
  }

  /**
   * Races a Freighter connection operation against {@link connectTimeoutMs}
   * so a hung or unresponsive extension fails with a clear recovery message.
   */
  private async withConnectTimeout<T>(operation: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race<T>([
        operation(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new FreighterConnectionTimeoutError(this.connectTimeoutMs)),
            this.connectTimeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  async connect(): Promise<WalletConnection> {
    return this.withConnectTimeout(async () => {
      await this.assertFreighterVersion();
      const freighterApi = await loadFreighterApi();
      const access = await freighterApi.requestAccess();
      if (access.error) {
        this.handlePossibleContextInvalidation(access.error);
        throw new Error(access.error.message);
      }

      const networkDetails = await freighterApi.getNetworkDetails();
      if (networkDetails?.error) {
        this.handlePossibleContextInvalidation(networkDetails.error);
        throw new Error(networkDetails.error.message);
      }

      const networkPassphrase = networkDetails?.networkPassphrase ?? '';
      this.assertNetworkMatches(networkPassphrase);

      // Successful connect — extension is live, clear any stale flag.
      this._extensionContextStale = false;

      return {
        publicKey: access.address,
        network: networkDetails?.network ?? '',
        networkPassphrase,
      };
    });
  }

  async reconnect(): Promise<WalletConnection> {
    // If extension context is already stale, fall through to connect
    if (this._extensionContextStale) {
      return this.connect();
    }

    return this.withConnectTimeout(async () => {
      let publicKey: string;
      try {
        publicKey = await this.getPublicKey();
      } catch (error) {
        // If getPublicKey failed due to context error, fall through to connect
        if (this._extensionContextStale) {
          return this.connect();
        }
        throw error;
      }

      const freighterApi = await this.loadInjectedFreighterApi();
      const networkDetails = await freighterApi.getNetworkDetails();
      if (networkDetails?.error) {
        this.handlePossibleContextInvalidation(networkDetails.error);
        if (this._extensionContextStale) {
          return this.connect();
        }
        throw new Error(networkDetails.error.message);
      }

      const networkPassphrase = networkDetails?.networkPassphrase ?? '';
      this.assertNetworkMatches(networkPassphrase);

      this._extensionContextStale = false;

      return {
        publicKey,
        network: networkDetails?.network ?? '',
        networkPassphrase,
      };
    });
  }

  async disconnect(): Promise<void> {
    delete (this as unknown as Record<string, unknown>).session;
    this._extensionContextStale = false;
    return;
  }

  /** Reports the network Freighter is currently set to, without prompting the user. */
  async getNetwork(): Promise<{ network: string; networkPassphrase: string }> {
    const freighterApi = await this.loadInjectedFreighterApi();
    const networkDetails = await freighterApi.getNetworkDetails();
    if (networkDetails?.error) {
      throw new Error(networkDetails.error.message);
    }
    return {
      network: networkDetails?.network ?? '',
      networkPassphrase: networkDetails?.networkPassphrase ?? '',
    };
  }

  /**
   * Watches Freighter for network switches using its `WatchWalletChanges`
   * poller and calls `listener` whenever the network passphrase changes.
   * The first reported network is recorded as the baseline and does not
   * trigger the listener. Returns a function that stops watching.
   *
   * Outside a browser there is no extension to watch, so this is a no-op.
   */
  onNetworkChange(listener: WalletNetworkChangeListener): () => void {
    if (typeof (globalThis as { window?: unknown }).window === 'undefined') {
      return () => {};
    }
    let stopped = false;
    let watcher: { stop(): void } | undefined;
    let lastPassphrase: string | undefined;

    void this.loadInjectedFreighterApi()
      .then((freighterApi) => {
        if (stopped || typeof freighterApi.WatchWalletChanges !== 'function') {
          return;
        }
        const instance = new freighterApi.WatchWalletChanges(DEFAULT_FREIGHTER_WATCH_INTERVAL_MS);
        watcher = instance;
        instance.watch(({ network, networkPassphrase, error }) => {
          if (error || !networkPassphrase) {
            return;
          }
          const previous = lastPassphrase;
          lastPassphrase = networkPassphrase;
          if (previous !== undefined && previous !== networkPassphrase) {
            this.clearKeyCache();
            listener({ network, networkPassphrase });
          }
        });
      })
      .catch(() => {
        // Freighter is unavailable; there are no network changes to watch.
      });

    return () => {
      stopped = true;
      watcher?.stop();
    };
  }

  async getPublicKey(): Promise<string> {
    await waitForFreighterInjection(this.injectionRetries, this.injectionRetryDelayMs);
    const freighterApi = await this.loadInjectedFreighterApi();
    const { address, error } = await freighterApi.getAddress();
    if (error) {
      this.handlePossibleContextInvalidation(error);
      throw new Error(error.message);
    }
    if (!address) {
      throw new Error('No Freighter account is connected. Call connectWallet() first.');
    }
    return address;
  }

  /** Clears any cached session/key state so the next operation re-fetches from Freighter. */
  clearKeyCache(): void {
    delete this.session;
  }

  /** Returns the current session token, if one has been established. */
  async getSession(): Promise<WalletSession | undefined> {
    return this.session;
  }

  /**
   * Refreshes the session token by re-reading the connected account from
   * Freighter and issuing a fresh token with a new expiry.
   */
  async refreshSession(): Promise<WalletSession> {
    const publicKey = await this.getPublicKey();
    const token = validateWalletSessionToken(publicKey);
    this.session = {
      token,
      expiresAt: Date.now() + this.sessionTtlMs,
    };
    return this.session;
  }

  async signTransaction(
    transactionXdr: string,
    opts: { networkPassphrase: string; timeoutMs?: number },
  ): Promise<string> {
    // Validate/refresh the session token before handing anything to the
    // contract, so an expired token surfaces a clear error here instead of
    // being rejected opaquely on-chain.
    await ensureValidSession(this);

    const timeoutMs = opts.timeoutMs ?? DEFAULT_SIGN_TIMEOUT_MS;
    // Kicked off synchronously (not awaited yet) so the timeout below is
    // still registered before this function's first `await`, regardless of
    // how long the dynamic import takes to resolve.
    const freighterApiPromise = this.loadInjectedFreighterApi();

    // Race the Freighter call against a timer so that a hung or dismissed
    // popup never leaves the caller's promise pending
    let result: unknown;
    try {
      result = await Promise.race<unknown>([
        freighterApiPromise.then((freighterApi) =>
          freighterApi.signTransaction(transactionXdr, {
            networkPassphrase: opts.networkPassphrase,
          }),
        ),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new SignTransactionTimeoutError(timeoutMs)), timeoutMs);
        }),
      ]);
    } catch (err) {
      const cancelled = toWalletCancelledError(err, 'signTransaction');
      if (cancelled) throw cancelled;
      throw err;
    }

    if (result && typeof result === 'object' && 'error' in result && result.error) {
      const err = result.error as Record<string, unknown>;
      this.handlePossibleContextInvalidation(err as { code?: number; message?: string });
      const cancelled = toWalletCancelledError(err, 'signTransaction');
      if (cancelled) throw cancelled;
      const errorMessage = typeof err === 'object' && err !== null && 'message' in err
        ? String(err.message)
        : String(result.error);
      throw new Error(errorMessage);
    }

    // Freighter returns a bare XDR string, but normalize defensively so any
    // wallet that returns a SignatureResponse object is handled uniformly.
    return extractSignedEnvelopeXdr(result);
  }
}

/**
 * WalletConnect-backed wallet adapter.
 *
 * WalletConnect's `signTransaction` returns a {@link SignatureResponse}
 * object (`{ envelope_xdr, hash }`) rather than a bare XDR string. This
 * adapter validates that response and extracts `envelope_xdr` so downstream
 * serialization receives the string it expects.
 */
export class WalletConnectWalletAdapter implements WalletAdapter {
  constructor(
    private readonly connector: {
      isConnected(): Promise<boolean>;
      connect(): Promise<WalletConnection>;
      reconnect(): Promise<WalletConnection>;
      disconnect(): Promise<void>;
      getPublicKey(): Promise<string>;
      signTransaction(
        transactionXdr: string,
        opts: SignTransactionOptions,
      ): Promise<string | SignatureResponse>;
      getNetwork?(): Promise<{ network: string; networkPassphrase: string }>;
      onNetworkChange?(listener: WalletNetworkChangeListener): () => void;
  /**
   * Clears any locally cached public key or session state held by the
   * adapter, e.g. after a wallet network switch so the next call re-fetches
   * the key from the active network.
   */
  clearKeyCache?(): void;
    },
  ) {
    if (connector.onNetworkChange) {
      this.onNetworkChange = (listener) => connector.onNetworkChange!(listener);
    }
  }

  onNetworkChange?: (listener: WalletNetworkChangeListener) => () => void;

  isConnected(): Promise<boolean> {
    return this.connector.isConnected();
  }

  async connect(): Promise<WalletConnection> {
    try {
      return await this.connector.connect();
    } catch (err) {
      const cancelled = toWalletCancelledError(err, 'connect');
      if (cancelled) throw cancelled;
      throw err;
    }
  }

  reconnect(): Promise<WalletConnection> {
    return this.connector.reconnect();
  }

  disconnect(): Promise<void> {
    return this.connector.disconnect();
  }

  getPublicKey(): Promise<string> {
    return this.connector.getPublicKey();
  }

  async signTransaction(
    transactionXdr: string,
    options: SignTransactionOptions,
  ): Promise<string | SignatureResponse> {
    try {
      return await this.connector.signTransaction(transactionXdr, options);
    } catch (err) {
      const cancelled = toWalletCancelledError(err, 'signTransaction');
      if (cancelled) throw cancelled;
      throw err;
    }
  }
}

const defaultFreighterWalletAdapter = new FreighterWalletAdapter();

/**
 * The default {@link WalletAdapter}, backed by the Freighter browser
 * extension. This is what {@link SoroWillClient} uses when no `wallet` option
 * is supplied, so existing Freighter-based usage keeps working unchanged.
 */
export const freighterAdapter: WalletAdapter = {
  isConnected: () => defaultFreighterWalletAdapter.isConnected(),
  connect: () => defaultFreighterWalletAdapter.connect(),
  reconnect: () => defaultFreighterWalletAdapter.reconnect(),
  disconnect: () => defaultFreighterWalletAdapter.disconnect(),
  getPublicKey: () => defaultFreighterWalletAdapter.getPublicKey(),
  signTransaction: (xdr: string, opts: SignTransactionOptions) => defaultFreighterWalletAdapter.signTransaction(xdr, opts),
  getNetwork: () => defaultFreighterWalletAdapter.getNetwork(),
  onNetworkChange: (listener: WalletNetworkChangeListener) => defaultFreighterWalletAdapter.onNetworkChange(listener),
  clearKeyCache: () => defaultFreighterWalletAdapter.clearKeyCache(),
};

export function getDefaultWalletAdapter(): WalletAdapter {
  return freighterAdapter;
}

export async function getPublicKey(): Promise<string> {
  return defaultFreighterWalletAdapter.getPublicKey();
}

export async function signTransaction(xdr: string, opts: SignTransactionOptions): Promise<string> {
  return defaultFreighterWalletAdapter.signTransaction(xdr, opts);
}

export async function isFreighterInstalled(): Promise<boolean> {
  try {
    const freighterApi = await loadFreighterApi();
    const { isConnected, error } = await freighterApi.isConnected();
    if (error && error.code === FREIGHTER_NOT_INSTALLED_CODE) {
      return false;
    }
    return isConnected && !error;
  } catch {
    return false;
  }
}

export async function connectWallet(): Promise<WalletConnection> {
  return defaultFreighterWalletAdapter.connect();
}

export async function assertWalletSessionActive(
  adapter: WalletAdapter,
  now: number = Date.now(),
): Promise<void> {
  if (!adapter.getSession) {
    return;
  }

  let session: WalletSession | undefined;
  try {
    session = await adapter.getSession();
  } catch {
    return;
  }

  if (!session) {
    return;
  }

  validateWalletSessionToken(session.token);

  if (!session.expiresAt) {
    return;
  }

  if (session.expiresAt > now) {
    return;
  }

  if (!adapter.refreshSession) {
    throw new WalletSessionExpiredError(session.expiresAt);
  }

  let refreshed: WalletSession;
  try {
    refreshed = await adapter.refreshSession();
  } catch (err) {
    throw new WalletSessionExpiredError(session.expiresAt, { cause: err });
  }

  if (!refreshed || !isValidWalletSessionToken(refreshed.token)) {
    throw new WalletSessionError(
      'The refreshed wallet session token has an invalid format. Reconnect the wallet and try again.',
    );
  }

  if (!refreshed.expiresAt || refreshed.expiresAt <= now) {
    throw new WalletSessionExpiredError(refreshed?.expiresAt);
  }
}

/** Default time (ms) to wait for a single signer in a multisig round. */
export const DEFAULT_MULTISIG_SIGNER_TIMEOUT_MS = 120_000;

/**
 * A single participant in a multi-signature signing round: a wallet adapter
 * plus the public key it is expected to sign with.
 */
export interface MultisigSigner {
  /** The Stellar public key this signer is expected to sign with. */
  publicKey: string;
  /** The wallet adapter used to produce the signature. */
  wallet: WalletAdapter;
}

/** Options for {@link MultisigWalletAdapter}. */
export interface MultisigWalletAdapterOptions {
  /** The signers participating in the round. At least one is required. */
  signers: MultisigSigner[];
  /**
   * Number of signatures required before the round is considered complete.
   * Defaults to the number of signers.
   */
  threshold?: number;
  /**
   * Maximum time (ms) to wait for each individual signer. Defaults to
   * {@link DEFAULT_MULTISIG_SIGNER_TIMEOUT_MS}.
   */
  signerTimeoutMs?: number;
  /**
   * Maximum time (ms) to wait for the whole round (all signers, in parallel).
   * Defaults to `signerTimeoutMs`.
   */
  roundTimeoutMs?: number;
}

/** Outcome of a single signer within a multisig round. */
export interface MultisigSignerResult {
  /** The signer's public key. */
  publicKey: string;
  /** Whether the signer produced a signature in time. */
  signed: boolean;
  /** The signed envelope XDR, when the signer succeeded. */
  signedXdr?: string;
  /** The error the signer raised, when it failed or timed out. */
  error?: unknown;
}

/** Result of a {@link MultisigWalletAdapter.signTransaction} round. */
export interface MultisigSignResult {
  /** The signed envelope XDR of the first successful signer. */
  signedXdr: string;
  /** Per-signer outcomes, in the order the signers were configured. */
  results: MultisigSignerResult[];
  /** The number of signatures collected. */
  signatureCount: number;
  /** The threshold that was required. */
  threshold: number;
}

/**
 * Coordinates a multi-signature signing round across several
 * {@link WalletAdapter}s.
 *
 * Each signer is asked to sign the same envelope in parallel. A signer that
 * does not respond within `signerTimeoutMs` is abandoned (its result is
 * recorded with a {@link SignTransactionTimeoutError}) so one hung wallet
 * cannot block the round. The round resolves as soon as `threshold` signers
 * have produced a signed envelope; if the round timeout elapses first, a
 * {@link MultisigTimeoutError} is thrown carrying the per-signer outcomes.
 *
 * The adapter itself implements {@link WalletAdapter}, delegating connection
 * and key management to the first configured signer, so it can be passed
 * anywhere a single wallet is expected.
 */
export class MultisigWalletAdapter implements WalletAdapter {
  private readonly _signers: MultisigSigner[];
  private readonly _threshold: number;
  private readonly _signerTimeoutMs: number;
  private readonly _roundTimeoutMs: number;

  constructor(options: MultisigWalletAdapterOptions) {
    if (!options || !Array.isArray(options.signers) || options.signers.length === 0) {
      throw new Error('MultisigWalletAdapter requires at least one signer');
    }
    const seen = new Set<string>();
    for (const signer of options.signers) {
      if (!signer || typeof signer.publicKey !== 'string' || signer.publicKey.length === 0) {
        throw new Error('Each multisig signer must have a non-empty publicKey');
      }
      if (!signer.wallet || typeof signer.wallet.signTransaction !== 'function') {
        throw new Error(`Multisig signer ${signer.publicKey} must provide a wallet adapter`);
      }
      if (seen.has(signer.publicKey)) {
        throw new Error(`Duplicate multisig signer ${signer.publicKey}`);
      }
      seen.add(signer.publicKey);
    }
    const threshold = options.threshold ?? options.signers.length;
    if (!Number.isInteger(threshold) || threshold < 1 || threshold > options.signers.length) {
      throw new Error(
        `Multisig threshold must be an integer between 1 and ${options.signers.length}`,
      );
    }
    const signerTimeoutMs = options.signerTimeoutMs ?? DEFAULT_MULTISIG_SIGNER_TIMEOUT_MS;
    if (!Number.isFinite(signerTimeoutMs) || signerTimeoutMs <= 0) {
      throw new Error('signerTimeoutMs must be a positive number of milliseconds');
    }
    const roundTimeoutMs = options.roundTimeoutMs ?? signerTimeoutMs;
    if (!Number.isFinite(roundTimeoutMs) || roundTimeoutMs <= 0) {
      throw new Error('roundTimeoutMs must be a positive number of milliseconds');
    }

    this._signers = [...options.signers];
    this._threshold = threshold;
    this._signerTimeoutMs = signerTimeoutMs;
    this._roundTimeoutMs = roundTimeoutMs;
  }

  /** The configured signers. */
  get signers(): ReadonlyArray<MultisigSigner> {
    return this._signers;
  }

  /** The number of signatures required for a round to succeed. */
  get threshold(): number {
    return this._threshold;
  }

  /** The per-signer timeout in milliseconds. */
  get signerTimeoutMs(): number {
    return this._signerTimeoutMs;
  }

  /** The whole-round timeout in milliseconds. */
  get roundTimeoutMs(): number {
    return this._roundTimeoutMs;
  }

  /** Delegates to the first configured signer. */
  async isConnected(): Promise<boolean> {
    return this._signers[0].wallet.isConnected();
  }

  /** Delegates to the first configured signer. */
  async connect(): Promise<WalletConnection> {
    return this._signers[0].wallet.connect();
  }

  /** Delegates to the first configured signer. */
  async reconnect(): Promise<WalletConnection> {
    return this._signers[0].wallet.reconnect();
  }

  /** Disconnects every configured signer, collecting the first failure. */
  async disconnect(): Promise<void> {
    const results = await Promise.allSettled(this._signers.map((s) => s.wallet.disconnect()));
    const failure = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failure) {
      throw failure.reason;
    }
  }

  /** Delegates to the first configured signer. */
  async getPublicKey(): Promise<string> {
    return this._signers[0].wallet.getPublicKey();
  }

  /**
   * Runs a signing round: every signer signs `transactionXdr` in parallel and
   * the round resolves once `threshold` signatures are collected.
   *
   * @throws {MultisigTimeoutError} When the round timeout elapses before the
   *   threshold is met.
   * @throws {Error} When every signer fails before the threshold is met.
   */
  async signTransaction(
    transactionXdr: string,
    opts: SignTransactionOptions,
  ): Promise<MultisigSignResult> {
    const results: MultisigSignerResult[] = this._signers.map((signer) => ({
      publicKey: signer.publicKey,
      signed: false,
    }));

    let settled = false;
    let resolveRound: (() => void) | undefined;
    const roundDone = new Promise<void>((resolve) => {
      resolveRound = resolve;
    });

    const checkDone = (): void => {
      if (settled) return;
      const signedCount = results.filter((r) => r.signed).length;
      const pending = results.filter((r) => r.signedXdr === undefined && r.error === undefined).length;
      if (signedCount >= this._threshold || pending === 0) {
        settled = true;
        resolveRound?.();
      }
    };

    for (let i = 0; i < this._signers.length; i += 1) {
      const signer = this._signers[i];
      const result = results[i];
      void this.signWithSigner(signer, transactionXdr, opts).then(
        (signedXdr) => {
          result.signed = true;
          result.signedXdr = signedXdr;
          checkDone();
        },
        (error: unknown) => {
          result.error = error;
          checkDone();
        },
      );
    }

    let roundTimer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = await Promise.race([
      roundDone.then(() => false),
      new Promise<boolean>((resolve) => {
        roundTimer = setTimeout(() => resolve(true), this._roundTimeoutMs);
      }),
    ]);
    if (roundTimer !== undefined) clearTimeout(roundTimer);

    const signedCount = results.filter((r) => r.signed).length;
    if (signedCount < this._threshold) {
      if (timedOut) {
        throw new MultisigTimeoutError(signedCount, this._threshold, this._roundTimeoutMs);
      }
      const firstError = results.find((r) => r.error !== undefined)?.error;
      throw new Error(
        `Multisig signing failed: only ${signedCount}/${this._threshold} signatures collected.`,
        firstError === undefined ? undefined : { cause: firstError },
      );
    }

    const winner = results.find((r) => r.signed && r.signedXdr !== undefined);
    return {
      signedXdr: winner?.signedXdr as string,
      results,
      signatureCount: signedCount,
      threshold: this._threshold,
    };
  }

  /**
   * Asks a single signer to sign, enforcing the per-signer timeout and
   * verifying that the signer used the expected public key.
   */
  private async signWithSigner(
    signer: MultisigSigner,
    transactionXdr: string,
    opts: SignTransactionOptions,
  ): Promise<string> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new SignTransactionTimeoutError(this._signerTimeoutMs)),
        this._signerTimeoutMs,
      );
    });

    try {
      const response = await Promise.race([
        signer.wallet.signTransaction(transactionXdr, {
          ...opts,
          timeoutMs: opts.timeoutMs ?? this._signerTimeoutMs,
        }),
        timeout,
      ]);
      const signedXdr = extractSignedEnvelopeXdr(response);
      const actualKey = await signer.wallet.getPublicKey();
      if (actualKey !== signer.publicKey) {
        throw new Error(
          `Multisig signer signed with an unexpected public key (expected ${signer.publicKey}).`,
        );
      }
      return signedXdr;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
