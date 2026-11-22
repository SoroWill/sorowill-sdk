import type Albedo from '@albedo-link/intent';
import { Networks } from '@stellar/stellar-sdk';

import { toWalletCancelledError } from '../errors';
import type { WalletAdapter, WalletConnection } from '../wallet';

/**
 * `@albedo-link/intent` is an optional peer dependency — consumers who only
 * use Freighter, Ledger, WalletConnect, or a custom {@link WalletAdapter} are
 * not required to install it. Its UMD bundle also assumes a browser `window`
 * global and throws immediately if evaluated outside one (e.g. in a test
 * runner), so it must be imported lazily rather than at module load time.
 */
let albedoPromise: Promise<typeof Albedo> | undefined;
function loadAlbedo(): Promise<typeof Albedo> {
  if (!albedoPromise) {
    albedoPromise = import('@albedo-link/intent').then((mod) => mod.default);
  }
  return albedoPromise;
}

/**
 * Maps a Stellar network passphrase to the network identifier Albedo expects
 * (`'public'` or `'testnet'`). Unknown passphrases — e.g. custom/standalone
 * networks — are passed through unchanged, which Albedo also accepts.
 */
function toAlbedoNetwork(networkPassphrase: string): string {
  switch (networkPassphrase) {
    case Networks.PUBLIC:
      return 'public';
    case Networks.TESTNET:
      return 'testnet';
    default:
      return networkPassphrase;
  }
}

/** Options for {@link createAlbedoAdapter}. */
export interface AlbedoAdapterOptions {
  /**
   * The Stellar network passphrase the adapter reports. Defaults to
   * `Networks.PUBLIC`.
   */
  networkPassphrase?: string;
}

/**
 * Creates a {@link WalletAdapter} backed by Albedo (https://albedo.link), a
 * web-based Stellar signer that requires no browser extension.
 *
 * ## Network behavior
 *
 * - The adapter reports the network passed via `networkPassphrase` (defaults
 *   to `Networks.PUBLIC` / mainnet). Albedo itself is told `'testnet'` or
 *   `'public'` via {@link toAlbedoNetwork}; custom/standalone passphrases are
 *   passed through unchanged.
 * - The same adapter instance is bound to a single network. To switch
 *   networks (e.g. testnet ↔ mainnet) create a new adapter with the desired
 *   `networkPassphrase`; do not reuse one instance across networks, or the
 *   reported network will not match the network the client is configured for
 *   and {@link SoroWillClient.assertWalletNetwork} will surface a mismatch.
 * - Albedo signs transactions for whichever network is passed to `albedo.tx()`.
 *   `signTransaction` rejects with {@link WalletNetworkMismatchError} when
 *   `opts.networkPassphrase` differs from the adapter's network, so a
 *   signature valid only on another network is never produced.
 * - Albedo exposes no network-change event, so a switch made inside the
 *   Albedo UI is not detected automatically. The mismatch check above is what
 *   catches it: create a new adapter for the new network and reconnect.
 *
 * ## Known issues
 *
 * - `@albedo-link/intent` is loaded lazily because its UMD bundle assumes a
 *   browser `window` global and throws outside one (e.g. in Node/test).
 * - Albedo does not expose a `disconnect()` equivalent; `disconnect()` only
 *   clears the SDK-side cached state.
 *
 * ## Workarounds
 *
 * - Always construct the adapter with the passphrase that matches your
 *   `SoroWillClient.network` (`Networks.TESTNET` for testnet,
 *   `Networks.PUBLIC` for mainnet).
 *
 * ```ts
 * import { Networks } from '@stellar/stellar-sdk';
 * import { SoroWillClient, createAlbedoAdapter } from '@sorowill/sdk';
 *
 * const client = new SoroWillClient({
 *   network: 'testnet',
 *   contractId: 'C...',
 *   wallet: createAlbedoAdapter({ networkPassphrase: Networks.TESTNET }),
 * });
 * ```
 */
export function createAlbedoAdapter(options: AlbedoAdapterOptions = {}): WalletAdapter {
  const networkPassphrase = options.networkPassphrase ?? Networks.PUBLIC;
  const networkInfo = { network: toAlbedoNetwork(networkPassphrase), networkPassphrase };
  let cachedPublicKey: string | undefined;
  let connected = false;

  return {
    async isConnected(): Promise<boolean> {
      return connected;
    },

    async connect(): Promise<WalletConnection> {
      const albedo = await loadAlbedo();
      let pubkey: string;
      try {
        ({ pubkey } = await albedo.publicKey({}));
      } catch (err) {
        const cancelled = toWalletCancelledError(err, 'connect');
        if (cancelled) throw cancelled;
        throw err;
      }
      cachedPublicKey = pubkey;
      connected = true;
      return { publicKey: pubkey, ...networkInfo };
    },

    async reconnect(): Promise<WalletConnection> {
      if (connected && cachedPublicKey) {
        return {
          publicKey: cachedPublicKey,
          ...networkInfo,
        };
      }
      const albedo = await loadAlbedo();
      let pubkey: string;
      try {
        ({ pubkey } = await albedo.publicKey({}));
      } catch (err) {
        const cancelled = toWalletCancelledError(err, 'reconnect');
        if (cancelled) throw cancelled;
        throw err;
      }
      cachedPublicKey = pubkey;
      connected = true;
      return { publicKey: pubkey, ...networkInfo };
    },

    async disconnect(): Promise<void> {
      cachedPublicKey = undefined;
      connected = false;
    },

    async getPublicKey(): Promise<string> {
      if (connected && cachedPublicKey) {
        return cachedPublicKey;
      }
      const albedo = await loadAlbedo();
      let pubkey: string;
      try {
        ({ pubkey } = await albedo.publicKey({}));
      } catch (err) {
        const cancelled = toWalletCancelledError(err, 'getPublicKey');
        if (cancelled) throw cancelled;
        throw err;
      }
      cachedPublicKey = pubkey;
      connected = true;
      return pubkey;
    },

    async signTransaction(
      transactionXdr: string,
      opts: { networkPassphrase: string },
    ): Promise<string> {
      // Albedo signs for whatever network is passed to `albedo.tx()`, so a
      // request for a different network would silently produce a signature
      // valid only on that network. Reject it before reaching Albedo.
      if (opts.networkPassphrase !== networkPassphrase) {
        throw new WalletNetworkMismatchError(networkPassphrase, opts.networkPassphrase);
      }
      const albedo = await loadAlbedo();
      try {
        const { signed_envelope_xdr: signedTxXdr } = await albedo.tx({
          xdr: transactionXdr,
          network: toAlbedoNetwork(opts.networkPassphrase),
          ...(cachedPublicKey === undefined ? {} : { pubkey: cachedPublicKey }),
        });
        return signedTxXdr;
      } catch (err) {
        const cancelled = toWalletCancelledError(err, 'signTransaction');
        if (cancelled) throw cancelled;
        throw err;
      }
    },

    async getNetwork(): Promise<{ network: string; networkPassphrase: string }> {
      return { ...networkInfo };
    },

    clearKeyCache(): void {
      cachedPublicKey = undefined;
    },
  };
}
