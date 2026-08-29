import { describe, expect, it, vi } from 'vitest';
import { SoroWillClient } from '../src/index';
import { InvalidContractIdError } from '../src/errors';

describe('SoroWillClient constructor with invalid contractId (issue #188)', () => {
  it('throws InvalidContractIdError when contractId has wrong length', () => {
    expect(() => {
      new SoroWillClient({
        network: 'testnet',
        contractId: 'TOOSHORT',
      });
    }).toThrow(InvalidContractIdError);
  });

  it('throws InvalidContractIdError when contractId has invalid checksum', () => {
    // Valid contract ID format but invalid checksum (last char changed)
    const validId = 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE';
    const invalidId = validId.slice(0, -1) + 'Z'; // Change last character

    expect(() => {
      new SoroWillClient({
        network: 'testnet',
        contractId: invalidId,
      });
    }).toThrow(InvalidContractIdError);
  });

  it('throws InvalidContractIdError when contractId has wrong prefix', () => {
    // Use a valid account address (G-prefixed) instead of contract address (C-prefixed)
    const accountAddress = 'GBEN5NGPTIJHKBVZ4VHACCLHVDVGVQFVZIHFMVUKJDTHW3GQKC7OQWVB';

    expect(() => {
      new SoroWillClient({
        network: 'testnet',
        contractId: accountAddress,
      });
    }).toThrow(InvalidContractIdError);
  });

  it('throws InvalidContractIdError when contractId is empty string', () => {
    expect(() => {
      new SoroWillClient({
        network: 'testnet',
        contractId: '',
      });
    }).toThrow(InvalidContractIdError);
  });

  it('throws InvalidContractIdError with message identifying the invalid option', () => {
    const invalidId = 'INVALID';

    try {
      new SoroWillClient({
        network: 'testnet',
        contractId: invalidId,
      });
      // Should not reach here
      expect.fail('Expected InvalidContractIdError to be thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidContractIdError);
      const message = (error as Error).message;
      // Error should mention contractId or indicate this is an SDK error
      expect(message.toLowerCase()).toContain('contract');
    }
  });

  it('successfully constructs with valid contractId', () => {
    // This should not throw
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
    });

    expect(client).toBeDefined();
    expect(client).toBeInstanceOf(SoroWillClient);
  });
});
