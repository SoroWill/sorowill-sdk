import { Account, xdr } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';

import { SoroWillClient, type SoroWillRpcServer } from '../src/SoroWillClient';
import { SoroWillError } from '../src/errors';

const VOID_SCVAL = xdr.ScVal.scvVoid();

function createRpcServer(overrides: Partial<{
  pollTransactionImpl: (hash: string) => Promise<unknown>;
}> = {}): SoroWillRpcServer {
  return {
    async getContractWasmByContractId(): Promise<Uint8Array> {
      return new Uint8Array();
    },
    async simulateTransaction() {
      return { result: { retval: VOID_SCVAL } } as never;
    },
    async getAccount(address: string) {
      return new Account(address, '1');
    },
    async prepareTransaction(tx: unknown) {
      return tx as never;
    },
    async sendTransaction() {
      return { status: 'PENDING', hash: 'tx_hash_abc' } as never;
    },
    async pollTransaction(hash: string, _options: { attempts: number }) {
      if (overrides.pollTransactionImpl) {
        return (await overrides.pollTransactionImpl(hash)) as never;
      }
      return {
        status: 'SUCCESS',
        createdAt: 1_700_000_100,
        returnValue: VOID_SCVAL,
      } as never;
    },
  };
}

function makeClient(rpcServer: SoroWillRpcServer) {
  return new SoroWillClient({
    network: 'testnet',
    contractId: 'CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR',
    readCache: false,
    spec: {
      funcArgsToScVals: () => [],
      funcResToNative: (_method: string, value: unknown) => value,
    },
    rpcServer,
  });
}

describe('SoroWillClient.waitForTransaction', () => {
  it('is a public method on SoroWillClient', () => {
    const client = makeClient(createRpcServer());
    expect(typeof client.waitForTransaction).toBe('function');
  });

  it('resolves with createdAt and returnValue on a SUCCESS response', async () => {
    const rpcServer = createRpcServer({
      async pollTransactionImpl() {
        return {
          status: 'SUCCESS',
          createdAt: 1_700_005_000,
          returnValue: VOID_SCVAL,
        };
      },
    });
    const client = makeClient(rpcServer);
    const result = await client.waitForTransaction('tx_abc123');
    expect(result.createdAt).toBe(1_700_005_000);
    expect(result.returnValue).toBe(VOID_SCVAL);
  });

  it('resolves with undefined returnValue when the transaction has none', async () => {
    const rpcServer = createRpcServer({
      async pollTransactionImpl() {
        return {
          status: 'SUCCESS',
          createdAt: 1_700_006_000,
          returnValue: undefined,
        };
      },
    });
    const client = makeClient(rpcServer);
    const result = await client.waitForTransaction('tx_no_return');
    expect(result.returnValue).toBeUndefined();
  });

  it('throws SoroWillError when the transaction status is not SUCCESS', async () => {
    const rpcServer = createRpcServer({
      async pollTransactionImpl() {
        return {
          status: 'FAILED',
          createdAt: 1_700_007_000,
          returnValue: undefined,
        };
      },
    });
    const client = makeClient(rpcServer);
    await expect(
      client.waitForTransaction('tx_failed'),
    ).rejects.toBeInstanceOf(SoroWillError);
  });

  it('throws SoroWillError with the txHash and status in the message', async () => {
    const rpcServer = createRpcServer({
      async pollTransactionImpl() {
        return { status: 'NOT_FOUND', createdAt: 0, returnValue: undefined };
      },
    });
    const client = makeClient(rpcServer);
    await expect(
      client.waitForTransaction('tx_not_found_hash'),
    ).rejects.toThrow(/tx_not_found_hash/);
  });

  it('forwards the error thrown by pollTransaction', async () => {
    const rpcServer = createRpcServer({
      async pollTransactionImpl() {
        throw new Error('poll timed out');
      },
    });
    const client = makeClient(rpcServer);
    await expect(
      client.waitForTransaction('tx_timeout'),
    ).rejects.toThrow('poll timed out');
  });

  it('calls pollTransaction with the provided hash', async () => {
    const polledHashes: string[] = [];
    const rpcServer = createRpcServer({
      async pollTransactionImpl(hash: string) {
        polledHashes.push(hash);
        return { status: 'SUCCESS', createdAt: 1_700_010_000, returnValue: VOID_SCVAL };
      },
    });
    const client = makeClient(rpcServer);
    await client.waitForTransaction('specific_tx_hash');
    expect(polledHashes).toEqual(['specific_tx_hash']);
  });

  it('can be called independently of invoke() — no wallet required', async () => {
    // A client with no wallet configured should still be able to poll for a
    // transaction that was submitted through an external signing flow.
    const rpcServer = createRpcServer();
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR',
      readCache: false,
      spec: { funcArgsToScVals: () => [], funcResToNative: (_m, v) => v },
      rpcServer,
    });
    const result = await client.waitForTransaction('external_tx');
    expect(result.createdAt).toBe(1_700_000_100);
  });
});
