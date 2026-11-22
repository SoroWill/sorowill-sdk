/**
 * Issue #714 — Duplicate request deduplication doesn't work.
 *
 * Acceptance criteria:
 * - Identical requests deduplicated
 * - Single RPC call per unique request
 * - Shared response returned to both callers
 * - Timing window for dedup is 500ms
 */
import { describe, expect, it, vi } from 'vitest';
import { xdr } from '@stellar/stellar-sdk';
import { SoroWillClient } from '../src/SoroWillClient';

const CONTRACT_ID = 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE';
const OWNER = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

function rawWill(id: bigint) {
  return {
    id,
    owner: OWNER,
    token: CONTRACT_ID,
    balance: 1_000_000n,
    beneficiaries: [{ address: 'GA3JE5IXBSOR6DCLZSGN7JIWQWO45RCS7PUFKKVXWSTE4Y75ISIDMHJG', percentage: 100 }],
    checkin_period_days: 90n,
    grace_period_days: 7n,
    last_checkin: 1_700_000_000n,
    trigger_time: undefined,
    status: 'Active',
    guardians: [],
    guardian_votes: 0,
  };
}

function makeClient() {
  const lastWillId: { value: bigint } = { value: 1n };
  const simulateTransaction = vi.fn(async () => ({ result: { retval: {} } }));
  const spec = {
    funcArgsToScVals: (_m: string, args: { will_id?: bigint }) => {
      lastWillId.value = args.will_id ?? 1n;
      return [] as xdr.ScVal[];
    },
    funcResToNative: () => rawWill(lastWillId.value),
  };
  const client = new SoroWillClient({
    network: 'testnet',
    contractId: CONTRACT_ID,
    rpcServer: { simulateTransaction, getLatestLedger: async () => ({ sequence: 1 }) } as never,
    spec: spec as never,
    readCache: false,
    retry: { maxAttempts: 1 },
  });
  return { client, simulateTransaction };
}

describe('Issue #714 — request deduplication', () => {
  it('identical concurrent requests produce a single RPC call and share the response', async () => {
    const { client, simulateTransaction } = makeClient();

    const [a, b] = await Promise.all([client.getWill('7'), client.getWill('7')]);

    expect(simulateTransaction).toHaveBeenCalledTimes(1);
    expect(a.id).toBe('7');
    expect(b.id).toBe('7');
  });

  it('identical requests inside the 500ms window are deduplicated', async () => {
    const { client, simulateTransaction } = makeClient();

    await client.getWill('8');
    await new Promise((resolve) => setTimeout(resolve, 100));
    await client.getWill('8');

    expect(simulateTransaction).toHaveBeenCalledTimes(1);
  });

  it('identical requests after the 500ms window issue a new RPC call', async () => {
    const { client, simulateTransaction } = makeClient();

    await client.getWill('9');
    await new Promise((resolve) => setTimeout(resolve, 550));
    await client.getWill('9');

    expect(simulateTransaction).toHaveBeenCalledTimes(2);
  });
});
