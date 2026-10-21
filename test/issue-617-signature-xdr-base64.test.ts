/**
 * Tests for issue #617: normalizeSignatureResponse doesn't validate XDR base64
 * encoding, so invalid XDR propagates to the contract call and fails
 * cryptically.
 *
 * Fix: the extracted XDR (bare string or `envelope_xdr`) must be standard,
 * padded base64; otherwise InvalidSignedXdrEncodingError is thrown.
 */

import { describe, it, expect } from 'vitest';
import { InvalidSignedXdrEncodingError } from '../src/errors';
import { isValidBase64, normalizeSignatureResponse } from '../src/wallet';

const VALID_XDR = 'AAAAAgAAAAA=';

describe('issue #617 — normalizeSignatureResponse base64 validation', () => {
  it('accepts a valid base64 XDR string', () => {
    expect(normalizeSignatureResponse(VALID_XDR)).toBe(VALID_XDR);
  });

  it('accepts a SignatureResponse with a valid base64 envelope_xdr', () => {
    expect(normalizeSignatureResponse({ envelope_xdr: VALID_XDR, hash: 'abc' })).toBe(VALID_XDR);
  });

  it.each([
    ['non-base64 characters', 'not-valid-xdr!'],
    ['url-safe alphabet', 'AAAA-_AA'],
    ['missing padding', 'AAAAAgAAAAA'],
    ['misplaced padding', 'AA=AAAAA'],
    ['embedded whitespace', 'AAAA AAAA'],
  ])('rejects a string with %s', (_label, xdr) => {
    expect(() => normalizeSignatureResponse(xdr)).toThrow(InvalidSignedXdrEncodingError);
  });

  it('rejects a SignatureResponse whose envelope_xdr is malformed', () => {
    expect(() => normalizeSignatureResponse({ envelope_xdr: '###malformed###' })).toThrow(
      InvalidSignedXdrEncodingError,
    );
  });

  it('gives a clear error message without leaking the value', () => {
    const malformed = 'secret$$payload';
    try {
      normalizeSignatureResponse(malformed);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidSignedXdrEncodingError);
      const e = err as InvalidSignedXdrEncodingError;
      expect(e.message).toMatch(/not valid base64/);
      expect(e.message).not.toContain(malformed);
      expect(e.length).toBe(malformed.length);
    }
  });

  it('isValidBase64 rejects the empty string', () => {
    expect(isValidBase64('')).toBe(false);
  });
});
