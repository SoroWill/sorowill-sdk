/**
 * Tests for issue #718: createWill must reject a grace period larger than the
 * check-in period before any wallet or network interaction.
 */
import { describe, expect, it, vi } from 'vitest';

import { SoroWillClient } from '../src/SoroWillClient';
import { GracePeriodExceedsCheckinPeriodError, InvalidDayCountError } from '../src/errors';

const CONTRACT_ID = 'CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR';
const OWNER = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const BENEFICIARY = 'GC6HGXZGSXRY2NLLRYGVHCCDNULAQ6N2QX6Q47UUW42FTH2HBAXTM2WO';
const TOKEN = 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE';
const PASSPHRASE = 'Test SDF Network ; September 2015';

function makeClient() {
  const wallet = {
    isConnected: vi.fn(async () => true),
    connect: vi.fn(),
    reconnect: vi.fn(),
    disconnect: vi.fn(),
    getPublicKey: vi.fn(async () => OWNER),
    signTransaction: vi.fn(async (xdr: string) => xdr),
    getNetwork: vi.fn(async () => ({ network: 'testnet', networkPassphrase: PASSPHRASE })),
  };
  const client = new SoroWillClient({
    network: 'testnet',
    contractId: CONTRACT_ID,
    readCache: false,
    wallet,
  } as never);
  return { client, wallet };
}

function params(overrides: Partial<{ gracePeriodDays: number; checkinPeriodDays: number }> = {}) {
  return {
    token: TOKEN,
    amount: 1_000_000n,
    beneficiaries: [{ address: BENEFICIARY, percentage: 100 }],
    checkinPeriodDays: 30,
    gracePeriodDays: 7,
    guardians: [],
    ...overrides,
  } as never;
}

describe('Issue #718: grace period must not exceed check-in period', () => {
  it('rejects gracePeriodDays > checkinPeriodDays', async () => {
    const { client } = makeClient();
    const err = await client
      .createWill(params({ gracePeriodDays: 31, checkinPeriodDays: 30 }))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GracePeriodExceedsCheckinPeriodError);
    expect((err as Error).message).toContain('less than or equal to checkinPeriodDays (30)');
  });

  it('exposes the offending values on the error', async () => {
    const { client } = makeClient();
    const err = (await client
      .createWill(params({ gracePeriodDays: 45, checkinPeriodDays: 30 }))
      .catch((e: unknown) => e)) as GracePeriodExceedsCheckinPeriodError;
    expect(err.gracePeriodDays).toBe(45);
    expect(err.checkinPeriodDays).toBe(30);
  });

  it('rejects before any wallet call is made', async () => {
    const { client, wallet } = makeClient();
    await expect(
      client.createWill(params({ gracePeriodDays: 31, checkinPeriodDays: 30 })),
    ).rejects.toBeInstanceOf(GracePeriodExceedsCheckinPeriodError);
    expect(wallet.getPublicKey).not.toHaveBeenCalled();
    expect(wallet.signTransaction).not.toHaveBeenCalled();
  });

  it('accepts gracePeriodDays equal to checkinPeriodDays (boundary)', async () => {
    const { client } = makeClient();
    const err = await client
      .createWill(params({ gracePeriodDays: 30, checkinPeriodDays: 30 }))
      .catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(GracePeriodExceedsCheckinPeriodError);
  });

  it('still reports invalid day counts with InvalidDayCountError', async () => {
    const { client } = makeClient();
    await expect(
      client.createWill(params({ gracePeriodDays: 0, checkinPeriodDays: 30 })),
    ).rejects.toBeInstanceOf(InvalidDayCountError);
  });
});
