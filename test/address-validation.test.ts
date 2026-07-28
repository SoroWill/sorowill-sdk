import { describe, expect, it } from 'vitest';

/**
 * Validates that a string is a valid Stellar address format.
 * Stellar addresses are 56 characters long and start with 'G' or 'C'.
 * They use base32 encoding with a checksum.
 */
export function isValidStellarAddress(address: string): boolean {
  if (!address || typeof address !== 'string') {
    return false;
  }

  if (address.length !== 56) {
    return false;
  }

  if (address[0] !== 'G' && address[0] !== 'C') {
    return false;
  }

  // Check if all characters are valid base32 (A-Z, 2-7)
  if (!/^[A-Z2-7]+$/.test(address)) {
    return false;
  }

  return true;
}

describe('Stellar Address Validation', () => {
  describe('valid addresses', () => {
    it('accepts valid public key addresses starting with G', () => {
      expect(isValidStellarAddress('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF')).toBe(true);
      expect(isValidStellarAddress('G4P37AE2ZGTJP2F2AN6R5QVX3MDQGPYQRVYEX276Y4H7ETPYWAVVFKR2')).toBe(true);
    });

    it('accepts valid contract addresses starting with C', () => {
      expect(isValidStellarAddress('CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF')).toBe(true);
      expect(isValidStellarAddress('CNT5SRWHDE5RSBQSEC66EXCXFMX66GPJP2TJADS32AV7PADVQ4WCDBBV')).toBe(true);
    });
  });

  describe('invalid addresses', () => {
    it('rejects addresses with incorrect length', () => {
      expect(isValidStellarAddress('GABC')).toBe(false);
      expect(isValidStellarAddress('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHFX')).toBe(false);
    });

    it('rejects addresses with invalid prefix', () => {
      expect(isValidStellarAddress('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF')).toBe(false);
      expect(isValidStellarAddress('BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF')).toBe(false);
      expect(isValidStellarAddress('0AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF')).toBe(false);
    });

    it('rejects addresses with invalid base32 characters', () => {
      expect(isValidStellarAddress('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHB!')).toBe(false);
      expect(isValidStellarAddress('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF0')).toBe(false);
      expect(isValidStellarAddress('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwhf')).toBe(false);
    });

    it('rejects null, undefined, or non-string inputs', () => {
      expect(isValidStellarAddress(null as any)).toBe(false);
      expect(isValidStellarAddress(undefined as any)).toBe(false);
      expect(isValidStellarAddress(123 as any)).toBe(false);
      expect(isValidStellarAddress({} as any)).toBe(false);
    });

    it('rejects empty strings', () => {
      expect(isValidStellarAddress('')).toBe(false);
    });

    it('rejects addresses with lowercase characters', () => {
      expect(isValidStellarAddress('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwhf')).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('rejects addresses with extra whitespace', () => {
      expect(isValidStellarAddress(' GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF')).toBe(false);
      expect(isValidStellarAddress('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF ')).toBe(false);
    });

    it('validates address format strictly without external checksum verification', () => {
      // This tests format only, not cryptographic checksum
      // Actual checksum validation would require the stellar-sdk library
      expect(isValidStellarAddress('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF')).toBe(true);
    });
  });
});
