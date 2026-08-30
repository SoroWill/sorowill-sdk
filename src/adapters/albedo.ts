import albedo from '@albedo-link/intent';
import { Networks } from '@stellar/stellar-sdk';

import type { WalletAdapter, WalletConnection } from '../wallet';

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

/**
 * Creates a {@link WalletAdapter} backed by Albedo (https://albedo.link), a
 * web-based Stellar signer that requires no browser extension.
 *
 * ```ts
 * import { SoroWillClient, createAlbedoAdapter } from '@sorowill/sdk';
 *
 * const client = new SoroWillClient({
 *   network: 'testnet',
 *   contractId: 'C...',
 *   wallet: createAlbedoAdapter(),
 * });
 * ```
 */
export function createAlbedoAdapter(): WalletAdapter {
  let cachedPublicKey: string | undefined;
  let connected = false;

  return {
    id: 'albedo',
    name: 'Albedo',

    async isConnected(): Promise<boolean> {
      return connected;
    },

    async connect(): Promise<WalletConnection> {
      const { pubkey } = await albedo.publicKey({});
      cachedPublicKey = pubkey;
      connected = true;
      return { publicKey: pubkey, network: 'public', networkPassphrase: Networks.PUBLIC };
    },

    async reconnect(): Promise<WalletConnection> {
      if (connected && cachedPublicKey) {
        return {
          publicKey: cachedPublicKey,
          network: 'public',
          networkPassphrase: Networks.PUBLIC,
        };
      }
      const { pubkey } = await albedo.publicKey({});
      cachedPublicKey = pubkey;
      connected = true;
      return { publicKey: pubkey, network: 'public', networkPassphrase: Networks.PUBLIC };
    },

    async disconnect(): Promise<void> {
      cachedPublicKey = undefined;
      connected = false;
    },

    async getPublicKey(): Promise<string> {
      if (connected && cachedPublicKey) {
        return cachedPublicKey;
      }
      const { pubkey } = await albedo.publicKey({});
      cachedPublicKey = pubkey;
      connected = true;
      return pubkey;
    },

    async signTransaction(
      transactionXdr: string,
      opts: { networkPassphrase: string },
    ): Promise<string> {
      const { signed_envelope_xdr: signedTxXdr } = await albedo.tx({
        xdr: transactionXdr,
        network: toAlbedoNetwork(opts.networkPassphrase),
        ...(cachedPublicKey === undefined ? {} : { pubkey: cachedPublicKey }),
      });
      return signedTxXdr;
    },

    async getNetwork(): Promise<{ network: string; networkPassphrase: string }> {
      return { network: 'public', networkPassphrase: Networks.PUBLIC };
    },
  };
}
