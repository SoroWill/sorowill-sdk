/**
 * Tests for #517: normalizeSignatureResponse XDR format validation.
 *
 * The function must reject strings that look like signed XDR but contain
 * characters outside the standard base64 alphabet, instead of passing garbage
 * downstream to the RPC node where the error would be opaque.
 *
 * Note: validation only applies to strings ≥40 characters (real Stellar XDR
 * is always several hundred chars). Shorter strings are treated as
 * test/mock placeholders and passed through unchanged.
 */
import { describe, expect, it } from 'vitest';
import { normalizeSignatureResponse } from '../src/wallet';

// 72-char valid base64 string (multiple of 4, standard alphabet only).
// Real XDR envelopes are much longer but same charset applies.
const VALID_XDR = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

// 72-char invalid string: contains '-' which is URL-safe base64, not standard.
const INVALID_XDR_URL_SAFE =
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

// 72-char string with spaces (clearly not base64)
const INVALID_XDR_WITH_SPACES =
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

describe('normalizeSignatureResponse — XDR validation (#517)', () => {
  describe('string input (bare XDR)', () => {
    it('accepts a valid base64 XDR string', () => {
      expect(normalizeSignatureResponse(VALID_XDR)).toBe(VALID_XDR);
    });

    it('rejects an empty string', () => {
      expect(() => normalizeSignatureResponse('')).toThrow(
        'Wallet signer returned an empty signed XDR string.',
      );
    });

    it('rejects a long string containing spaces (≥40 chars)', () => {
      expect(() => normalizeSignatureResponse(INVALID_XDR_WITH_SPACES)).toThrow(
        'invalid XDR string',
      );
    });

    it('rejects a long string with URL-safe base64 chars (- and _)', () => {
      expect(() => normalizeSignatureResponse(INVALID_XDR_URL_SAFE)).toThrow(
        'invalid XDR string',
      );
    });

    it('rejects a long JSON-serialized object (clearly not XDR)', () => {
      // JSON string ≥40 chars with invalid chars like { and "
      const json = JSON.stringify({ envelope_xdr: VALID_XDR });
      expect(() => normalizeSignatureResponse(json)).toThrow('invalid XDR string');
    });

    it('passes through a short placeholder string (<40 chars) unchanged', () => {
      // Short strings are assumed to be test mocks and skip validation.
      expect(normalizeSignatureResponse('mock-signed-xdr')).toBe('mock-signed-xdr');
    });

    it('accepts a standard 8-char base64 string with no padding', () => {
      expect(normalizeSignatureResponse('AAAAAAAA')).toBe('AAAAAAAA');
    });
  });

  describe('SignatureResponse object input', () => {
    it('accepts a valid envelope_xdr', () => {
      expect(normalizeSignatureResponse({ envelope_xdr: VALID_XDR })).toBe(VALID_XDR);
    });

    it('rejects a long envelope_xdr that contains invalid chars', () => {
      expect(() =>
        normalizeSignatureResponse({ envelope_xdr: INVALID_XDR_URL_SAFE }),
      ).toThrow('invalid `envelope_xdr` value');
    });

    it('rejects a long envelope_xdr with spaces', () => {
      expect(() =>
        normalizeSignatureResponse({ envelope_xdr: INVALID_XDR_WITH_SPACES }),
      ).toThrow('invalid `envelope_xdr` value');
    });

    it('rejects an envelope_xdr that is an empty string', () => {
      expect(() => normalizeSignatureResponse({ envelope_xdr: '' })).toThrow(
        'valid `envelope_xdr` string',
      );
    });

    it('rejects an object with a missing envelope_xdr', () => {
      expect(() => normalizeSignatureResponse({} as never)).toThrow(
        'valid `envelope_xdr` string',
      );
    });

    it('passes through a short mock envelope_xdr unchanged', () => {
      expect(normalizeSignatureResponse({ envelope_xdr: 'mock-xdr' })).toBe('mock-xdr');
    });
  });

  describe('unexpected input types', () => {
    it('rejects null', () => {
      expect(() => normalizeSignatureResponse(null as never)).toThrow(
        'unexpected value of type',
      );
    });

    it('rejects a number', () => {
      expect(() => normalizeSignatureResponse(42 as never)).toThrow(
        'unexpected value of type',
      );
    });

    it('rejects undefined', () => {
      expect(() => normalizeSignatureResponse(undefined as never)).toThrow(
        'unexpected value of type',
      );
    });
  });
});
