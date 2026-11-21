/**
 * Tests for issue #717: checkIn during the grace period must throw a clear
 * error that explains the state, shows the time remaining, suggests when to
 * check in, and includes the next check-in deadline.
 */
import { describe, expect, it, vi } from 'vitest';

import { SoroWillClient } from '../src/SoroWillClient';
import { CheckInDuringGracePeriodError } from '../src/errors';
import { WillStatus } from '../src/types';
import type { Will } from '../src/types';

const CONTRACT_ID = 'CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR';
const OWNER = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const PASSPHRASE = 'Test SDF Network ; September 2015';

const wallet = {
  async isConnected() { return true; },
  async connect() { return { publicKey: OWNER, network: 'testnet', networkPassphrase: PASSPHRASE }; },
  async reconnect() { return { publicKey: OWNER, network: 'testnet', networkPassphrase: PASSPHRASE }; },
  async disconnect() {},
  async getPublicKey() { return OWNER; },
  async signTransaction(xdr: string) { return xdr; },
  async getNetwork() { return { network: 'testnet', networkPassphrase: PASSPHRASE }; },
};

const DAY_MS = 86_400_000;

function triggeredWill(triggerTime: Date): Will {
  return {
    id: '1',
    owner: OWNER,
    token: 'native',
    balance: '1000000',
    beneficiaries: [{ address: 'GC6HGXZGSXRY2NLLRYGVHCCDNULAQ6N2QX6Q47UUW42FTH2HBAXTM2WO', percentage: 100 }],
    checkinPeriodDays: 30,
    gracePeriodDays: 7,
    lastCheckin: new Date(triggerTime.getTime() - 30 * DAY_MS),
    triggerTime,
    status: WillStatus.Triggered,
    guardians: [],
  } as unknown as Will;
}

function makeClient(will: Will) {
  const client = new SoroWillClient({
    network: 'testnet',
    contractId: CONTRACT_ID,
    readCache: false,
    wallet,
  } as never);
  vi.spyOn(client, 'getWill').mockResolvedValue(will);
  const invoke = vi.spyOn(client as never, 'invoke' as never);
  return { client, invoke };
}

describe('Issue #717: checkIn grace period error message', () => {
  it('keeps the "Cannot check in during grace period" headline', async () => {
    const { client } = makeClient(triggeredWill(new Date()));
    const err = await client.checkIn('1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CheckInDuringGracePeriodError);
    expect((err as Error).message).toContain('Cannot check in during grace period');
  });

  it('includes the grace period end time and time remaining', async () => {
    const triggerTime = new Date(Date.now() - 2 * DAY_MS); // 2 days in, 7-day grace
    const { client } = makeClient(triggeredWill(triggerTime));
    const err = (await client.checkIn('1').catch((e: unknown) => e)) as CheckInDuringGracePeriodError;

    const graceEndsAt = new Date(triggerTime.getTime() + 7 * DAY_MS);
    expect(err.graceEndsAt?.getTime()).toBe(graceEndsAt.getTime());
    expect(err.timeRemainingMs).toBeGreaterThan(4 * DAY_MS);
    expect(err.timeRemainingMs).toBeLessThanOrEqual(5 * DAY_MS);
    expect(err.message).toContain(`The grace period ends at ${graceEndsAt.toISOString()}`);
    expect(err.message).toMatch(/\(\d+ hours remaining\)/);
  });

  it('suggests checking in after the grace period ends', async () => {
    const { client } = makeClient(triggeredWill(new Date()));
    const err = (await client.checkIn('1').catch((e: unknown) => e)) as Error;
    expect(err.message).toContain('Check in after the grace period ends');
  });

  it('includes the next check-in deadline', async () => {
    const triggerTime = new Date(Date.now() - DAY_MS);
    const will = triggeredWill(triggerTime);
    const { client } = makeClient(will);
    const err = (await client.checkIn('1').catch((e: unknown) => e)) as CheckInDuringGracePeriodError;

    const expected = new Date(will.lastCheckin.getTime() + 30 * DAY_MS);
    expect(err.nextDeadline?.getTime()).toBe(expected.getTime());
    expect(err.message).toContain(`next check-in deadline is ${expected.toISOString()}`);
  });

  it('reports zero time remaining once the grace period has already ended', () => {
    const err = new CheckInDuringGracePeriodError('1', {
      graceEndsAt: new Date(Date.now() - DAY_MS),
    });
    expect(err.timeRemainingMs).toBe(0);
    expect(err.message).toContain('0 hours remaining');
  });

  it('submits no transaction when rejecting a check-in during grace', async () => {
    const { client, invoke } = makeClient(triggeredWill(new Date()));
    await expect(client.checkIn('1')).rejects.toBeInstanceOf(CheckInDuringGracePeriodError);
    expect(invoke).not.toHaveBeenCalled();
  });
});
