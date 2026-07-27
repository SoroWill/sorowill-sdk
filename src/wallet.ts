import freighterApi from '@stellar/freighter-api';

/** Result of a successful wallet connection. */
export interface WalletConnection {
  publicKey: string;
  network: string;
  networkPassphrase: string;
}

/**
 * The minimal capability set a Stellar wallet must expose for
 * {@link SoroWillClient} to read the connected account and sign transactions.
 *
 * Any wallet — Freighter, Albedo, xBull, Rabet, Lobstr, etc. — can be plugged
 * into the client by implementing this interface.
 */
export interface WalletAdapter {
  /**
   * Checks whether the wallet is currently connected/available.
   */
  isConnected(): Promise<boolean>;
  /** Connect to the wallet, prompting the user if necessary. */
  connect(): Promise<WalletConnection>;
  /** Reconnect using a previously established session. */
  reconnect(): Promise<WalletConnection>;
  /** Disconnect the current session. */
  disconnect(): Promise<void>;
  /**
   * Returns the connected account's public key (`G...`). May prompt the user
   * to select or connect an account, depending on the wallet.
   */
  getPublicKey(): Promise<string>;
  /**
   * Signs a base64-encoded transaction XDR envelope for the given network and
   * resolves with the signed XDR.
   */
  signTransaction(
    transactionXdr: string,
    opts: { networkPassphrase: string },
  ): Promise<string>;
}

/** Freighter browser extension adapter implementing {@link WalletAdapter}. */
export class FreighterWalletAdapter implements WalletAdapter {
  async isConnected(): Promise<boolean> {
    const { isConnected, error } = await freighterApi.isConnected();
    if (error) {
      return false;
    }
    return isConnected;
  }

  async connect(): Promise<WalletConnection> {
    const access = await freighterApi.requestAccess();
    if (access.error) {
      throw new Error(access.error.message);
    }

    const networkDetails = await freighterApi.getNetworkDetails();
    if (networkDetails.error) {
      throw new Error(networkDetails.error.message);
    }

    return {
      publicKey: access.address,
      network: networkDetails.network,
      networkPassphrase: networkDetails.networkPassphrase,
    };
  }

  async reconnect(): Promise<WalletConnection> {
    const publicKey = await this.getPublicKey();
    const networkDetails = await freighterApi.getNetworkDetails();
    if (networkDetails.error) {
      throw new Error(networkDetails.error.message);
    }

    return {
      publicKey,
      network: networkDetails.network,
      networkPassphrase: networkDetails.networkPassphrase,
    };
  }

  async disconnect(): Promise<void> {
    return;
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
