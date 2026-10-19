import { xdr } from '@stellar/stellar-sdk';
import { describe, expect, it, vi } from 'vitest';
import { InFlightTracker } from '../src/inFlightTracker';
import { SoroWillClient, type SoroWillRpcServer } from '../src/SoroWillClient';
import { WillStatus } from '../src/types';

const CONTRACT_ID = 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE';

function rawWill(id: number) {
  return {
    id: BigInt(id),
    owner: `GOWNER${id}`,
    token: `CTOKEN${id}`,
    balance: 1_000_000n * BigInt(id),
    beneficiaries: [{ address: `GBEN${id}`, percentage: 100 }],
    checkin_period_days: 90n,
    grace_period_days: 7n,
    last_checkin: 1_700_000_000n,
    trigger_time: undefined,
    status: WillStatus.Active,
    guardians: [],
    guardian_votes: 0,
  };
}

function makeFakeSpec() {
  return {
    funcArgsToScVals: (_method: string, _args: Record<string, unknown>) => [xdr.ScVal.scvVoid()],
    funcResToNative: (_method: string, value: unknown) => value,
  };
}

function makeMockRpcServer(
  simulateImpl: SoroWillRpcServer['simulateTransaction'],
): SoroWillRpcServer {
  return {
    getContractWasmByContractId: vi.fn(),
    simulateTransaction: simulateImpl,
    getAccount: vi.fn(),
    prepareTransaction: vi.fn(),
    sendTransaction: vi.fn(),
    pollTransaction: vi.fn(),
  };
}

describe('SoroWillClient read request deduplication (#619)', () => {
  it('coalesces concurrent identical getWill calls into a single RPC simulation', async () => {
    let resolveSim!: (val: unknown) => void;
    const simulateTransaction = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveSim = resolve;
        }),
    ) as unknown as SoroWillRpcServer['simulateTransaction'];

    const client = new SoroWillClient({
      network: 'testnet',
      contractId: CONTRACT_ID,
      rpcServer: makeMockRpcServer(simulateTransaction),
      spec: makeFakeSpec(),
      readCache: false,
    });

    const p1 = client.getWill('1');
    const p2 = client.getWill('1');
    const p3 = client.getWill('001'); // canonicalizes to '1'

    await vi.waitFor(() => {
      expect(simulateTransaction).toHaveBeenCalledTimes(1);
    });

    resolveSim({ result: { retval: rawWill(1) } });

    const [w1, w2, w3] = await Promise.all([p1, p2, p3]);
    expect(w1.id).toBe('1');
    expect(w2.id).toBe('1');
    expect(w3.id).toBe('1');
    expect(simulateTransaction).toHaveBeenCalledTimes(1);
  });

  it('does not coalesce concurrent getWill calls for different willIds', async () => {
    const simulateTransaction = vi.fn(async () => ({
      result: { retval: rawWill(1) },
    })) as unknown as SoroWillRpcServer['simulateTransaction'];

    const client = new SoroWillClient({
      network: 'testnet',
      contractId: CONTRACT_ID,
      rpcServer: makeMockRpcServer(simulateTransaction),
      spec: makeFakeSpec(),
      readCache: false,
    });

    await Promise.all([client.getWill('1'), client.getWill('2')]);
    expect(simulateTransaction).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent identical getWillsByOwner and getWillsByBeneficiary calls', async () => {
    let resolveOwnerSim!: (val: unknown) => void;
    let resolveBenSim!: (val: unknown) => void;
    let callIdx = 0;

    const simulateTransaction = vi.fn(() => {
      callIdx += 1;
      if (callIdx === 1) {
        return new Promise((resolve) => {
          resolveOwnerSim = resolve;
        });
      }
      return new Promise((resolve) => {
        resolveBenSim = resolve;
      });
    }) as unknown as SoroWillRpcServer['simulateTransaction'];

    const client = new SoroWillClient({
      network: 'testnet',
      contractId: CONTRACT_ID,
      rpcServer: makeMockRpcServer(simulateTransaction),
      spec: makeFakeSpec(),
      readCache: false,
    });

    const ownerP1 = client.getWillsByOwner('GOWNER1');
    const ownerP2 = client.getWillsByOwner('GOWNER1', { pageSize: 1 });
    const benP1 = client.getWillsByBeneficiary('GBEN1');
    const benP2 = client.getWillsByBeneficiary('GBEN1');

    await vi.waitFor(() => {
      expect(simulateTransaction).toHaveBeenCalledTimes(2);
    });

    resolveOwnerSim({ result: { retval: [rawWill(1), rawWill(2)] } });
    resolveBenSim({ result: { retval: [rawWill(1)] } });

    const [o1, o2, b1, b2] = await Promise.all([ownerP1, ownerP2, benP1, benP2]);
    expect(Array.isArray(o1) ? o1.length : 0).toBe(2);
    expect(!Array.isArray(o2) ? o2.wills.length : 0).toBe(1);
    expect(Array.isArray(b1) ? b1.length : 0).toBe(1);
    expect(Array.isArray(b2) ? b2.length : 0).toBe(1);
    expect(simulateTransaction).toHaveBeenCalledTimes(2);
  });

  it('clears in-flight entry after settlement so subsequent reads issue a fresh call when cache is disabled', async () => {
    const simulateTransaction = vi.fn(async () => ({
      result: { retval: rawWill(1) },
    })) as unknown as SoroWillRpcServer['simulateTransaction'];

    const client = new SoroWillClient({
      network: 'testnet',
      contractId: CONTRACT_ID,
      rpcServer: makeMockRpcServer(simulateTransaction),
      spec: makeFakeSpec(),
      readCache: false,
    });

    await client.getWill('1');
    await client.getWill('1');
    expect(simulateTransaction).toHaveBeenCalledTimes(2);
  });

  it('deduplicates concurrent reads across client instances sharing an InFlightTracker', async () => {
    const sharedTracker = new InFlightTracker(CONTRACT_ID);
    let resolveSim!: (val: unknown) => void;
    const simulateTransaction = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveSim = resolve;
        }),
    ) as unknown as SoroWillRpcServer['simulateTransaction'];

    const server = makeMockRpcServer(simulateTransaction);
    const clientA = new SoroWillClient({
      network: 'testnet',
      contractId: CONTRACT_ID,
      rpcServer: server,
      spec: makeFakeSpec(),
      readCache: false,
      inFlightTracker: sharedTracker,
    });
    const clientB = new SoroWillClient({
      network: 'testnet',
      contractId: CONTRACT_ID,
      rpcServer: server,
      spec: makeFakeSpec(),
      readCache: false,
      inFlightTracker: sharedTracker,
    });

    const pA = clientA.getWill('7');
    const pB = clientB.getWill('7');

    await vi.waitFor(() => {
      expect(simulateTransaction).toHaveBeenCalledTimes(1);
    });

    resolveSim({ result: { retval: rawWill(7) } });
    const [resA, resB] = await Promise.all([pA, pB]);
    expect(resA.id).toBe('7');
    expect(resB.id).toBe('7');
  });
});
