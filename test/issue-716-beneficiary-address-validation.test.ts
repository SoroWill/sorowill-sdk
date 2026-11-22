/**
 * Issue #716 — Empty string beneficiary addresses accepted without validation.
 *
 * Acceptance criteria:
 * - Empty strings rejected as addresses
 * - Stellar address format validated (G + 55 chars)
 * - Error message shows invalid address
 * - Applies to all address inputs
 */
import { describe, expect, it, vi } from 'vitest';
import { SoroWillClient } from '../src/SoroWillClient';
import { InvalidBeneficiaryAddressError } from '../src/errors';
import { assertValidBeneficiaryAddresses, isValidStellarAddress } from '../src/utils';

const CONTRACT_ID = 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE';
const VALID = 'GA3JE5IXBSOR6DCLZSGN7JIWQWO45RCS7PUFKKVXWSTE4Y75ISIDMHJG';

describe('Issue #716 — beneficiary address validation', () => {
  it('rejects an empty string as an address', () => {
    expect(isValidStellarAddress('')).toBe(false);
    expect(() => assertValidBeneficiaryAddresses([{ address: '', percentage: 100 }])).toThrow(
      InvalidBeneficiaryAddressError,
    );
  });

  it('requires a G-prefixed 56 character Stellar address', () => {
    expect(isValidStellarAddress(VALID)).toBe(true);
    expect(isValidStellarAddress(`G${'A'.repeat(54)}`)).toBe(false); // 55 chars
    expect(isValidStellarAddress(`G${'A'.repeat(56)}`)).toBe(false); // 57 chars
    expect(isValidStellarAddress(`X${VALID.slice(1)}`)).toBe(false); // wrong prefix
  });

  it('error message includes the invalid address', () => {
    const bad = 'not-a-stellar-address';
    expect(() => assertValidBeneficiaryAddresses([{ address: bad, percentage: 100 }])).toThrow(bad);
  });

  it('updateBeneficiaries rejects an empty address before submitting a transaction', async () => {
    const simulateTransaction = vi.fn();
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: CONTRACT_ID,
      rpcServer: { simulateTransaction, getLatestLedger: async () => ({ sequence: 1 }) } as never,
      spec: {} as never,
      readCache: false,
    });

    await expect(
      client.updateBeneficiaries({
        willId: '1',
        beneficiaries: [{ address: '', percentage: 100 }],
      }),
    ).rejects.toBeInstanceOf(InvalidBeneficiaryAddressError);
    expect(simulateTransaction).not.toHaveBeenCalled();
  });
});
