/**
 * Tests for issue #619: SoroWillClient doesn't implement request
 * deduplication, so identical concurrent read requests each hit the RPC node.
 *
 * Fix: concurrent reads with the same operation + params are coalesced into a
 * single simulation whose result is shared by every caller.
 */

import { describe, it, expect, vi } from 'vitest';
import { xdr } from '@stellar/stellar-sdk';
import { SoroWillClient } from '../src/SoroWillClient';

const CONTRACT_ID = 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE';

function rawWill(id: bigint) {
  return {
    id,
    owner: 'GOWNER',
    token: 'CTOKEN',
    balance: 1_000_000n,
    beneficiaries: [{ address: 'GBEN', percentage: 100 }],
    checkin_period_days: 90n,
    grace_period_days: 7n,
    last_checkin: 1_700_000_000n,
    trigger_time: undefined,
    status: 'Active',
    guardians: [],
    guardian_votes: 0,
  };
}

function makeClient(options: { deduplicateReads?: boolean; fail?: boolean } = {}) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const lastArgs: { willId?: bigint } = {};

  const simulateTransaction = vi.fn(async () => {
    await gate;
    if (options.fail) throw new Error('rpc down');
    return { result: { retval: {} } };
  });
  const spec = {
    funcArgsToScVals: (_method: string, args: { will_id?: bigint }) => {
      lastArgs.willId = args.will_id;
      return [] as xdr.ScVal[];
    },
    funcResToNative: () => rawWill(lastArgs.willId ?? 1n),
  };

  const client = new SoroWillClient({
    network: 'testnet',
    contractId: CONTRACT_ID,
    rpcServer: { simulateTransaction, getLatestLedger: async () => ({ sequence: 1 }) } as never,
    spec: spec as never,
    readCache: false,
    retry: { maxAttempts: 1 },
    ...(options.deduplicateReads === undefined ? {} : { deduplicateReads: options.deduplicateReads }),
  });

  return { client, simulateTransaction, release };
}

describe('issue #619 — read request deduplication', () => {
  it('coalesces concurrent identical reads into one RPC call', async () => {
    const { client, simulateTransaction, release } = makeClient();

    const calls = [client.getWill('1'), client.getWill('1'), client.getWill('1')];
    await vi.waitFor(() => expect(simulateTransaction).toHaveBeenCalled());
    release();
    const wills = await Promise.all(calls);

    expect(simulateTransaction).toHaveBeenCalledTimes(1);
    expect(wills.map((w) => w.id)).toEqual(['1', '1', '1']);
    // Each caller still receives its own mapped object.
    expect(wills[0]).not.toBe(wills[1]);
  });

  it('does not coalesce reads with different params', async () => {
    const { client, simulateTransaction, release } = makeClient();

    const calls = [client.getWill('1'), client.getWill('2')];
    release();
    await Promise.all(calls);

    expect(simulateTransaction).toHaveBeenCalledTimes(2);
  });

  it('issues a fresh request once the previous one has settled', async () => {
    const { client, simulateTransaction, release } = makeClient();
    release();

    await client.getWill('1');
    await client.getWill('1');

    expect(simulateTransaction).toHaveBeenCalledTimes(2);
  });

  it('shares a failure with every coalesced caller and then clears the entry', async () => {
    const { client, simulateTransaction, release } = makeClient({ fail: true });

    const calls = [client.getWill('1'), client.getWill('1')];
    release();
    const results = await Promise.allSettled(calls);

    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    expect(simulateTransaction).toHaveBeenCalledTimes(1);

    await expect(client.getWill('1')).rejects.toThrow();
    expect(simulateTransaction).toHaveBeenCalledTimes(2);
  });

  it('never coalesces reads that carry an AbortSignal', async () => {
    const { client, simulateTransaction, release } = makeClient();

    const calls = [
      client.getWill('1', { signal: new AbortController().signal }),
      client.getWill('1'),
    ];
    release();
    await Promise.all(calls);

    expect(simulateTransaction).toHaveBeenCalledTimes(2);
  });

  it('can be disabled with deduplicateReads: false', async () => {
    const { client, simulateTransaction, release } = makeClient({ deduplicateReads: false });

    const calls = [client.getWill('1'), client.getWill('1')];
    release();
    await Promise.all(calls);

    expect(simulateTransaction).toHaveBeenCalledTimes(2);
  });
});
