import { describe, it, expect } from 'vitest';
import {
  validateAmountAgainstLimit,
  validatePeriodAgainstLimit,
  validatePercentage,
} from '../src/validation';

describe('Issue #734: numeric inputs validated against contract limits', () => {
  describe('validateAmountAgainstLimit', () => {
    it('accepts amounts within the contract maximum', () => {
      expect(() => validateAmountAgainstLimit(100n, 1000n)).not.toThrow();
      expect(() => validateAmountAgainstLimit(1000n, 1000n)).not.toThrow();
    });

    it('rejects amounts above the maximum with a clear message', () => {
      expect(() => validateAmountAgainstLimit(1001n, 1000n, 'balance')).toThrow(
        'Invalid balance: 1001 exceeds the contract maximum of 1000',
      );
    });

    it('rejects negative and non-bigint amounts', () => {
      expect(() => validateAmountAgainstLimit(-1n)).toThrow(RangeError);
      expect(() => validateAmountAgainstLimit(5)).toThrow(RangeError);
    });
  });

  describe('validatePeriodAgainstLimit', () => {
    it('accepts positive integers within the maximum', () => {
      expect(() => validatePeriodAgainstLimit(12, 24)).not.toThrow();
    });

    it('rejects periods above the maximum and shows the limit', () => {
      expect(() => validatePeriodAgainstLimit(25, 24, 'period')).toThrow(
        'Invalid period: 25 exceeds the contract maximum of 24',
      );
    });

    it('rejects zero, fractional, and negative periods', () => {
      expect(() => validatePeriodAgainstLimit(0)).toThrow(RangeError);
      expect(() => validatePeriodAgainstLimit(1.5)).toThrow(RangeError);
      expect(() => validatePeriodAgainstLimit(-3)).toThrow(RangeError);
    });
  });

  describe('validatePercentage', () => {
    it('accepts the inclusive range 0-100', () => {
      expect(() => validatePercentage(0)).not.toThrow();
      expect(() => validatePercentage(50.5)).not.toThrow();
      expect(() => validatePercentage(100)).not.toThrow();
    });

    it('rejects values outside 0-100 and non-finite values', () => {
      expect(() => validatePercentage(-0.1)).toThrow('between 0 and 100');
      expect(() => validatePercentage(100.01)).toThrow('between 0 and 100');
      expect(() => validatePercentage(NaN)).toThrow(RangeError);
      expect(() => validatePercentage(Infinity)).toThrow(RangeError);
    });
  });
});
