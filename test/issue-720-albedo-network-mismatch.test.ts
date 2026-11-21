/**
 * Tests for issue #720: the Albedo adapter must reject signing requests whose
 * network differs from the network the adapter is bound to, with a clear
 * WalletNetworkMismatchError, and never call Albedo in that case.
 */
import { Networks } from '@stellar/stellar-sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const publicKeyMock = vi.fn();
const txMock = vi.fn();

vi.mock('@albedo-link/intent', () => ({
  default: {
    publicKey: (...args: unknown[]) => publicKeyMock(...args),
    tx: (...args: unknown[]) => txMock(...args),
  },
}));

import { createAlbedoAdapter } from '../src/adapters/albedo';
import { WalletNetworkMismatchError } from '../src/errors';

describe('Issue #720: Albedo adapter network mismatch', () => {
  beforeEach(() => {
    publicKeyMock.mockReset();
    txMock.mockReset();
    publicKeyMock.mockResolvedValue({ pubkey: 'GPUBKEY' });
    txMock.mockResolvedValue({ signed_envelope_xdr: 'SIGNED' });
  });

  it('rejects signing for a network other than the adapter network', async () => {
    const adapter = createAlbedoAdapter({ networkPassphrase: Networks.TESTNET });
    await adapter.connect();
    await expect(
      adapter.signTransaction('XDR', { networkPassphrase: Networks.PUBLIC }),
    ).rejects.toBeInstanceOf(WalletNetworkMismatchError);
  });

  it('reports the expected and actual passphrases on the error', async () => {
    const adapter = createAlbedoAdapter({ networkPassphrase: Networks.TESTNET });
    const err = (await adapter
      .signTransaction('XDR', { networkPassphrase: Networks.PUBLIC })
      .catch((e: unknown) => e)) as WalletNetworkMismatchError;
    expect(err.expectedNetworkPassphrase).toBe(Networks.TESTNET);
    expect(err.actualNetworkPassphrase).toBe(Networks.PUBLIC);
    expect(err.message).toMatch(/configured for/);
  });

  it('does not call Albedo when the network mismatches', async () => {
    const adapter = createAlbedoAdapter({ networkPassphrase: Networks.TESTNET });
    await adapter.connect();
    await expect(
      adapter.signTransaction('XDR', { networkPassphrase: Networks.PUBLIC }),
    ).rejects.toThrow(WalletNetworkMismatchError);
    expect(txMock).not.toHaveBeenCalled();
  });

  it('still signs when the requested network matches the adapter network', async () => {
    const adapter = createAlbedoAdapter({ networkPassphrase: Networks.TESTNET });
    await adapter.connect();
    await expect(
      adapter.signTransaction('XDR', { networkPassphrase: Networks.TESTNET }),
    ).resolves.toBe('SIGNED');
    expect(txMock).toHaveBeenCalledWith(expect.objectContaining({ network: 'testnet' }));
  });
});
