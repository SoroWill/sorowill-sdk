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
 * into the client by implementing this interface. The module-level
 * {@link getPublicKey} and {@link signTransaction} functions already satisfy
 * it (see {@link freighterAdapter}).
 */
export interface WalletAdapter {
  isConnected(): Promise<boolean>;
  connect(): Promise<WalletConnection>;
  reconnect(): Promise<WalletConnection>;
  disconnect(): Promise<void>;
  getPublicKey(): Promise<string>;
  signTransaction(transactionXdr: string, opts: { networkPassphrase: string }): Promise<string>;
}

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

export async function connectWallet(): Promise<WalletConnection> {
  return await defaultFreighterWalletAdapter.connect();
}

export async function getPublicKey(): Promise<string> {
  return await defaultFreighterWalletAdapter.getPublicKey();
}

export async function signTransaction(
  transactionXdr: string,
  opts: { networkPassphrase: string },
): Promise<string> {
  return await defaultFreighterWalletAdapter.signTransaction(transactionXdr, opts);
}

export function getDefaultWalletAdapter(): WalletAdapter {
  return defaultFreighterWalletAdapter;
}

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
  getPublicKey,
  signTransaction,
};
