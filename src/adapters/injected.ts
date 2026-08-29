import type { SignTransactionOptions, WalletAdapter, WalletConnection } from './types';

/** Minimal API implemented by injected Stellar wallet providers. */
export interface InjectedWalletProvider {
  connect(): Promise<WalletConnection>;
  disconnect?(): Promise<void>;
  isConnected?(): Promise<boolean>;
  getPublicKey?(): Promise<string>;
  signTransaction(
    transactionXdr: string,
    options: SignTransactionOptions,
  ): Promise<string | { signedTxXdr: string }>;
}

/** Shared implementation for browser-injected wallet adapters. */
export abstract class InjectedWalletAdapter implements WalletAdapter {
  abstract readonly id: string;
  abstract readonly name: string;

  private connection: WalletConnection | null = null;

  protected constructor(private readonly provider: InjectedWalletProvider) {}

  async connect(): Promise<WalletConnection> {
    this.connection = await this.provider.connect();
    return this.connection;
  }

  async disconnect(): Promise<void> {
    await this.provider.disconnect?.();
    this.connection = null;
  }

  async isConnected(): Promise<boolean> {
    if (this.provider.isConnected) {
      return this.provider.isConnected();
    }
    if (this.connection && this.provider.getPublicKey) {
      try {
        await this.provider.getPublicKey();
      } catch {
        this.connection = null;
      }
    }
    return this.connection !== null;
  }

  async getPublicKey(): Promise<string> {
    if (this.provider.getPublicKey) {
      return this.provider.getPublicKey();
    }
    if (!this.connection) {
      throw new Error(`${this.name} is not connected. Call connect() first.`);
    }
    return this.connection.publicKey;
  }

  async signTransaction(
    transactionXdr: string,
    options: SignTransactionOptions,
  ): Promise<string> {
    const result = await this.provider.signTransaction(transactionXdr, options);
    return typeof result === 'string' ? result : result.signedTxXdr;
  }
}
