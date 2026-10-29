/**
 * Tests for issue #612: the SDK didn't validate Stellar address format before
 * operations, so malformed addresses were forwarded to the RPC (a vector for
 * injection if the RPC were compromised).
 *
 * Fix: `getStellarAddressError` / `isValidStellarAddress` /
 * `assertValidStellarAddress` validate StrKey addresses (version byte and
 * checksum included), and `getWillsByOwner` / `getWillsByBeneficiary` reject
 * malformed addresses with an `InvalidStellarAddressError` before any RPC
 * call.
 */

import { describe, it, expect, vi } from 'vitest';
import { Networks } from '@stellar/stellar-sdk';
import { SoroWillClient } from '../src/SoroWillClient';
import type { SoroWillRpcServer } from '../src/SoroWillClient';
import { InvalidStellarAddressError } from '../src/errors';
import {
  assertValidStellarAddress,
  getStellarAddressError,
  isValidStellarAddress,
} from '../src/utils';
import type { WalletAdapter } from '../src/wallet';

const ACCOUNT = 'GA3JE5IXBSOR6DCLZSGN7JIWQWO45RCS7PUFKKVXWSTE4Y75ISIDMHJG';
const CONTRACT = 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE';
const MUXED = 'MA3JE5IXBSOR6DCLZSGN7JIWQWO45RCS7PUFKKVXWSTE4Y75ISIDMAAAAAAAAAAAFI6WC';
const BAD_CHECKSUM = 'GA3JE5IXBSOR6DCLZSGN7JIWQWO45RCS7PUFKKVXWSTE4Y75ISIDMHJH';
const SECRET_SEED = 'SAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC5MY';

describe('getStellarAddressError (#612)', () => {
  it('accepts a valid account public key', () => {
    expect(getStellarAddressError(ACCOUNT)).toBeNull();
  });

  it.each([
    [undefined, 'not_a_string'],
    [null, 'not_a_string'],
    [12345, 'not_a_string'],
    ['', 'empty'],
    [` ${ACCOUNT}`, 'whitespace'],
    [`${ACCOUNT}\n`, 'whitespace'],
    [`${ACCOUNT.slice(0, -1)}`, 'wrong_length'],
    [`${ACCOUNT}A`, 'wrong_length'],
    [ACCOUNT.toLowerCase(), 'invalid_characters'],
    [`${ACCOUNT.slice(0, -1)}1`, 'invalid_characters'],
    [`${ACCOUNT.slice(0, -2)}"}`, 'invalid_characters'],
    [BAD_CHECKSUM, 'invalid_checksum'],
    [SECRET_SEED, 'unsupported_type'],
    [CONTRACT, 'unsupported_type'],
    [MUXED, 'unsupported_type'],
  ])('rejects %j with reason %s', (address, reason) => {
    expect(getStellarAddressError(address)).toBe(reason);
  });

  it('accepts contract addresses only when allowContract is set', () => {
    expect(getStellarAddressError(CONTRACT, { allowContract: true })).toBeNull();
    const badContract = `${CONTRACT.slice(0, -1)}F`;
    expect(getStellarAddressError(badContract, { allowContract: true })).toBe('invalid_checksum');
  });

  it('accepts muxed addresses only when allowMuxed is set', () => {
    expect(getStellarAddressError(MUXED, { allowMuxed: true })).toBeNull();
  });
});

describe('isValidStellarAddress / assertValidStellarAddress (#612)', () => {
  it('reports validity as a boolean', () => {
    expect(isValidStellarAddress(ACCOUNT)).toBe(true);
    expect(isValidStellarAddress(BAD_CHECKSUM)).toBe(false);
    expect(isValidStellarAddress('GBOGUSNOTAREALSTELLARPUBLICKEYXXXXXXXXXXXXXXXXXXXXXXXXXX')).toBe(false);
  });

  it('throws a typed error naming the field and reason', () => {
    let caught: unknown;
    try {
      assertValidStellarAddress(`${ACCOUNT.slice(0, -1)}`, 'owner');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(InvalidStellarAddressError);
    const error = caught as InvalidStellarAddressError;
    expect(error.field).toBe('owner');
    expect(error.reason).toBe('wrong_length');
    expect(error.address).toBe(ACCOUNT.slice(0, -1));
    expect(error.message).toContain('owner is not a valid Stellar address');
  });

  it('truncates and escapes the untrusted address in the error message', () => {
    const hostile = `G\n${'x'.repeat(500)}`;
    const error = (() => {
      try {
        assertValidStellarAddress(hostile, 'owner');
      } catch (err) {
        return err as InvalidStellarAddressError;
      }
      throw new Error('expected assertValidStellarAddress to throw');
    })();

    expect(error.message).not.toContain('\n');
    expect(error.message.length).toBeLessThan(200);
    expect(error.address).toBe(hostile);
  });

  it('does not throw for a valid address', () => {
    expect(() => assertValidStellarAddress(ACCOUNT, 'owner')).not.toThrow();
  });
});

describe('SoroWillClient rejects malformed addresses before the RPC (#612)', () => {
  function makeClient() {
    const server: SoroWillRpcServer = {
      getContractWasmByContractId: vi.fn(),
      simulateTransaction: vi.fn(),
      getAccount: vi.fn(),
      prepareTransaction: vi.fn(),
      sendTransaction: vi.fn(),
      pollTransaction: vi.fn(),
    };
    const wallet: WalletAdapter = {
      isConnected: vi.fn().mockResolvedValue(true),
      connect: vi.fn().mockResolvedValue({ publicKey: ACCOUNT, network: 'testnet', networkPassphrase: Networks.TESTNET }),
      reconnect: vi.fn().mockResolvedValue({ publicKey: ACCOUNT, network: 'testnet', networkPassphrase: Networks.TESTNET }),
      disconnect: vi.fn().mockResolvedValue(undefined),
      getPublicKey: vi.fn().mockResolvedValue(ACCOUNT),
      signTransaction: vi.fn(),
    };
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: CONTRACT,
      rpcServer: server,
      wallet,
      readCache: false,
    });
    return { client, server };
  }

  const MALFORMED = ['', `${ACCOUNT.slice(0, -1)}`, BAD_CHECKSUM, SECRET_SEED, `${ACCOUNT}'); --`, ` ${ACCOUNT}`];

  it.each(MALFORMED)('getWillsByOwner rejects %j', async (owner) => {
    const { client, server } = makeClient();
    const error = await client.getWillsByOwner(owner).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(InvalidStellarAddressError);
    expect((error as InvalidStellarAddressError).field).toBe('owner');
    expect(server.simulateTransaction).not.toHaveBeenCalled();
    expect(server.getContractWasmByContractId).not.toHaveBeenCalled();
  });

  it.each(MALFORMED)('getWillsByBeneficiary rejects %j', async (beneficiary) => {
    const { client, server } = makeClient();
    const error = await client.getWillsByBeneficiary(beneficiary).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(InvalidStellarAddressError);
    expect((error as InvalidStellarAddressError).field).toBe('beneficiary');
    expect(server.simulateTransaction).not.toHaveBeenCalled();
  });
});
