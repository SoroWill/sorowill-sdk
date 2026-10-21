/**
 * Tests for issue #615: Beneficiary validation doesn't enforce Stellar
 * address format.
 *
 * Acceptance criteria:
 * - Stellar address format validation
 * - Clear error for invalid addresses
 * - Test covers various address formats
 */

import { Keypair, StrKey } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';

import { BeneficiaryValidationError, InvalidBeneficiaryAddressError } from '../src/errors';
import { SoroWillClient } from '../src/SoroWillClient';
import {
  assertValidBeneficiaryAddresses,
  describeInvalidBeneficiaryAddress,
  validateBeneficiaries,
} from '../src/utils';

const VALID = 'GA3JE5IXBSOR6DCLZSGN7JIWQWO45RCS7PUFKKVXWSTE4Y75ISIDMHJG';
const VALID_B = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const CONTRACT = 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE';
const SECRET = Keypair.random().secret();
const MUXED = StrKey.encodeMed25519PublicKey(Buffer.concat([StrKey.decodeEd25519PublicKey(VALID), Buffer.alloc(8)]));
const BAD_CHECKSUM = `${VALID.slice(0, -1)}${VALID.endsWith('A') ? 'B' : 'A'}`;

describe('issue #615 — beneficiary Stellar address format', () => {
  it('accepts valid Stellar account addresses', () => {
    expect(describeInvalidBeneficiaryAddress(VALID)).toBeNull();
    expect(describeInvalidBeneficiaryAddress(VALID_B)).toBeNull();
    expect(describeInvalidBeneficiaryAddress(Keypair.random().publicKey())).toBeNull();
  });

  it.each([
    ['an empty string', '', 'empty'],
    ['an Ethereum address', '0x52908400098527886E0F7030069857D2E4169EE7', 'Ethereum'],
    ['a lowercase address', VALID.toLowerCase(), 'uppercase'],
    ['an address with surrounding whitespace', ` ${VALID} `, 'whitespace'],
    ['a secret key', SECRET, 'secret key'],
    ['a contract address', CONTRACT, 'contract addresses'],
    ['a muxed address', MUXED, 'muxed addresses'],
    ['a Bitcoin address', '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2', 'start with "G"'],
    ['a truncated address', VALID.slice(0, 40), 'expected 56 characters'],
    ['an address with a bad checksum', BAD_CHECKSUM, 'checksum'],
  ])('rejects %s with a specific reason', (_label, address, reason) => {
    expect(describeInvalidBeneficiaryAddress(address)).toContain(reason);
    expect(validateBeneficiaries([{ address, percentage: 100 }])).toBe(false);
  });

  it.each([null, undefined, 42])('rejects a non-string address (%s)', (address) => {
    expect(describeInvalidBeneficiaryAddress(address)).toContain('expected a string');
  });

  it('assertValidBeneficiaryAddresses throws InvalidBeneficiaryAddressError naming the address', () => {
    let caught: unknown;
    try {
      assertValidBeneficiaryAddresses([
        { address: VALID, percentage: 50 },
        { address: CONTRACT, percentage: 50 },
      ]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(InvalidBeneficiaryAddressError);
    expect(caught).toBeInstanceOf(BeneficiaryValidationError);
    const err = caught as InvalidBeneficiaryAddressError;
    expect(err.address).toBe(CONTRACT);
    expect(err.reason).toContain('contract addresses');
    expect(err.message).toContain(CONTRACT);
    expect(err.message).toContain('starting with "G"');
  });

  it('assertValidBeneficiaryAddresses passes for valid addresses', () => {
    expect(() =>
      assertValidBeneficiaryAddresses([
        { address: VALID, percentage: 50 },
        { address: VALID_B, percentage: 50 },
      ]),
    ).not.toThrow();
  });

  it('createWill and updateBeneficiaries reject invalid addresses before any RPC call', async () => {
    const client: SoroWillClient = Object.create(SoroWillClient.prototype);
    const beneficiaries = [{ address: '0xdeadbeef', percentage: 100 }];

    await expect(
      client.createWill({ beneficiaries, guardians: [] } as never),
    ).rejects.toThrow(InvalidBeneficiaryAddressError);
    await expect(
      client.updateBeneficiaries({ willId: '1', beneficiaries } as never),
    ).rejects.toThrow(InvalidBeneficiaryAddressError);
  });
});
