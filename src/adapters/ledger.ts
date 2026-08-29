import Str from '@ledgerhq/hw-app-str';
import { StrKey, TransactionBuilder } from '@stellar/stellar-sdk';

import { SignTransactionTimeoutError } from '../errors';

import type { SignTransactionOptions, WalletAdapter, WalletConnection } from './types';

/** Default timeout (ms) for a Ledger signTransaction call. */
const DEFAULT_SIGN_TIMEOUT_MS = 120_000;

export interface LedgerTransport {
  close?(): Promise<void>;
}

export interface LedgerStellarApp {
  getPublicKey(path: string, display?: boolean): Promise<{ rawPublicKey: Buffer }>;
  signTransaction(path: string, signatureBase: Buffer): Promise<{ signature: Buffer }>;
}

export interface LedgerWalletAdapterOptions {
  transport: LedgerTransport;
  /** Stellar BIP-44 account path. */
  derivationPath?: string;
  network?: string;
  networkPassphrase: string;
  /**
   * Milliseconds to wait for the on-device confirmation before rejecting with
   * {@link SignTransactionTimeoutError}. Defaults to 120000. The Ledger promise
   * stays pending until the user physically approves or rejects on the device,
   * so a host that sets this should also surface a "waiting for device
   * confirmation — cancel?" affordance while the call is in flight.
   */
  timeoutMs?: number;
  /** Test seam for a mocked Ledger Stellar application. */
  app?: LedgerStellarApp;
}

/** Wallet adapter backed by the Ledger Stellar device application. */
export class LedgerWalletAdapter implements WalletAdapter {
  readonly id = 'ledger';
  readonly name = 'Ledger';

  private readonly app: LedgerStellarApp;
  private readonly derivationPath: string;
  private publicKey: string | null = null;

  constructor(private readonly options: LedgerWalletAdapterOptions) {
    this.derivationPath = options.derivationPath ?? "44'/148'/0'";
    this.app =
      options.app ??
      new Str(options.transport as unknown as ConstructorParameters<typeof Str>[0]);
  }

  async connect(): Promise<WalletConnection> {
    const result = await this.app.getPublicKey(this.derivationPath);
    this.publicKey = StrKey.encodeEd25519PublicKey(result.rawPublicKey);
    return {
      publicKey: this.publicKey,
      network: this.options.network ?? 'custom',
      networkPassphrase: this.options.networkPassphrase,
    };
  }

  async disconnect(): Promise<void> {
    await this.options.transport.close?.();
    this.publicKey = null;
  }

  async isConnected(): Promise<boolean> {
    return this.publicKey !== null;
  }

  async getPublicKey(): Promise<string> {
    if (!this.publicKey) {
      throw new Error('Ledger is not connected. Call connect() first.');
    }
    return this.publicKey;
  }

  async signTransaction(
    transactionXdr: string,
    options: SignTransactionOptions,
  ): Promise<string> {
    const publicKey = await this.getPublicKey();
    const transaction = TransactionBuilder.fromXDR(transactionXdr, options.networkPassphrase);
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_SIGN_TIMEOUT_MS;

    // The Ledger promise remains pending while the device displays transaction
    // details and cannot resolve before physical approval. Race it against a
    // timer so a walked-away user, a mid-approval disconnect, or a confirmation
    // that never comes rejects the caller instead of hanging forever (#154).
    const signatureBase = Buffer.from(transaction.signatureBase());
    let timeoutHandle: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new SignTransactionTimeoutError(timeoutMs)),
        timeoutMs,
      );
    });

    try {
      const { signature } = await Promise.race([
        this.app.signTransaction(this.derivationPath, signatureBase),
        timeoutPromise,
      ]);
      transaction.addSignature(publicKey, signature.toString('base64'));
      return transaction.toXDR();
    } finally {
      clearTimeout(timeoutHandle!);
    }
  }
}
