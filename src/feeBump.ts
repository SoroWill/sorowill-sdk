import {
  BASE_FEE,
  Keypair,
  Networks,
  Transaction,
  TransactionBuilder,
  rpc,
} from '@stellar/stellar-sdk';

import type { SoroWillNetwork } from './SoroWillClient';

interface NetworkConfig {
  rpcUrl: string;
  networkPassphrase: string;
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
 * @returns The base64-encoded XDR of the fee-bump transaction envelope.
 */
export async function buildFeeBumpXdr(options: FeeBumpOptions): Promise<string> {
  const config = NETWORK_CONFIG[options.network];

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
    const diagnosticInfo = (sendResponse as any).diagnosticEventsXdr ?
      ` (diagnostics: ${(sendResponse as any).diagnosticEventsXdr})` : '';
    const errorDetail = (sendResponse as any).errorResultXdr ?
      ` (error: ${(sendResponse as any).errorResultXdr})` : '';
    throw new Error(
      `Fee-bump transaction submission failed${diagnosticInfo}${errorDetail}`,
      { cause: sendResponse }
    );
  }

  const txResponse = await server.pollTransaction(sendResponse.hash, { attempts: 30 });
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
 */
export async function submitFeeBump(options: {
  innerTransactionXdr: string;
  feeSourceSecretKey: string;
  network: SoroWillNetwork;
  fee?: string;
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

  return submitFeeBumpTransaction({
    network: options.network,
    feeBumpXdr: signedXdr,
  });
}
