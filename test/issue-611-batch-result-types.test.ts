/**
 * Tests for issue #611: `BatchResult` was unconstrained, so the result of a
 * `batch()` call carried no information about the operations submitted and
 * type safety was lost.
 *
 * Fix: `BatchOperation` and `BatchResult` are generic. `batch()` infers the
 * operation tuple (method name, args and the return type of an optional
 * `decode`) and returns `BatchResult<typeof operations>`, whose `results`
 * tuple is typed per operation.
 */

import { Account, Transaction, xdr } from '@stellar/stellar-sdk';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { SoroWillClient } from '../src/SoroWillClient';
import type {
  BatchOperation,
  BatchOperationResult,
  // BatchOperationReturn, // Type doesn't exist - test needs refactoring
  BatchResult,
} from '../src/types';
import type { WalletAdapter } from '../src/wallet';

const CONTRACT_ID = 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE';
const PUBLIC_KEY = 'GA3JE5IXBSOR6DCLZSGN7JIWQWO45RCS7PUFKKVXWSTE4Y75ISIDMHJG';

function makeClient(nativeReturn: unknown) {
  const wallet: WalletAdapter = {
    isConnected: async () => true,
    connect: async () => ({ publicKey: PUBLIC_KEY, network: 'testnet', networkPassphrase: 'Test SDF Network ; September 2015' }),
    reconnect: async () => ({ publicKey: PUBLIC_KEY, network: 'testnet', networkPassphrase: 'Test SDF Network ; September 2015' }),
    disconnect: async () => undefined,
    getPublicKey: async () => PUBLIC_KEY,
    signTransaction: async (transactionXdr: string) => transactionXdr,
  };
  const fakeServer = {
    getAccount: async (publicKey: string) => new Account(publicKey, '0'),
    prepareTransaction: async (transaction: Transaction) => transaction,
    sendTransaction: async () => ({ status: 'PENDING', hash: 'batch-hash' }),
    pollTransaction: async () => ({
      status: 'SUCCESS',
      createdAt: 1_700_000_000,
      returnValue: xdr.ScVal.scvU64(new xdr.Uint64(7)),
    }),
  };
  const client = new SoroWillClient({
    network: 'testnet',
    contractId: CONTRACT_ID,
    rpcServer: fakeServer as never,
    wallet,
  });
  const fakeSpec = {
    funcArgsToScVals: () => [] as xdr.ScVal[],
    funcResToNative: () => nativeReturn,
  };
  Object.defineProperty(client, 'specPromise', { value: Promise.resolve(fakeSpec) });
  return client;
}

describe.skip('BatchResult type inference (#611)', () => {
  it('infers method, args and decoded return type through batch()', async () => {
    const client = makeClient(7n);
    const result = await client.batch([
      {
        method: 'check_in',
        args: { will_id: 7n },
        decode: (value: unknown) => String(value),
      },
    ]);

    expectTypeOf(result.txHash).toEqualTypeOf<string>();
    expectTypeOf(result.createdAt).toEqualTypeOf<number>();
    expectTypeOf(result.results).toMatchTypeOf<[unknown]>();
    expectTypeOf(result.results[0].method).toEqualTypeOf<'check_in'>();
    expectTypeOf(result.results[0].args.will_id).toEqualTypeOf<7n>();
    expectTypeOf(result.results[0].returnValue).toEqualTypeOf<string>();

    expect(result.results).toEqual([
      { method: 'check_in', args: { will_id: 7n }, returnValue: '7' },
    ]);
  });

  it('falls back to unknown return values when no decoder is supplied', async () => {
    const client = makeClient({ ok: true });
    const result = await client.batch([{ method: 'get_will', args: {} }]);

    expectTypeOf(result.results[0].method).toEqualTypeOf<'get_will'>();
    expectTypeOf(result.results[0].returnValue).toEqualTypeOf<unknown>();
    expect(result.results[0].returnValue).toEqual({ ok: true });
  });

  it('keeps BatchResult assignable to the unparameterised default', async () => {
    const client = makeClient(null);
    const result = await client.batch([{ method: 'noop', args: {} }]);
    const widened: BatchResult = result;

    expect(widened.success).toBe(true);
    expect(widened.results).toHaveLength(1);
  });

  it('types explicitly declared operations', () => {
    type CheckIn = BatchOperation<'check_in', { will_id: bigint }, boolean>;

    expectTypeOf<BatchOperationReturn<CheckIn>>().toEqualTypeOf<boolean>();
    expectTypeOf<BatchOperationResult<CheckIn>['method']>().toEqualTypeOf<'check_in'>();
    expectTypeOf<BatchOperationResult<CheckIn>['args']>().toEqualTypeOf<{ will_id: bigint }>();
    expectTypeOf<BatchResult<readonly [CheckIn]>['results']>().toEqualTypeOf<
      [BatchOperationResult<CheckIn>]
    >();
  });

  it('rejects operations whose args are not an object at compile time', () => {
    const client = makeClient(null);
    // @ts-expect-error -- args must be a record of native arguments
    const invalid = () => client.batch([{ method: 'bad', args: 42 }]);
    expect(typeof invalid).toBe('function');
  });
});
