import { xdr } from '@stellar/stellar-sdk';
import { describe, expect, it, vi } from 'vitest';

import { SoroWillClient, type SoroWillRpcServer } from '../src/SoroWillClient';
import { SoroWillError } from '../src/errors';

const TEST_ACCOUNT = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';

function makeClient() {
  const rpcServer = {
    getContractWasmByContractId: vi.fn(async () => new Uint8Array()),
    simulateTransaction: vi.fn(async () => ({ result: { retval: xdr.ScVal.scvVoid() } }) as never),
  };
  const connection = { publicKey: TEST_ACCOUNT, network: 'testnet', networkPassphrase: NETWORK_PASSPHRASE };
  const client = new SoroWillClient({
    network: 'testnet',
    contractId: 'CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR',
    wallet: {
      isConnected: vi.fn(async () => true),
      connect: vi.fn(async () => connection),
      reconnect: vi.fn(async () => connection),
      disconnect: vi.fn(async () => {}),
      getPublicKey: vi.fn(async () => TEST_ACCOUNT),
      signTransaction: vi.fn(async (xdrString: string) => xdrString),
    },
    readCache: false,
    spec: { funcArgsToScVals: () => [] as xdr.ScVal[], funcResToNative: () => undefined },
    rpcServer: rpcServer as unknown as SoroWillRpcServer,
  });
  return { client, rpcServer };
}

const CREATE_PARAMS = {
  token: 'CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR',
  amount: '1000',
  beneficiaries: [],
  checkinPeriodDays: 30,
  gracePeriodDays: 7,
  guardians: [],
} as unknown as Parameters<SoroWillClient['createWill']>[0];

describe('Issue #727: batch operations for multiple wills', () => {
  describe('batchCreateWill', () => {
    it('creates each will in input order and returns each result', async () => {
      const { client } = makeClient();
      const createWill = vi
        .spyOn(client, 'createWill')
        .mockResolvedValueOnce({ willId: '1', txHash: 'h1' })
        .mockResolvedValueOnce({ willId: '2', txHash: 'h2' });

      const results = await client.batchCreateWill([CREATE_PARAMS, CREATE_PARAMS]);

      expect(createWill).toHaveBeenCalledTimes(2);
      expect(results).toEqual([
        { index: 0, status: 'success', value: { willId: '1', txHash: 'h1' } },
        { index: 1, status: 'success', value: { willId: '2', txHash: 'h2' } },
      ]);
    });

    it('keeps going after a failure and reports the error at the failed index', async () => {
      const { client } = makeClient();
      const failure = new SoroWillError('boom');
      vi.spyOn(client, 'createWill')
        .mockResolvedValueOnce({ willId: '1', txHash: 'h1' })
        .mockRejectedValueOnce(failure)
        .mockResolvedValueOnce({ willId: '3', txHash: 'h3' });

      const results = await client.batchCreateWill([CREATE_PARAMS, CREATE_PARAMS, CREATE_PARAMS]);

      expect(results[0]).toEqual({ index: 0, status: 'success', value: { willId: '1', txHash: 'h1' } });
      expect(results[1]).toEqual({ index: 1, status: 'error', error: failure });
      expect(results[2]).toEqual({ index: 2, status: 'success', value: { willId: '3', txHash: 'h3' } });
    });

    it('wraps non-Error rejections in a SoroWillError', async () => {
      const { client } = makeClient();
      vi.spyOn(client, 'createWill').mockRejectedValueOnce('string failure');

      const [result] = await client.batchCreateWill([CREATE_PARAMS]);

      expect(result?.status).toBe('error');
      expect(result && result.status === 'error' && result.error).toBeInstanceOf(SoroWillError);
    });

    it.each([
      ['an empty list', 0],
      ['more than 25 entries', 26],
    ])('rejects %s before submitting anything', async (_label, size) => {
      const { client } = makeClient();
      const createWill = vi.spyOn(client, 'createWill');

      await expect(client.batchCreateWill(Array(size).fill(CREATE_PARAMS))).rejects.toBeInstanceOf(SoroWillError);
      expect(createWill).not.toHaveBeenCalled();
    });
  });

  describe('batchCheckIn', () => {
    it('checks in each will and returns results in input order', async () => {
      const { client } = makeClient();
      const deadline = new Date('2030-01-01T00:00:00Z');
      const checkIn = vi
        .spyOn(client, 'checkIn')
        .mockResolvedValue({ txHash: 'c1', nextDeadline: deadline });

      const results = await client.batchCheckIn(['1', '2']);

      expect(checkIn).toHaveBeenNthCalledWith(1, '1', undefined);
      expect(checkIn).toHaveBeenNthCalledWith(2, '2', undefined);
      expect(results).toEqual([
        { index: 0, status: 'success', value: { txHash: 'c1', nextDeadline: deadline } },
        { index: 1, status: 'success', value: { txHash: 'c1', nextDeadline: deadline } },
      ]);
    });

    it('reports a failed will without stopping the rest of the batch', async () => {
      const { client } = makeClient();
      const failure = new SoroWillError('not active');
      vi.spyOn(client, 'checkIn')
        .mockRejectedValueOnce(failure)
        .mockResolvedValueOnce({ txHash: 'c2', nextDeadline: new Date(0) });

      const results = await client.batchCheckIn(['1', '2']);

      expect(results[0]).toEqual({ index: 0, status: 'error', error: failure });
      expect(results[1]?.status).toBe('success');
    });

    it('validates every will id before submitting any check-in', async () => {
      const { client } = makeClient();
      const checkIn = vi.spyOn(client, 'checkIn');

      await expect(client.batchCheckIn(['1', 'not-an-id'])).rejects.toThrow();
      expect(checkIn).not.toHaveBeenCalled();
    });

    it('rejects an empty list', async () => {
      const { client } = makeClient();
      await expect(client.batchCheckIn([])).rejects.toBeInstanceOf(SoroWillError);
    });
  });
});
