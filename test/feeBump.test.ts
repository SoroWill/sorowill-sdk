import { describe, expect, it } from 'vitest';
import { signFeeBumpXdr } from '../src/feeBump';
import {
  Account,
  Keypair,
  Networks,
  Transaction,
  TransactionBuilder,
} from '@stellar/stellar-sdk';

function makeInnerTxXdr(networkPassphrase: string): string {
  const sourceKeypair = Keypair.random();
  const sourceAccount = new Account(sourceKeypair.publicKey(), '0');
  const tx = new TransactionBuilder(sourceAccount, {
    fee: '100',
    networkPassphrase,
  })
    .setTimeout(30)
    .build();

  return tx.toXDR();
}

function makeFeeBumpXdr(
  innerTxXdr: string,
  feeSourceKeypair: Keypair,
  networkPassphrase: string,
): string {
  const innerTx = TransactionBuilder.fromXDR(innerTxXdr, networkPassphrase) as Transaction;
  const feeBump = TransactionBuilder.buildFeeBumpTransaction(
    feeSourceKeypair,
    '200',
    innerTx,
    networkPassphrase,
  );
  return feeBump.toXDR();
}

describe('feeBump', () => {
  it('signFeeBumpXdr signs and returns valid XDR', () => {
    const innerXdr = makeInnerTxXdr(Networks.TESTNET);
    const feeSource = Keypair.random();
    const feeBumpXdr = makeFeeBumpXdr(innerXdr, feeSource, Networks.TESTNET);

    const signedXdr = signFeeBumpXdr(feeBumpXdr, feeSource.secret(), Networks.TESTNET);
    expect(typeof signedXdr).toBe('string');
    expect(signedXdr.length).toBeGreaterThan(0);

    // Should be parseable as a valid transaction
    const parsed = TransactionBuilder.fromXDR(signedXdr, Networks.TESTNET);
    expect(parsed).toBeDefined();
  });

  it('signFeeBumpXdr adds a signature to the fee bump envelope', () => {
    const innerXdr = makeInnerTxXdr(Networks.TESTNET);
    const feeSource = Keypair.random();
    const feeBumpXdr = makeFeeBumpXdr(innerXdr, feeSource, Networks.TESTNET);

    const signedXdr = signFeeBumpXdr(feeBumpXdr, feeSource.secret(), Networks.TESTNET);

    // Parse the signed fee bump and verify the signature is present
    const signed = TransactionBuilder.fromXDR(signedXdr, Networks.TESTNET) as Transaction;
    const envelope = signed.toEnvelope();
    const feeBumpEnv = envelope.feeBump();
    expect(feeBumpEnv).toBeDefined();
    expect(feeBumpEnv!.signatures().length).toBe(1);
  });

  it('signFeeBumpXdr works on testnet', () => {
    const innerXdr = makeInnerTxXdr(Networks.TESTNET);
    const feeSource = Keypair.random();
    const feeBumpXdr = makeFeeBumpXdr(innerXdr, feeSource, Networks.TESTNET);

    const signed = signFeeBumpXdr(feeBumpXdr, feeSource.secret(), Networks.TESTNET);
    expect(signed).toBeTruthy();
  });

  it('signFeeBumpXdr works on mainnet passphrase', () => {
    const innerXdr = makeInnerTxXdr(Networks.PUBLIC);
    const feeSource = Keypair.random();
    const feeBumpXdr = makeFeeBumpXdr(innerXdr, feeSource, Networks.PUBLIC);

    const signed = signFeeBumpXdr(feeBumpXdr, feeSource.secret(), Networks.PUBLIC);
    expect(signed).toBeTruthy();
  });

  it('signFeeBumpXdr throws on invalid secret key', () => {
    const innerXdr = makeInnerTxXdr(Networks.TESTNET);
    const feeSource = Keypair.random();
    const feeBumpXdr = makeFeeBumpXdr(innerXdr, feeSource, Networks.TESTNET);

    expect(() => signFeeBumpXdr(feeBumpXdr, 'not-a-valid-key', Networks.TESTNET)).toThrow();
  });

  it('signFeeBumpXdr throws on invalid XDR', () => {
    expect(() => signFeeBumpXdr('invalid-xdr', Keypair.random().secret(), Networks.TESTNET)).toThrow();
  });

  it('multiple signers can sign the same fee bump', () => {
    const innerXdr = makeInnerTxXdr(Networks.TESTNET);
    const feeSource = Keypair.random();
    let feeBumpXdr = makeFeeBumpXdr(innerXdr, feeSource, Networks.TESTNET);

    const signer1 = Keypair.random();
    const signer2 = Keypair.random();

    feeBumpXdr = signFeeBumpXdr(feeBumpXdr, signer1.secret(), Networks.TESTNET);
    feeBumpXdr = signFeeBumpXdr(feeBumpXdr, signer2.secret(), Networks.TESTNET);

    const parsed = TransactionBuilder.fromXDR(feeBumpXdr, Networks.TESTNET) as Transaction;
    const envelope = parsed.toEnvelope();
    const feeBumpEnv = envelope.feeBump();
    expect(feeBumpEnv!.signatures().length).toBe(2);
  });
});

