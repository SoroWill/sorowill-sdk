import {
  Keypair,
  Networks,
  Transaction,
  TransactionBuilder,
  rpc,
} from '@stellar/stellar-sdk';

import type { SoroWillNetwork } from './SoroWillClient';

/**
 * Raised when an inner transaction passed to {@link buildFeeBumpXdr} has a
 * sequence number that has already been consumed on-chain.  Wrapping a stale
 * transaction in a fee-bump envelope would produce a fee-bump that fails with
 * `txBAD_SEQ`, so we detect and reject it before the envelope is built.
 */
export class StaleTransactionSequenceError extends Error {
  /** The sequence number carried by the stale inner transaction. */
  readonly innerSequence: string;
  /** The current on-chain sequence number for the source account. */
  readonly accountSequence: string;

  constructor(innerSequence: string, accountSequence: string, options?: ErrorOptions) {
    super(
      `Inner transaction sequence (${innerSequence}) has already been used. ` +
        `The account's current sequence is ${accountSequence}. ` +
        `Rebuild and re-sign the transaction with a fresh sequence number before wrapping it in a fee bump.`,
      options,
    );
    this.name = 'StaleTransactionSequenceError';
    this.innerSequence = innerSequence;
    this.accountSequence = accountSequence;
  }
}

/**
 * Validates that the inner transaction's sequence number is still ahead of the
 * account's current on-chain sequence.  Stellar requires that a transaction's
 * sequence number be exactly `accountSequence + 1`; if the account has already
 * advanced past the transaction's sequence, the fee-bump will fail with
 * `txBAD_SEQ`.
 *
 * @param innerTransactionXdr - The prepared inner transaction XDR.
 * @param network - The Stellar network to query.
 * @throws {StaleTransactionSequenceError} when the sequence has already been used.
 */
export async function validateInnerTransactionSequence(
  innerTransactionXdr: string,
  network: SoroWillNetwork,
): Promise<void> {
  const config = NETWORK_CONFIG[network];
  const server = new rpc.Server(config.rpcUrl, {
    allowHttp: config.rpcUrl.startsWith('http://'),
  });

  const innerTx = TransactionBuilder.fromXDR(
    innerTransactionXdr,
    config.networkPassphrase,
  ) as Transaction;

  const sourceAccount = innerTx.source;
  const innerSequence = BigInt(innerTx.sequence);

  const accountData = await server.getAccount(sourceAccount);
  // getAccount returns the account's *current* sequence — the last one used.
  // A valid next transaction must have sequence === accountSequence + 1.
  const accountSequence = BigInt(accountData.sequence);

  if (innerSequence <= accountSequence) {
    throw new StaleTransactionSequenceError(
      innerSequence.toString(),
      accountSequence.toString(),
    );
  }
}

interface NetworkConfig {
  rpcUrl: string;
  networkPassphrase: string;
}

interface SendTransactionErrorResponse {
  status: string;
  hash?: string;
  diagnosticEventsXdr?: string;
  errorResultXdr?: string;
}

const NETWORK_CONFIG: Record<SoroWillNetwork, NetworkConfig> = {
  testnet: {
    rpcUrl: 'https://soroban-testnet.stellar.org',
    networkPassphrase: Networks.TESTNET,
  },
  mainnet: {
    rpcUrl: 'https://mainnet.sorobanrpc.com',
    networkPassphrase: Networks.PUBLIC,
  },
};

/** Options for building a fee-bump transaction. */
export interface FeeBumpOptions {
  /** The network to use. */
  network: SoroWillNetwork;
  /** The base64-encoded XDR of the inner (prepared, unsigned) transaction. */
  innerTransactionXdr: string;
  /** The fee source account's public key (the account sponsoring the fee). */
  feeSourcePublicKey: string;
  /** The maximum fee the sponsor is willing to pay, in stroops. Defaults to BASE_FEE. */
  fee: string;
}

/** Options for submitting a signed fee-bump transaction. */
export interface SubmitFeeBumpOptions {
  /** The network to use. */
  network: SoroWillNetwork;
  /** The base64-encoded XDR of the signed fee-bump transaction. */
  feeBumpXdr: string;
  /** The maximum number of attempts to poll for transaction confirmation. Defaults to 30. */
  pollAttempts?: number;
}

/**
 * Build a fee-bump transaction that wraps an inner transaction,
 * allowing a different account (the fee sponsor) to pay the network fee.
 *
 * The inner transaction must already be prepared via
 * `server.prepareTransaction()`. The fee sponsor only needs to have
 * their account loaded — no Freighter connection is required on the
 * user's side.
 *
 * Before building the envelope this function validates that the inner
 * transaction's sequence number has not yet been consumed on-chain.  If the
 * inner transaction was prepared, cached, and is now being retried after a
 * delay, the sequence may already be spent — in that case
 * {@link StaleTransactionSequenceError} is thrown so the caller can rebuild
 * with a fresh sequence rather than submitting a fee-bump that will fail with
 * `txBAD_SEQ`.
 *
 * @returns The base64-encoded XDR of the fee-bump transaction envelope.
 * @throws {StaleTransactionSequenceError} when the inner transaction's sequence has already been used.
 */
