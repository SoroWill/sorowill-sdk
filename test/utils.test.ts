import { describe, expect, it } from 'vitest';

import { getNextActionableState, isBeneficiary, isGuardian } from '../src/utils';
import { WillStatus, type Will } from '../src/types';

function makeWill(overrides: Partial<Will> = {}): Will {
  return {
    id: '1',
    owner: 'GOWNER',
    token: 'CABC',
    balance: '1000000000',
    beneficiaries: [{ address: 'GBEN', percentage: 100 }],
    checkinPeriodDays: 90,
    gracePeriodDays: 7,
    lastCheckin: new Date(),
    triggerTime: null,
    status: WillStatus.Active,
    guardians: ['GGUARD'],
    guardianVotes: 0,
    ...overrides,
  };
}

describe('isGuardian', () => {
  it('returns true for an address in the guardians list', () => {
    const will = makeWill({ guardians: ['GGUARD_A', 'GGUARD_B'] });
    expect(isGuardian(will, 'GGUARD_A')).toBe(true);
  });

  it('returns false for an address not in the guardians list', () => {
    const will = makeWill({ guardians: ['GGUARD_A'] });
    expect(isGuardian(will, 'GUNRELATED')).toBe(false);
  });

  it('returns false when the will has no guardians', () => {
    const will = makeWill({ guardians: [] });
    expect(isGuardian(will, 'GGUARD_A')).toBe(false);
  });
});

describe('isBeneficiary', () => {
  it('returns true for an address in the beneficiaries list', () => {
    const will = makeWill({
      beneficiaries: [
        { address: 'GBEN_A', percentage: 60 },
        { address: 'GBEN_B', percentage: 40 },
      ],
    });
    expect(isBeneficiary(will, 'GBEN_B')).toBe(true);
  });

  it('returns false for an address not in the beneficiaries list', () => {
    const will = makeWill({ beneficiaries: [{ address: 'GBEN_A', percentage: 100 }] });
    expect(isBeneficiary(will, 'GUNRELATED')).toBe(false);
  });
});

describe('getNextActionableState', () => {
  it('lets the owner check in and cancel an active will', () => {
    const will = makeWill({ status: WillStatus.Active, lastCheckin: new Date() });
    expect(getNextActionableState(will, 'GOWNER')).toEqual({
      canCheckIn: true,
      canTrigger: false,
      canEmergencyCheckIn: false,
      canRelease: false,
      canCancel: true,
      canGuardianVote: false,
    });
  });

  it('lets anyone trigger an active will once check-in is overdue', () => {
    const overdueCheckin = new Date(Date.now() - 100 * 86_400 * 1000);
    const will = makeWill({
      status: WillStatus.Active,
      checkinPeriodDays: 90,
      lastCheckin: overdueCheckin,
    });

    expect(getNextActionableState(will, 'GOWNER').canTrigger).toBe(true);
    expect(getNextActionableState(will, 'GUNRELATED').canTrigger).toBe(true);
  });

  it('lets a guardian vote on an active will', () => {
    const will = makeWill({ status: WillStatus.Active, guardians: ['GGUARD'] });
    expect(getNextActionableState(will, 'GGUARD').canGuardianVote).toBe(true);
    expect(getNextActionableState(will, 'GBEN').canGuardianVote).toBe(false);
  });

  it('can reflect that the guardian already voted', () => {
    const will = makeWill({ status: WillStatus.Active, guardians: ['GGUARD'] });
    expect(
      getNextActionableState(will, 'GGUARD', { guardianAlreadyVoted: true }).canGuardianVote,
    ).toBe(false);
  });

  it('lets the owner emergency-check-in during the grace period, but not after it expires', () => {
    const triggerTime = new Date(Date.now() - 3 * 86_400 * 1000);
    const withinGrace = makeWill({
      status: WillStatus.Triggered,
      gracePeriodDays: 7,
      triggerTime,
    });
    expect(getNextActionableState(withinGrace, 'GOWNER').canEmergencyCheckIn).toBe(true);

    const expiredGrace = makeWill({
      status: WillStatus.Triggered,
      gracePeriodDays: 1,
      triggerTime,
    });
    expect(getNextActionableState(expiredGrace, 'GOWNER').canEmergencyCheckIn).toBe(false);
  });

  it('allows release only once triggered and the grace period has expired, for any address', () => {
    const triggerTime = new Date(Date.now() - 10 * 86_400 * 1000);
    const will = makeWill({ status: WillStatus.Triggered, gracePeriodDays: 7, triggerTime });

    expect(getNextActionableState(will, 'GBEN').canRelease).toBe(true);
    expect(getNextActionableState(will, 'GUNRELATED').canRelease).toBe(true);
  });

  it('disallows every action once the will is released', () => {
    const will = makeWill({ status: WillStatus.Released, guardians: ['GGUARD'] });
    expect(getNextActionableState(will, 'GOWNER')).toEqual({
      canCheckIn: false,
      canTrigger: false,
      canEmergencyCheckIn: false,
      canRelease: false,
      canCancel: false,
      canGuardianVote: false,
    });
  });

  it('disallows every action once the will is cancelled', () => {
    const will = makeWill({ status: WillStatus.Cancelled, guardians: ['GGUARD'] });
    expect(getNextActionableState(will, 'GGUARD')).toEqual({
      canCheckIn: false,
      canTrigger: false,
      canEmergencyCheckIn: false,
      canRelease: false,
      canCancel: false,
      canGuardianVote: false,
    });
  });

  it('gives an unrelated address no owner/guardian-gated permissions', () => {
    const will = makeWill({ status: WillStatus.Active, lastCheckin: new Date() });
    const state = getNextActionableState(will, 'GUNRELATED');
    expect(state.canCheckIn).toBe(false);
    expect(state.canCancel).toBe(false);
    expect(state.canGuardianVote).toBe(false);
  });
});
