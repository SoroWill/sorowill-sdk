import { describe, expect, it } from 'vitest';
import { SoroWillClient, parseWillId, SoroWillInvalidIdError } from '../src';

describe('parseWillId', () => {
  it('parses valid non-negative integer strings', () => {
    expect(parseWillId('0')).toBe(0n);
    expect(parseWillId('123')).toBe(123n);
    expect(parseWillId('007')).toBe(7n);
  });

  it('throws SoroWillInvalidIdError for invalid strings', () => {
    const invalidIds = ['', '-1', '1.5', 'abc', '12a', ' 1', '1 ', '+1', '0x10', '1_000'];
    for (const id of invalidIds) {
      expect(() => parseWillId(id)).toThrow(SoroWillInvalidIdError);
    }
  });
});

describe('SoroWillClient willId validation', () => {
  const client: SoroWillClient = Object.create(SoroWillClient.prototype);

  async function expectInvalidId(method: string, willId: string) {
    try {
      await (client as any)[method](willId);
      throw new Error(`Expected ${method} to throw`);
    } catch (error) {
      expect(error).toBeInstanceOf(SoroWillInvalidIdError);
    }
  }

  it('validates willId in read methods', async () => {
    await expectInvalidId('getWill', 'invalid');
  });

  it('validates willId in write methods', async () => {
    await expectInvalidId('checkIn', 'invalid');
    await expectInvalidId('triggerWill', 'invalid');
    await expectInvalidId('emergencyCheckIn', 'invalid');
    await expectInvalidId('releaseInheritance', 'invalid');
    await expectInvalidId('cancelWill', 'invalid');
    await expectInvalidId('updateBeneficiaries', 'invalid');
    await expectInvalidId('topUp', 'invalid');
    await expectInvalidId('guardianTrigger', 'invalid');
  });
});
