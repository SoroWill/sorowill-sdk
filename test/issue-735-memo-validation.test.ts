import { describe, it, expect } from 'vitest';
import { validateMemo, MAX_MEMO_BYTES } from '../src/validation';

describe('Issue #735: memo length validated before submission', () => {
  it('enforces a 28-byte limit', () => {
    expect(MAX_MEMO_BYTES).toBe(28);
    expect(() => validateMemo('a'.repeat(28))).not.toThrow();
    expect(() => validateMemo('a'.repeat(29))).toThrow(RangeError);
  });

  it('counts UTF-8 bytes, not characters', () => {
    // 'é' is 2 bytes in UTF-8: 14 of them is exactly 28 bytes.
    expect(() => validateMemo('é'.repeat(14))).not.toThrow();
    expect(() => validateMemo('é'.repeat(15))).toThrow(RangeError);
  });

  it('shows the byte count in the error message', () => {
    expect(() => validateMemo('€'.repeat(10))).toThrow(
      'Memo is too long: 30 bytes (UTF-8), maximum is 28 bytes',
    );
  });

  it('accepts an empty memo', () => {
    expect(() => validateMemo('')).not.toThrow();
  });
});
