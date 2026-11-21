/**
 * Tests for issue #719: the Ledger wallet adapter must sign fee-bump
 * transactions and gate signing behind the on-device confirmation.
 */
import {
  Account,
  FeeBumpTransaction,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import { describe, expect, it, vi } from 'vitest';

import { LedgerWalletAdapter, type LedgerStellarApp } from '../src/adapters/ledger';
import { SignTransactionTimeoutError, WalletNetworkMismatchError } from '../src/errors';

const keypair = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 9));
const feeSource = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 3));

function innerTx() {
  return new TransactionBuilder(new Account(keypair.publicKey(), '1'), {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.manageData({ name: 'k', value: 'v' }))
    .setTimeout(0)
    .build();
}

function feeBumpXdr() {
  return TransactionBuilder.buildFeeBumpTransaction(
    feeSource,
    '1000',
    innerTx(),
    Networks.TESTNET,
  ).toXDR();
}

function makeApp(signature: Buffer | Promise<{ signature: Buffer }>): LedgerStellarApp {
  return {
    getPublicKey: vi.fn().mockResolvedValue({ rawPublicKey: keypair.rawPublicKey() }),
    signTransaction: vi.fn().mockReturnValue(
      signature instanceof Promise ? signature : Promise.resolve({ signature }),
    ),
  };
}

describe('Issue #719: Ledger fee bump support', () => {
  it('signs a fee-bump transaction and returns a fee-bump envelope with the Ledger signature', async () => {
    const xdr = feeBumpXdr();
    const app = makeApp(Buffer.from(keypair.sign(
      TransactionBuilder.fromXDR(xdr, Networks.TESTNET).hash(),
    )));
    const adapter = new LedgerWalletAdapter({
      transport: {} as never,
      app,
      network: 'testnet',
      networkPassphrase: Networks.TESTNET,
    });
    await adapter.connect();

    const signedXdr = await adapter.signTransaction(xdr, { networkPassphrase: Networks.TESTNET });
    const signed = TransactionBuilder.fromXDR(signedXdr, Networks.TESTNET);

    expect(signed).toBeInstanceOf(FeeBumpTransaction);
    expect(signed.signatures).toHaveLength(1);
    expect(app.signTransaction).toHaveBeenCalledTimes(1);
  });

  it('sends the fee-bump signature base to the device, not the inner transaction hash', async () => {
    const xdr = feeBumpXdr();
    const parsed = TransactionBuilder.fromXDR(xdr, Networks.TESTNET);
    const app = makeApp(Buffer.from(keypair.sign(parsed.hash())));
    const adapter = new LedgerWalletAdapter({
      transport: {} as never,
      app,
      networkPassphrase: Networks.TESTNET,
    });
    await adapter.connect();
    await adapter.signTransaction(xdr, { networkPassphrase: Networks.TESTNET });

    const sent = (app.signTransaction as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as Buffer;
    const expected = Buffer.from(TransactionBuilder.fromXDR(xdr, Networks.TESTNET).signatureBase());
    expect(sent.equals(expected)).toBe(true);
  });

  it('waits for hardware confirmation before resolving a fee-bump signing request', async () => {
    let confirm!: (value: { signature: Buffer }) => void;
    const pending = new Promise<{ signature: Buffer }>((resolve) => {
      confirm = resolve;
    });
    const app = makeApp(pending);
    const adapter = new LedgerWalletAdapter({
      transport: {} as never,
      app,
      networkPassphrase: Networks.TESTNET,
    });
    await adapter.connect();

    let resolved = false;
    const xdr = feeBumpXdr();
    const signing = adapter
      .signTransaction(xdr, { networkPassphrase: Networks.TESTNET })
      .then((out) => {
        resolved = true;
        return out;
      });
    await Promise.resolve();
    expect(resolved).toBe(false);

    confirm({ signature: Buffer.from(keypair.sign(TransactionBuilder.fromXDR(xdr, Networks.TESTNET).hash())) });
    await expect(signing).resolves.toEqual(expect.any(String));
  });

  it('rejects a fee-bump signing request that the device never confirms', async () => {
    vi.useFakeTimers();
    try {
      const app = makeApp(new Promise(() => {}));
      const adapter = new LedgerWalletAdapter({
        transport: {} as never,
        app,
        networkPassphrase: Networks.TESTNET,
        timeoutMs: 1_000,
      });
      await adapter.connect();
      const signing = adapter.signTransaction(feeBumpXdr(), { networkPassphrase: Networks.TESTNET });
      const assertion = expect(signing).rejects.toBeInstanceOf(SignTransactionTimeoutError);
      await vi.advanceTimersByTimeAsync(1_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses to sign a fee-bump transaction for a different network', async () => {
    const app = makeApp(Buffer.alloc(64));
    const adapter = new LedgerWalletAdapter({
      transport: {} as never,
      app,
      networkPassphrase: Networks.PUBLIC,
    });
    await adapter.connect();
    await expect(
      adapter.signTransaction(feeBumpXdr(), { networkPassphrase: Networks.TESTNET }),
    ).rejects.toBeInstanceOf(WalletNetworkMismatchError);
    expect(app.signTransaction).not.toHaveBeenCalled();
  });
});
