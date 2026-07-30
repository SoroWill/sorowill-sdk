import freighterApi from '@stellar/freighter-api';

import { FreighterInstallCheckError } from './errors';

/** Result of a successful wallet connection. */
export interface WalletConnection {
  publicKey: string;
  network: string;
  networkPassphrase: string;
}

/**
 * The full capability set a Stellar wallet must expose for
 * {@link SoroWillClient} to read the connected account and sign transactions.
 *
 * Any wallet — Freighter, Albedo, xBull, Rabet, Lobstr, etc. — can be plugged
 * into the client by implementing this interface. {@link FreighterWalletAdapter}
 * is the default implementation, backed by the Freighter browser extension.
 */
export interface WalletAdapter {
  isConnected?(): Promise<boolean>;
  connect?(): Promise<WalletConnection>;
  reconnect?(): Promise<WalletConnection>;
  disconnect?(): Promise<void>;
  getPublicKey(): Promise<string>;
  signTransaction(
    transactionXdr: string,
    opts: { networkPassphrase: string },
  ): Promise<string>;
  /**
   * Reports the network the wallet is currently connected to, if the wallet
   * can determine that without prompting the user. {@link SoroWillClient}
   * uses this — when available — to confirm the wallet's active network
   * matches the client's configured network before submitting a transaction
   * for signing.
   */
  getNetwork?(): Promise<{ network: string; networkPassphrase: string }>;
}

export class FreighterWalletAdapter implements WalletAdapter {
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
    const { isConnected, error } = await freighterApi.isConnected();
    if (error) {
      throw new FreighterInstallCheckError(error.code, error.message);
    }
    return isConnected;
  }

  async connect(): Promise<WalletConnection> {
    const access = await freighterApi.requestAccess();
    if (access.error) {
      throw new Error(access.error.message);
    }

    const networkDetails = await freighterApi.getNetworkDetails();
    if (networkDetails?.error) {
      throw new Error(networkDetails.error.message);
    }

    return {
      publicKey: access.address,
      network: networkDetails?.network ?? '',
      networkPassphrase: networkDetails?.networkPassphrase ?? '',
    };
  }

  async reconnect(): Promise<WalletConnection> {
    const publicKey = await this.getPublicKey();
    const networkDetails = await freighterApi.getNetworkDetails();
    if (networkDetails?.error) {
      throw new Error(networkDetails.error.message);
    }

    return {
      publicKey,
      network: networkDetails?.network ?? '',
      networkPassphrase: networkDetails?.networkPassphrase ?? '',
    };
  }

  async disconnect(): Promise<void> {
    return;
  }

  /** Reports the network Freighter is currently set to, without prompting the user. */
  async getNetwork(): Promise<{ network: string; networkPassphrase: string }> {
    const networkDetails = await freighterApi.getNetworkDetails();
    if (networkDetails?.error) {
      throw new Error(networkDetails.error.message);
    }
    return {
      network: networkDetails?.network ?? '',
      networkPassphrase: networkDetails?.networkPassphrase ?? '',
    };
  }

  async getPublicKey(): Promise<string> {
    const { address, error } = await freighterApi.getAddress();
    if (error) {
      throw new Error(error.message);
    }
    if (!address) {
      throw new Error('No Freighter account is connected. Call connectWallet() first.');
    }
    return address;
  }

  async signTransaction(
    transactionXdr: string,
    opts: { networkPassphrase: string },
  ): Promise<string> {
    const { signedTxXdr, error } = await freighterApi.signTransaction(transactionXdr, {
      networkPassphrase: opts.networkPassphrase,
    });
    if (error) {
      throw new Error(error.message);
    }
    return signedTxXdr;
  }
}

const defaultFreighterWalletAdapter = new FreighterWalletAdapter();

/**
 * Checks whether the Freighter browser extension is installed. This does not
 * require the current site to be connected/allowed — it only checks for the
 * extension's presence.
 *
 * @throws {FreighterInstallCheckError} if the underlying check fails for a
 * reason other than the extension being absent (e.g. running outside a
 * browser, or an internal Freighter error). Callers that only want a
 * best-effort "should I show an install prompt?" signal can treat a caught
 * {@link FreighterInstallCheckError} as "unknown" rather than "not installed".
 */
export async function isFreighterInstalled(): Promise<boolean> {
  return await defaultFreighterWalletAdapter.isConnected();
}

/** Connects to the Freighter wallet and returns the connection details. */
export async function connectWallet(): Promise<WalletConnection> {
  return await defaultFreighterWalletAdapter.connect();
}

/** Returns the public key of the currently connected Freighter account. */
export async function getPublicKey(): Promise<string> {
  return await defaultFreighterWalletAdapter.getPublicKey();
}

/** Signs a transaction XDR using the connected Freighter wallet. */
export async function signTransaction(
  transactionXdr: string,
  opts: { networkPassphrase: string },
): Promise<string> {
  return await defaultFreighterWalletAdapter.signTransaction(transactionXdr, opts);
}

/** Returns the default Freighter-based wallet adapter instance. */
export function getDefaultWalletAdapter(): WalletAdapter {
  return defaultFreighterWalletAdapter;
}

/**
 * The default {@link WalletAdapter}, backed by the Freighter browser
 * extension. This is what {@link SoroWillClient} uses when no `wallet` option
 * is supplied, so existing Freighter-based usage keeps working unchanged.
 */
export const freighterAdapter: WalletAdapter = defaultFreighterWalletAdapter;
