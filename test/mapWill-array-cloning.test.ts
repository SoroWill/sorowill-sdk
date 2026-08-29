import { describe, expect, it, vi } from 'vitest';
import { SoroWillClient } from '../src/index';
import { xdr } from '@stellar/stellar-sdk';

describe('mapWill array cloning (issue #187)', () => {
  it('returns shallow copies of beneficiaries array to prevent mutation of cached values', async () => {
    // Create a stub spec that returns a will with mutable arrays
    const rawWill = {
      id: 1n,
      owner: 'GOWNER',
      token: 'CTOKEN',
      balance: 1_000_000n,
      beneficiaries: [{ address: 'GBEN1', percentage: 60 }, { address: 'GBEN2', percentage: 40 }],
      checkin_period_days: 90n,
      grace_period_days: 7n,
      last_checkin: 1_700_000_000n,
      trigger_time: undefined,
      status: 'Active',
      guardians: ['GGUARD1', 'GGUARD2'],
      guardian_votes: 0,
    };

    const fakeSpec = {
      funcArgsToScVals: () => [] as xdr.ScVal[],
      funcResToNative: (_method: string, _value: unknown) => rawWill,
    };

    const fakeServer = {
      simulateTransaction: async () => ({
        result: {
          retval: rawWill,
        },
      }),
      getLatestLedger: async () => ({ sequence: '123' }),
    };

    // Mock the Spec loading
    vi.mock('@stellar/stellar-sdk', async () => {
      const actual = await vi.importActual('@stellar/stellar-sdk');
      return {
        ...(actual as Record<string, unknown>),
        contract: {
          Spec: {
            fromWasm: vi.fn().mockResolvedValue(fakeSpec),
          },
        },
      };
    });

    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
      rpcServer: fakeServer as any,
      spec: fakeSpec as any,
    });

    // Get a will - this calls mapWill internally
    const will1 = await client.getWill('1');

    // Mutate the beneficiaries array from the first call
    will1.beneficiaries.push({ address: 'GBEN3', percentage: 100 });
    will1.guardians.push('GGUARD3');

    // Get the same will again - if arrays were properly cloned,
    // this should not include our pushed elements
    const will2 = await client.getWill('1');

    expect(will2.beneficiaries).toHaveLength(2);
    expect(will2.beneficiaries.map((b) => b.address)).toEqual(['GBEN1', 'GBEN2']);
    expect(will2.guardians).toHaveLength(2);
    expect(will2.guardians).toEqual(['GGUARD1', 'GGUARD2']);
  });

  it('returns independent array instances across multiple calls', async () => {
    const rawWill = {
      id: 1n,
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

    const fakeSpec = {
      funcArgsToScVals: () => [] as xdr.ScVal[],
      funcResToNative: (_method: string, _value: unknown) => rawWill,
    };

    const fakeServer = {
      simulateTransaction: async () => ({
        result: {
          retval: rawWill,
        },
      }),
      getLatestLedger: async () => ({ sequence: '123' }),
    };

    vi.mock('@stellar/stellar-sdk', async () => {
      const actual = await vi.importActual('@stellar/stellar-sdk');
      return {
        ...(actual as Record<string, unknown>),
        contract: {
          Spec: {
            fromWasm: vi.fn().mockResolvedValue(fakeSpec),
          },
        },
      };
    });

    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
      rpcServer: fakeServer as any,
      spec: fakeSpec as any,
    });

    const will1 = await client.getWill('1');
    const will2 = await client.getWill('1');

    // Arrays should be independent instances
    expect(will1.beneficiaries).not.toBe(will2.beneficiaries);
    expect(will1.guardians).not.toBe(will2.guardians);

    // But contents should be equal
    expect(will1.beneficiaries).toEqual(will2.beneficiaries);
    expect(will1.guardians).toEqual(will2.guardians);
  });
});
