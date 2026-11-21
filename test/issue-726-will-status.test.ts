import { xdr } from '@stellar/stellar-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SoroWillClient, type SoroWillRpcServer } from '../src/SoroWillClient';
import { WillStatus } from '../src/types';

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

/** Stubs the contract read so `read('get_will')` yields a raw will with `status`. */
function stubWillRead(client: SoroWillClient, status: WillStatus) {
  const read = vi.spyOn(client as unknown as { read: (...args: unknown[]) => Promise<unknown> }, 'read');
  read.mockImplementation(async () => ({
    id: 1n,
    owner: TEST_ACCOUNT,
    token: 'CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR',
    balance: 0n,
    beneficiaries: [],
    checkin_period_days: 30n,
    grace_period_days: 7n,
    last_checkin: 1_700_000_000n,
    trigger_time: 0n,
    status,
    guardians: [],
    guardian_votes: 0,
  }));
  return read;
}

describe('Issue #726: willStatus returns status only', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the will status', async () => {
    const { client } = makeClient();
    stubWillRead(client, WillStatus.Triggered);

    await expect(client.willStatus('1')).resolves.toBe(WillStatus.Triggered);
  });

  it('serves repeated calls within 30 seconds from cache without another RPC read', async () => {
    const { client } = makeClient();
    const read = stubWillRead(client, WillStatus.Active);

    await client.willStatus('1');
    await client.willStatus('1');
    await client.willStatus('1');

    expect(read).toHaveBeenCalledTimes(1);
  });

  it('re-reads once the 30 second TTL has expired', async () => {
    vi.useFakeTimers();
    const { client } = makeClient();
    const read = stubWillRead(client, WillStatus.Active);

    await client.willStatus('1');
    vi.advanceTimersByTime(30_001);
    await client.willStatus('1');

    expect(read).toHaveBeenCalledTimes(2);
  });

  it('caches per will id', async () => {
    const { client } = makeClient();
    const read = stubWillRead(client, WillStatus.Active);

    await client.willStatus('1');
    await client.willStatus('2');

    expect(read).toHaveBeenCalledTimes(2);
  });

  it('rejects an invalid will id before any RPC call', async () => {
    const { client, rpcServer } = makeClient();

    await expect(client.willStatus('not-a-number')).rejects.toThrow();
    expect(rpcServer.simulateTransaction).not.toHaveBeenCalled();
  });
});
