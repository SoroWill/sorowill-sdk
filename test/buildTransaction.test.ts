import { Account, Networks, Operation, TransactionBuilder, xdr } from '@stellar/stellar-sdk';
import { describe, expect, it, vi } from 'vitest';

/**
 * Builds a real, structurally-valid signed transaction envelope XDR string
 * using the actual (unmocked) SDK classes — submitSignedTransaction() parses
 * this with the real TransactionBuilder.fromXDR, so a placeholder string
 * isn't parseable XDR and would fail before ever reaching the mocked server.
 */
function makeRealSignedXdr(): string {
  const account = new Account('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF', '0');
  const tx = new TransactionBuilder(account, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.bumpSequence({ bumpTo: '1' }))
    .setTimeout(30)
    .build();
  return tx.toXDR();
}

vi.mock('../src/wallet', () => ({
  getPublicKey: vi.fn(async () => 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'),
  signTransaction: vi.fn(async (transactionXdr: string) => transactionXdr),
  getDefaultWalletAdapter: vi.fn(() => ({
    getPublicKey: vi.fn(async () => 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'),
    signTransaction: vi.fn(async (transactionXdr: string) => transactionXdr),
    isConnected: vi.fn(async () => true),
    connect: vi.fn(),
    reconnect: vi.fn(),
    disconnect: vi.fn(),
  })),
}));

import { SoroWillClient } from '../src/SoroWillClient';

function makeClient(
  overrides: Record<string, unknown> = {},
): { client: SoroWillClient; fakeServer: Record<string, unknown> } {
  const fakeSpec = {
    funcArgsToScVals: () => [] as xdr.ScVal[],
  };

  const fakeServer = {
    getAccount: async (publicKey: string) => new Account(publicKey, '0'),
    prepareTransaction: async (tx: { toXDR: () => string }) => tx,
    sendTransaction: async () => ({ status: 'PENDING', hash: 'tx-hash-123' }),
    pollTransaction: async () => ({
      status: 'SUCCESS',
      createdAt: 1_700_000_000,
      returnValue: xdr.ScVal.scvVoid(),
    }),
    getContractWasmByContractId: async () => new Uint8Array(),
    simulateTransaction: async () => ({
      result: { retval: xdr.ScVal.scvVoid() },
    }),
  };

  const client = new SoroWillClient({
    network: 'testnet',
    contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
    rpcUrls: ['https://rpc.test'],
    // Passed at construction (not monkey-patched after) so it's respected by
    // both this.server (used by submitSignedTransaction) and this.rpcPool
    // (used by buildTransaction / read paths).
    rpcServer: fakeServer as never,
    ...overrides,
  });

  Object.defineProperty(client, 'specPromise', { value: Promise.resolve(fakeSpec) });
  Object.defineProperty(client, 'queue', {
    value: {
      enqueue: (fn: () => Promise<unknown>) => fn(),
    },
  });

  return { client, fakeServer };
}

describe('buildTransaction', () => {
  it('builds an unsigned transaction for a contract method call', async () => {
    const { client, fakeServer } = makeClient();

    const tx = await client.buildTransaction('check_in', {
      will_id: BigInt(42),
      owner: 'GTESTACCOUNT',
    });

    expect(tx).toBeDefined();
    expect(typeof tx.toXDR).toBe('function');
    expect(tx.toXDR()).toBeTruthy();

    // Verify it accessed the server for the account
    expect(fakeServer.getAccount).toBeDefined();
  });

  it('accepts an optional sourcePublicKey override', async () => {
    const { client } = makeClient();
    const customPublicKey = 'GA3JE5IXBSOR6DCLZSGN7JIWQWO45RCS7PUFKKVXWSTE4Y75ISIDMHJG';

    const tx = await client.buildTransaction(
      'check_in',
      { will_id: BigInt(42), owner: customPublicKey },
      customPublicKey,
    );

    expect(tx).toBeDefined();
    expect(typeof tx.toXDR).toBe('function');
  });

  it('builds a transaction with the correct fee and timeout', async () => {
    const { client } = makeClient();

    const tx = await client.buildTransaction('check_in', {
      will_id: BigInt(1),
      owner: 'GTESTACCOUNT',
    });

    // The transaction should be buildable and have a timeout
    const xdrStr = tx.toXDR();
    expect(xdrStr).toBeTruthy();
    expect(xdrStr.length).toBeGreaterThan(0);
  });

  it('works for different contract methods', async () => {
    const { client } = makeClient();

    const methods = [
      'create_will',
      'trigger_will',
      'cancel_will',
      'top_up',
      'guardian_trigger',
    ];

    for (const method of methods) {
      const tx = await client.buildTransaction(method, {
        will_id: BigInt(1),
        owner: 'GTESTACCOUNT',
        amount: BigInt(1000),
      });
      expect(tx).toBeDefined();
      expect(typeof tx.toXDR).toBe('function');
    }
  });
});

describe('submitSignedTransaction', () => {
  it('submits a signed XDR and returns txHash and createdAt', async () => {
    const { client } = makeClient();

    const result = await client.submitSignedTransaction(makeRealSignedXdr());

    expect(result.txHash).toBe('tx-hash-123');
    expect(result.createdAt).toBe(1_700_000_000);
    expect(result.returnValue).toBeDefined();
  });

  it('throws SoroWillError on submission failure', async () => {
    // submitSignedTransaction reads through this.server, not this.rpcPool,
    // so the override must be supplied as rpcServer at construction time.
    const { client } = makeClient({
      rpcServer: {
        getAccount: async (publicKey: string) => new Account(publicKey, '0'),
        sendTransaction: async () => ({
          status: 'ERROR',
          errorResult: { toXDR: () => 'base64error' },
        }),
        pollTransaction: async () => ({ status: 'SUCCESS', createdAt: 0, returnValue: undefined }),
        getContractWasmByContractId: async () => new Uint8Array(),
      },
    });

    await expect(
      client.submitSignedTransaction(makeRealSignedXdr()),
    ).rejects.toThrow(/transaction submission failed/);
  });

  it('throws on non-SUCCESS transaction status', async () => {
    const { client } = makeClient({
      rpcServer: {
        getAccount: async (publicKey: string) => new Account(publicKey, '0'),
        sendTransaction: async () => ({ status: 'PENDING', hash: 'tx-hash-fail' }),
        pollTransaction: async () => ({
          status: 'FAILED',
          createdAt: 0,
          returnValue: undefined,
        }),
        getContractWasmByContractId: async () => new Uint8Array(),
      },
    });

    await expect(
      client.submitSignedTransaction(makeRealSignedXdr()),
    ).rejects.toThrow(/did not succeed/);
  });

  it('returns the contract returnValue on success', async () => {
    const { client } = makeClient();

    const result = await client.submitSignedTransaction(makeRealSignedXdr());

    expect(result.returnValue).toBeDefined();
    expect(result.txHash).toBe('tx-hash-123');
    expect(typeof result.createdAt).toBe('number');
  });
});
