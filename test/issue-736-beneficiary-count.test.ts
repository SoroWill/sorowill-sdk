import { describe, it, expect } from 'vitest';
import { validateBeneficiaryCount } from '../src/validation';
import { MAX_BENEFICIARIES } from '../src/utils';

describe('Issue #736: beneficiary count validated against contract maximum', () => {
  it('defaults the contract maximum to 10', () => {
    expect(MAX_BENEFICIARIES).toBe(10);
    expect(() => validateBeneficiaryCount(10)).not.toThrow();
  });

  it('rejects counts above the maximum and shows the allowed max', () => {
    expect(() => validateBeneficiaryCount(11)).toThrow(
      'Too many beneficiaries: 11 provided, contract maximum is 10',
    );
  });

  it('honours a custom contract maximum', () => {
    expect(() => validateBeneficiaryCount(5, 4)).toThrow('contract maximum is 4');
    expect(() => validateBeneficiaryCount(4, 4)).not.toThrow();
  });

  it('rejects zero and non-integer counts', () => {
    expect(() => validateBeneficiaryCount(0)).toThrow(RangeError);
    expect(() => validateBeneficiaryCount(2.5)).toThrow(RangeError);
  });
});