export async function buildFeeBumpXdr(options: FeeBumpOptions): Promise<string> {
  const config = NETWORK_CONFIG[options.network];

  // Validate that the inner transaction's sequence number is still valid
  // before wrapping it in a fee-bump envelope.
  await validateInnerTransactionSequence(options.innerTransactionXdr, options.network);

  const innerTx = TransactionBuilder.fromXDR(
    options.innerTransactionXdr,
    config.networkPassphrase,
  ) as Transaction;

  const feeBumpTx = TransactionBuilder.buildFeeBumpTransaction(
    Keypair.fromPublicKey(options.feeSourcePublicKey),
    options.fee,
    innerTx,
    config.networkPassphrase,
  );

  return feeBumpTx.toXDR();
}

/**
 * Sign a fee-bump transaction with a secret key (the fee sponsor's key).
 * Returns the signed fee-bump transaction XDR.
 */
export function signFeeBumpXdr(
  feeBumpXdr: string,
  secretKey: string,
  networkPassphrase: string,
): string {
  const keypair = Keypair.fromSecret(secretKey);
  const feeBump = TransactionBuilder.fromXDR(feeBumpXdr, networkPassphrase);

  const hashed = feeBump.hash();
  const sig = keypair.signDecorated(hashed);
  feeBump.addDecoratedSignature(sig);

  return feeBump.toXDR();
}

/**
 * Submit a signed fee-bump transaction to the network and wait for confirmation.
 */
export async function submitFeeBumpTransaction(
  options: SubmitFeeBumpOptions,
): Promise<{ txHash: string; createdAt: number }> {
  const config = NETWORK_CONFIG[options.network];
  const server = new rpc.Server(config.rpcUrl, {
    allowHttp: config.rpcUrl.startsWith('http://'),
  });

  const feeBumpTx = TransactionBuilder.fromXDR(
    options.feeBumpXdr,
    config.networkPassphrase,
  ) as Transaction;

  const sendResponse = await server.sendTransaction(feeBumpTx);
  if (sendResponse.status === 'ERROR') {
    const errorResponse = sendResponse as SendTransactionErrorResponse;
    const diagnosticInfo = errorResponse.diagnosticEventsXdr ?
      ` (diagnostics: ${errorResponse.diagnosticEventsXdr})` : '';
    const errorDetail = errorResponse.errorResultXdr ?
      ` (error: ${errorResponse.errorResultXdr})` : '';
    throw new Error(
      `Fee-bump transaction submission failed${diagnosticInfo}${errorDetail}`,
      { cause: sendResponse }
    );
  }

  const pollAttempts = options.pollAttempts ?? 30;
  const txResponse = await server.pollTransaction(sendResponse.hash, { attempts: pollAttempts });
  if (txResponse.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new Error(`Fee-bump transaction did not succeed: ${txResponse.status}`);
  }

  return {
    txHash: sendResponse.hash,
    createdAt: txResponse.createdAt,
  };
}

/**
 * High-level helper: build, sign, and submit a fee-bump transaction in one call.
 *
 * @param options.innerTransactionXdr - Prepared inner transaction XDR (unsigned, after `server.prepareTransaction()`).
 * @param options.feeSourceSecretKey - Secret key of the fee sponsor account.
 * @param options.network - Stellar network to use.
 * @param options.pollAttempts - Maximum number of attempts to poll for transaction confirmation. Defaults to 30.
 */
export async function submitFeeBump(options: {
  innerTransactionXdr: string;
  feeSourceSecretKey: string;
  network: SoroWillNetwork;
  fee?: string;
  pollAttempts?: number;
}): Promise<{ txHash: string; createdAt: number }> {
  const config = NETWORK_CONFIG[options.network];
  const keypair = Keypair.fromSecret(options.feeSourceSecretKey);
  const publicKey = keypair.publicKey();

  let fee = options.fee;
  if (!fee) {
    const innerTx = TransactionBuilder.fromXDR(
      options.innerTransactionXdr,
      config.networkPassphrase,
    ) as Transaction;
    fee = innerTx.fee;
  }

  const feeBumpXdr = await buildFeeBumpXdr({
    network: options.network,
    innerTransactionXdr: options.innerTransactionXdr,
    feeSourcePublicKey: publicKey,
    fee,
  });

  const signedXdr = signFeeBumpXdr(feeBumpXdr, options.feeSourceSecretKey, config.networkPassphrase);

  const submitOptions: SubmitFeeBumpOptions = {
    network: options.network,
    feeBumpXdr: signedXdr,
  };
  if (options.pollAttempts !== undefined) {
    submitOptions.pollAttempts = options.pollAttempts;
  }

  return submitFeeBumpTransaction(submitOptions);
}
