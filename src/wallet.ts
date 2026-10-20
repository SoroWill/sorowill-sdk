import type FreighterApi from '@stellar/freighter-api';

import {
  FreighterInstallCheckError,
  FreighterNotAvailableError,
  SignTransactionTimeoutError,
  WalletNetworkMismatchError,
} from './errors';

export class WalletSessionError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause ? { cause } : undefined);
    this.name = 'WalletSessionError';
  }
}

/**
 * Represents a wallet session token used for transaction signing.
 */
export interface WalletSession {
  token: string;
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
  const win = (globalThis as { window?: Record<string, unknown> }).window;
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

/**
 * Normalizes a wallet signer result to the signed XDR string the SDK expects.
 *
 * Some adapters return a bare XDR string, while others (WalletConnect, xBull,
 * …) return a {@link SignatureResponse} object. Passing the object through as
 * if it were a string silently fails downstream, so we validate the shape here
 * and throw a clear error for anything malformed.
 */
export function normalizeSignatureResponse(
  result: string | SignatureResponse,
): string {
  if (typeof result === 'string') {
    if (result.length === 0) {
      throw new Error('Wallet signer returned an empty signed XDR string.');
    }
    return result;
  }

  if (result && typeof result === 'object') {
    const { envelope_xdr } = result as SignatureResponse;
    if (typeof envelope_xdr === 'string' && envelope_xdr.length > 0) {
      return envelope_xdr;
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

/**
 * The full capability set a Stellar wallet must expose for
 * {@link SoroWillClient} to read the connected account and sign transactions.
 *
 * Any wallet — Freighter, Albedo, xBull, Rabet, Lobstr, etc. — can be plugged
 * into the client by implementing this interface. {@link FreighterWalletAdapter}
 * is the default implementation, backed by the Freighter browser extension.
 */
/**
 * The full capability set a Stellar wallet must expose for
 * {@link SoroWillClient} to read the connected account and sign transactions.
 *
 * Any wallet — Freighter, Albedo, xBull, Rabet, Lobstr, etc. — can be plugged
 * into the client by implementing this interface. The module-level
 * {@link getPublicKey} and {@link signTransaction} functions already satisfy
 * it (see {@link freighterAdapter}).
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
 * no browser extension available, build a lightweight adapter directly on top
 * of `@stellar/stellar-sdk`'s `Keypair`:
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
export interface SignTransactionOptions {
  networkPassphrase: string;
  timeoutMs?: number;
}

/** Called with the wallet's new network after it switches networks. */
export type WalletNetworkChangeListener = (network: {
  network: string;
  networkPassphrase: string;
}) => void;

/** Default interval (ms) at which Freighter is polled for wallet changes. */
const DEFAULT_FREIGHTER_WATCH_INTERVAL_MS = 3_000;

export interface WalletAdapter {
  isConnected(): Promise<boolean>;
  connect(): Promise<WalletConnection>;
  reconnect(): Promise<WalletConnection>;
  disconnect(): Promise<void>;
  getPublicKey(): Promise<string>;
  signTransaction(
    transactionXdr: string,
    opts: SignTransactionOptions,
  ): Promise<string | SignatureResponse>;
  /** Reports the network this wallet is currently set to, without prompting the user. Optional — not every wallet adapter can report this. */
  getNetwork?(): Promise<{ network: string; networkPassphrase: string }>;
  /**
   * Registers `listener` to be called whenever the wallet switches to a
   * different network. Returns a function that removes the listener.
   * Optional — {@link SoroWillClient} uses it to drop cached reads from the
   * previous network.
   */
  onNetworkChange?(listener: WalletNetworkChangeListener): () => void;
  /**
   * Returns the current session token for this wallet, if the adapter issues
   * one. Optional — adapters that do not use session tokens may omit it.
   */
  getSession?(): Promise<WalletSession | undefined>;
  /**
   * Refreshes an expired/invalid session token and returns the new one.
   * Optional — only meaningful for adapters that issue session tokens.
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

  if (session && session.token && session.expiresAt !== undefined && session.expiresAt > now) {
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

  if (!refreshed || !refreshed.token || refreshed.expiresAt === undefined || refreshed.expiresAt <= now) {
    throw new WalletSessionError(
      'The wallet session token is still invalid after refreshing. Reconnect the wallet and try again.',
    );
  }

  return refreshed.token;
}

/**
 * Options accepted by {@link FreighterWalletAdapter}.
 *
 * `expectedNetworkPassphrase` is the network the SDK/client is configured for.
 * When provided, the adapter verifies the wallet's current network against it
 * on `connect()`/`reconnect()` and rejects with a
 * {@link WalletNetworkMismatchError} on mismatch — instead of letting a
 * testnet wallet silently sign for a mainnet-configured client.
 */
export interface FreighterWalletAdapterOptions {
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
}

export class FreighterWalletAdapter implements WalletAdapter {
  private readonly expectedNetworkPassphrase?: string;
  private readonly injectionRetries: number;
  private readonly injectionRetryDelayMs: number;
  private session?: WalletSession;

  constructor(options: FreighterWalletAdapterOptions = {}) {
    if (options.expectedNetworkPassphrase !== undefined) {
      this.expectedNetworkPassphrase = options.expectedNetworkPassphrase;
    }
    this.injectionRetries = options.injectionRetries ?? DEFAULT_FREIGHTER_INJECTION_RETRIES;
    if (!Number.isInteger(this.injectionRetries) || this.injectionRetries <= 0) {
      throw new RangeError('injectionRetries must be a positive integer');
    }
    this.injectionRetryDelayMs = options.injectionRetryDelayMs ?? DEFAULT_FREIGHTER_INJECTION_RETRY_DELAY_MS;
    if (!Number.isFinite(this.injectionRetryDelayMs) || this.injectionRetryDelayMs < 0) {
      throw new RangeError('injectionRetryDelayMs must be a finite, non-negative number');
    }
  }

  /**
   * Loads the Freighter API and waits for the extension to be injected into
   * the page, so the returned API is safe to call. Throws a
   * {@link FreighterNotAvailableError} if Freighter never injects.
   */
  private async loadInjectedFreighterApi(): Promise<typeof FreighterApi> {
    const freighterApi = await loadFreighterApi();
    await waitForFreighterInjection(this.injectionRetries, this.injectionRetryDelayMs);
    return freighterApi;
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
      throw new FreighterInstallCheckError(error.code, error.message);
    }
    return isConnected;
  }

  async connect(): Promise<WalletConnection> {
    const freighterApi = await this.loadInjectedFreighterApi();
    const access = await freighterApi.requestAccess();
    if (access.error) {
      throw new Error(access.error.message);
    }

    const networkDetails = await freighterApi.getNetworkDetails();
    if (networkDetails?.error) {
      throw new Error(networkDetails.error.message);
    }

    const networkPassphrase = networkDetails?.networkPassphrase ?? '';
    this.assertNetworkMatches(networkPassphrase);

    return {
      publicKey: access.address,
      network: networkDetails?.network ?? '',
      networkPassphrase,
    };
  }

  async reconnect(): Promise<WalletConnection> {
    const publicKey = await this.getPublicKey();
    const freighterApi = await this.loadInjectedFreighterApi();
    const networkDetails = await freighterApi.getNetworkDetails();
    if (networkDetails?.error) {
      throw new Error(networkDetails.error.message);
    }

    const networkPassphrase = networkDetails?.networkPassphrase ?? '';
    this.assertNetworkMatches(networkPassphrase);

    return {
      publicKey,
      network: networkDetails?.network ?? '',
      networkPassphrase,
    };
  }

  async disconnect(): Promise<void> {
    delete (this as unknown as Record<string, unknown>).session;
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
    const freighterApi = await this.loadInjectedFreighterApi();
    const { address, error } = await freighterApi.getAddress();
    if (error) {
      throw new Error(error.message);
    }
    if (!address) {
      throw new Error('No Freighter account is connected. Call connectWallet() first.');
    }
    return address;
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
    this.session = {
      token: publicKey,
      expiresAt: Date.now() + DEFAULT_SESSION_TTL_MS,
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
    const result = await Promise.race<unknown>([
      freighterApiPromise.then((freighterApi) =>
        freighterApi.signTransaction(transactionXdr, {
          networkPassphrase: opts.networkPassphrase,
        }),
      ),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new SignTransactionTimeoutError(timeoutMs)), timeoutMs);
      }),
    ]);

    if (result && typeof result === 'object' && 'error' in result && result.error) {
      const errorMessage = typeof result.error === 'object' && result.error !== null && 'message' in result.error
        ? String((result.error as Record<string, unknown>).message)
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

  connect(): Promise<WalletConnection> {
    return this.connector.connect();
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
    return this.connector.signTransaction(transactionXdr, options);
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
