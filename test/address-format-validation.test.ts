import { describe, expect, it } from 'vitest';

import { validateBeneficiaries, validateGuardians } from '../src/utils';

const VALID_ADDRESS_A = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const VALID_ADDRESS_B = 'GA3JE5IXBSOR6DCLZSGN7JIWQWO45RCS7PUFKKVXWSTE4Y75ISIDMHJG';
const MALFORMED_ADDRESS = 'GBOGUSNOTAREALSTELLARPUBLICKEYXXXXXXXXXXXXXXXXXXXXXXXXXX';

describe('validateBeneficiaries — address format', () => {
  it('accepts beneficiaries with well-formed Stellar public keys', () => {
    expect(
      validateBeneficiaries([
        { address: VALID_ADDRESS_A, percentage: 60 },
        { address: VALID_ADDRESS_B, percentage: 40 },
      ]),
    ).toBe(true);
  });

  it('rejects a beneficiary with a malformed address', () => {
    expect(
      validateBeneficiaries([
        { address: MALFORMED_ADDRESS, percentage: 100 },
      ]),
    ).toBe(false);
  });

  it('rejects a beneficiary with an empty-string address', () => {
    expect(validateBeneficiaries([{ address: '', percentage: 100 }])).toBe(false);
  });
});

describe('validateGuardians — address format', () => {
  it('accepts guardians with well-formed Stellar public keys', () => {
    expect(validateGuardians([VALID_ADDRESS_A, VALID_ADDRESS_B])).toBe(true);
  });

  it('rejects a guardian list containing a malformed address', () => {
    expect(validateGuardians([VALID_ADDRESS_A, MALFORMED_ADDRESS])).toBe(false);
  });

  it('rejects a malformed ownerAddress even when guardians are well-formed', () => {
    expect(validateGuardians([VALID_ADDRESS_A], MALFORMED_ADDRESS)).toBe(false);
  });

  it('still rejects the owner address appearing in the guardian list', () => {
    expect(validateGuardians([VALID_ADDRESS_A], VALID_ADDRESS_A)).toBe(false);
  });
});