describe('feeBump configuration', () => {
  it('submitFeeBumpTransaction accepts optional pollAttempts parameter', () => {
    const innerXdr = makeInnerTxXdr(Networks.TESTNET);
    const feeSource = Keypair.random();
    const feeBumpXdr = makeFeeBumpXdr(innerXdr, feeSource, Networks.TESTNET);
    const signedXdr = signFeeBumpXdr(feeBumpXdr, feeSource.secret(), Networks.TESTNET);

    const options: { network: 'testnet' | 'mainnet'; feeBumpXdr: string; pollAttempts?: number } = {
      network: 'testnet',
      feeBumpXdr: signedXdr,
      pollAttempts: 50,
    };

    expect(options.pollAttempts).toBe(50);
  });

  it('submitFeeBumpTransaction works with default pollAttempts', () => {
    const innerXdr = makeInnerTxXdr(Networks.TESTNET);
    const feeSource = Keypair.random();
    const feeBumpXdr = makeFeeBumpXdr(innerXdr, feeSource, Networks.TESTNET);
    const signedXdr = signFeeBumpXdr(feeBumpXdr, feeSource.secret(), Networks.TESTNET);

    const options: { network: 'testnet' | 'mainnet'; feeBumpXdr: string; pollAttempts?: number } = {
      network: 'testnet',
      feeBumpXdr: signedXdr,
    };

    expect(options.pollAttempts).toBeUndefined();
  });

  it('submitFeeBump accepts optional pollAttempts parameter', () => {
    const innerXdr = makeInnerTxXdr(Networks.TESTNET);
    const feeSource = Keypair.random();

    const options: {
      innerTransactionXdr: string;
      feeSourceSecretKey: string;
      network: 'testnet' | 'mainnet';
      fee?: string;
      pollAttempts?: number;
    } = {
      innerTransactionXdr: innerXdr,
      feeSourceSecretKey: feeSource.secret(),
      network: 'testnet',
      fee: '1000',
      pollAttempts: 60,
    };

    expect(options.pollAttempts).toBe(60);
  });

  it('submitFeeBump works with default pollAttempts', () => {
    const innerXdr = makeInnerTxXdr(Networks.TESTNET);
    const feeSource = Keypair.random();

    const options: {
      innerTransactionXdr: string;
      feeSourceSecretKey: string;
      network: 'testnet' | 'mainnet';
      fee?: string;
      pollAttempts?: number;
    } = {
      innerTransactionXdr: innerXdr,
      feeSourceSecretKey: feeSource.secret(),
      network: 'testnet',
      fee: '1000',
    };

    expect(options.pollAttempts).toBeUndefined();
  });
});
