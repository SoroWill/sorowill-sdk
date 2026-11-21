import { xdr } from '@stellar/stellar-sdk';
import { describe, expect, it, vi } from 'vitest';

import { SoroWillClient, type SoroWillRpcServer } from '../src/SoroWillClient';
import { WillStatus } from '../src/types';

const TEST_ACCOUNT = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';
const CREATED_AT = 1_700_000_000;

function makeClient() {
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
    rpcServer: {} as unknown as SoroWillRpcServer,
  });
  // Bypass network I/O: the invoke result and the decoded refund are stubbed.
  const invoke = vi
    .spyOn(client as unknown as { invoke: (...args: unknown[]) => Promise<unknown> }, 'invoke')
    .mockResolvedValue({ txHash: 'cancel-hash', createdAt: CREATED_AT, returnValue: xdr.ScVal.scvVoid() });
  vi.spyOn(client as unknown as { assertWalletNetwork: () => Promise<void> }, 'assertWalletNetwork').mockResolvedValue();
  vi.spyOn(client as unknown as { getSpec: () => Promise<unknown> }, 'getSpec').mockResolvedValue({
    funcResToNative: () => 500n,
  });
  return { client, invoke };
}

describe('Issue #728: cancelWill returns confirmation data', () => {
  it('returns the transaction hash', async () => {
    const { client } = makeClient();
    const result = await client.cancelWill('1');
    expect(result.txHash).toBe('cancel-hash');
  });

  it('returns the refunded amount as a string', async () => {
    const { client } = makeClient();
    const result = await client.cancelWill('1');
    expect(result.refundAmount).toBe('500');
  });

  it('returns the confirmation time from the ledger timestamp', async () => {
    const { client } = makeClient();
    const result = await client.cancelWill('1');
    expect(result.confirmedAt).toBeInstanceOf(Date);
    expect(result.confirmedAt.getTime()).toBe(CREATED_AT * 1000);
  });

  it('reports the will as closed', async () => {
    const { client } = makeClient();
    const result = await client.cancelWill('1');
    expect(result.willClosed).toBe(true);
  });

  it('includes a success message with the hash, refund and confirmation time', async () => {
    const { client } = makeClient();
    const result = await client.cancelWill('1');
    expect(result.message).toContain('Will 1 cancelled');
    expect(result.message).toContain('Refunded 500');
    expect(result.message).toContain('cancel-hash');
    expect(result.message).toContain(new Date(CREATED_AT * 1000).toISOString());
  });

  it('falls back to the will balance when the contract returns no refund value', async () => {
    const { client, invoke } = makeClient();
    invoke.mockResolvedValueOnce({ txHash: 'cancel-hash', createdAt: CREATED_AT, returnValue: undefined });
    vi.spyOn(client, 'getWill').mockResolvedValue({ balance: '42' } as never);

    const result = await client.cancelWill('1');

    expect(result.refundAmount).toBe('42');
    expect(result.willClosed).toBe(true);
  });

  it('clears the cached will status so the next willStatus call reads the closed will', async () => {
    const { client } = makeClient();
    const read = vi
      .spyOn(client as unknown as { read: (...args: unknown[]) => Promise<unknown> }, 'read')
      .mockResolvedValue({
        id: 1n,
        owner: TEST_ACCOUNT,
        token: 'CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR',
        balance: 0n,
        beneficiaries: [],
        checkin_period_days: 30n,
        grace_period_days: 7n,
        last_checkin: 1_700_000_000n,
        trigger_time: 0n,
        status: WillStatus.Active,
        guardians: [],
        guardian_votes: 0,
      });

    await client.willStatus('1');
    await client.cancelWill('1');
    await client.willStatus('1');

    expect(read).toHaveBeenCalledTimes(2);
  });
});
