import { describe, expect, it } from 'vitest';
import {
  Account,
  Keypair,
  Networks,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import { MultisigCollector } from '../src/multisig';

const SAMPLE_TX_XDR = new TransactionBuilder(
  new Account(Keypair.random().publicKey(), '0'),
  {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  },
)
  .setTimeout(30)
  .build()
  .toXDR();

const SIGNER_A = Keypair.random().publicKey();
const SIGNER_B = Keypair.random().publicKey();

describe('MultisigCollector', () => {
  it('initialises with correct defaults', () => {
    const c = new MultisigCollector({
      transactionXdr: SAMPLE_TX_XDR,
      networkPassphrase: 'Test Network',
      threshold: 2,
    });
    expect(c.transactionXdr).toBe(SAMPLE_TX_XDR);
    expect(c.networkPassphrase).toBe('Test Network');
    expect(c.threshold).toBe(2);
    expect(c.signatureCount).toBe(0);
    expect(c.isReady).toBe(false);
    expect(c.signatures).toEqual([]);
  });

  it('throws if threshold is less than 1', () => {
    expect(
      () => new MultisigCollector({ transactionXdr: '', networkPassphrase: '', threshold: 0 }),
    ).toThrow('Threshold must be at least 1');
  });

  it('adds signatures and tracks count', () => {
    const c = new MultisigCollector({
      transactionXdr: SAMPLE_TX_XDR,
      networkPassphrase: 'Test Network',
      threshold: 2,
    });
    c.addSignature(SIGNER_A, 'sig1');
    expect(c.signatureCount).toBe(1);
    expect(c.isReady).toBe(false);

    c.addSignature(SIGNER_B, 'sig2');
    expect(c.signatureCount).toBe(2);
    expect(c.isReady).toBe(true);
  });

  it('throws when the same signer signs twice', () => {
    const c = new MultisigCollector({
      transactionXdr: SAMPLE_TX_XDR,
      networkPassphrase: 'Test Network',
      threshold: 2,
    });
    c.addSignature(SIGNER_A, 'sig1');
    expect(() => c.addSignature(SIGNER_A, 'sig2')).toThrow('already signed');
  });

  it('clears signatures with reset()', () => {
    const c = new MultisigCollector({
      transactionXdr: SAMPLE_TX_XDR,
      networkPassphrase: 'Test Network',
      threshold: 3,
    });
    c.addSignature(SIGNER_A, 'sig1');
    c.addSignature(SIGNER_B, 'sig2');
    c.reset();
    expect(c.signatureCount).toBe(0);
    expect(c.isReady).toBe(false);
  });

  it('reports isReady when threshold is met', () => {
    const c = new MultisigCollector({
      transactionXdr: SAMPLE_TX_XDR,
      networkPassphrase: 'Test Network',
      threshold: 1,
    });
    expect(c.isReady).toBe(false);
    c.addSignature(SIGNER_A, 'sig1');
    expect(c.isReady).toBe(true);
  });

  it('supports more signatures than the threshold', () => {
    const c = new MultisigCollector({
      transactionXdr: SAMPLE_TX_XDR,
      networkPassphrase: 'Test Network',
      threshold: 1,
    });
    c.addSignature(SIGNER_A, 'sig1');
    c.addSignature(SIGNER_B, 'sig2');
    expect(c.signatureCount).toBe(2);
    expect(c.isReady).toBe(true);
  });

  it('serialises and deserialises with toJSON / fromJSON', () => {
    const c = new MultisigCollector({
      transactionXdr: SAMPLE_TX_XDR,
      networkPassphrase: 'Test Network',
      threshold: 2,
    });
    c.addSignature(SIGNER_A, 'sig1');

    const json = c.toJSON();
    expect(json.transactionXdr).toBe(SAMPLE_TX_XDR);
    expect(json.threshold).toBe(2);
    expect(json.signatures).toEqual([{ signerPublicKey: SIGNER_A, signature: 'sig1' }]);

    const restored = MultisigCollector.fromJSON(json);
    expect(restored.signatureCount).toBe(1);
    expect(restored.signatures[0]?.signerPublicKey).toBe(SIGNER_A);
    expect(restored.threshold).toBe(2);
    expect(restored.toJSON()).toEqual(json);
  });

  it('returns read-only signatures array', () => {
    const c = new MultisigCollector({
      transactionXdr: SAMPLE_TX_XDR,
      networkPassphrase: 'Test Network',
      threshold: 1,
    });
    c.addSignature(SIGNER_A, 'sig1');
    const sigs = c.signatures;
    expect(sigs.length).toBe(1);
    expect(sigs[0]).toEqual({ signerPublicKey: SIGNER_A, signature: 'sig1' });
  });

  it('builds a fee-bump-wrapped transaction with collected signatures', () => {
    const signer = Keypair.random();
    const feeSource = Keypair.random();
    const innerTransaction = new TransactionBuilder(new Account(signer.publicKey(), '0'), {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
    })
      .setTimeout(30)
      .build();
    const feeBumpTransaction = TransactionBuilder.buildFeeBumpTransaction(
      feeSource,
      '200',
      innerTransaction,
      Networks.TESTNET,
    );
    const collector = new MultisigCollector({
      transactionXdr: feeBumpTransaction.toXDR(),
      networkPassphrase: Networks.TESTNET,
      threshold: 1,
    });

    collector.addSignature(
      signer.publicKey(),
      signer.signDecorated(innerTransaction.hash()).toXDR('base64'),
    );

    const built = collector.build();
    const builtEnvelope = built.toEnvelope();
    expect(builtEnvelope.feeBump().tx().innerTx().v1().signatures()).toHaveLength(1);
  });
});
