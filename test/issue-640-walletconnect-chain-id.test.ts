/**
 * Tests for issue #640: WalletConnect adapter doesn't implement chain ID validation.
 *
 * Acceptance criteria:
 * - Chain ID validation is implemented
 * - Error is thrown for chain mismatch
 * - Test validates chain checking
 */

import { describe, expect, it } from 'vitest';

import {
  WalletConnectAdapter,
  WalletConnectChainIdMismatchError,
  type WalletConnectClient,
  type WalletConnectSession,
} from '../src/walletConnect';

function makeTestnetSession(topic = 'topic-1'): WalletConnectSession {
  return {
    topic,
    namespaces: {
      stellar: {
        accounts: ['stellar:testnet:GABC1234567890ABCDEF'],
        methods: ['stellar_signXDR'],
        events: [],
      },
    },
  };
}

function makeMainnetSession(topic = 'topic-mainnet'): WalletConnectSession {
  return {
    topic,
    namespaces: {
      stellar: {
        accounts: ['stellar:pubnet:GABC1234567890ABCDEF'],
        methods: ['stellar_signXDR'],
        events: [],
      },
    },
  };
}

function makeClient(session: WalletConnectSession, response: unknown = { envelope_xdr: 'SIGNED_XDR' }): WalletConnectClient {
  return {
    async connect() {
      return { uri: 'wc:test', async approval() { return session; } };
    },
    async disconnect() {},
    async getSession(topic) {
      return topic === session.topic ? session : null;
    },
    async request<T>() {
      return response as T;
    },
  };
}

describe('Issue #640: WalletConnect chain ID validation', () => {
  it('signs successfully when requestChainId matches the session chain (testnet)', async () => {
    const session = makeTestnetSession();
    const adapter = new WalletConnectAdapter(makeClient(session), {
      requestChainId: 'stellar:testnet',
    });
    await adapter.connect();

    await expect(
      adapter.signTransaction('UNSIGNED_XDR', { networkPassphrase: 'Test SDF Network ; September 2015' }),
    ).resolves.toBe('SIGNED_XDR');
  });

  it('signs successfully when requestChainId matches the session chain (pubnet)', async () => {
    const session = makeMainnetSession();
    const adapter = new WalletConnectAdapter(makeClient(session), {
      requestChainId: 'stellar:pubnet',
    });
    await adapter.connect();

    await expect(
      adapter.signTransaction('UNSIGNED_XDR', { networkPassphrase: 'Public Global Stellar Network ; September 2015' }),
    ).resolves.toBe('SIGNED_XDR');
  });

  it('throws WalletConnectChainIdMismatchError when requestChainId is testnet but session is pubnet', async () => {
    const session = makeMainnetSession();
    const adapter = new WalletConnectAdapter(makeClient(session), {
      requestChainId: 'stellar:testnet', // wrong chain for this session
    });
    await adapter.connect();

    await expect(
      adapter.signTransaction('UNSIGNED_XDR', { networkPassphrase: 'Public Global Stellar Network ; September 2015' }),
    ).rejects.toThrow(WalletConnectChainIdMismatchError);
  });

  it('throws WalletConnectChainIdMismatchError when requestChainId is pubnet but session is testnet', async () => {
    const session = makeTestnetSession();
    const adapter = new WalletConnectAdapter(makeClient(session), {
      requestChainId: 'stellar:pubnet', // wrong chain for this session
    });
    await adapter.connect();

    await expect(
      adapter.signTransaction('UNSIGNED_XDR', { networkPassphrase: 'Test SDF Network ; September 2015' }),
    ).rejects.toThrow(WalletConnectChainIdMismatchError);
  });

  it('error includes requestedChainId and sessionChainId properties', async () => {
    const session = makeTestnetSession();
    const adapter = new WalletConnectAdapter(makeClient(session), {
      requestChainId: 'stellar:pubnet',
    });
    await adapter.connect();

    let thrown: unknown;
    try {
      await adapter.signTransaction('UNSIGNED_XDR', { networkPassphrase: 'Test SDF Network ; September 2015' });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(WalletConnectChainIdMismatchError);
    const err = thrown as WalletConnectChainIdMismatchError;
    expect(err.requestedChainId).toBe('stellar:pubnet');
    expect(err.sessionChainId).toBe('stellar:testnet');
  });

  it('uses the session chain ID (no mismatch check) when requestChainId is not configured', async () => {
    // When no requestChainId option is set, the adapter uses the session's
    // chain ID by default — no mismatch is possible, signing must succeed.
    const session = makeTestnetSession();
    const adapter = new WalletConnectAdapter(makeClient(session));
    await adapter.connect();

    await expect(
      adapter.signTransaction('UNSIGNED_XDR', { networkPassphrase: 'Test SDF Network ; September 2015' }),
    ).resolves.toBe('SIGNED_XDR');
  });

  it('WalletConnectChainIdMismatchError message mentions both chain IDs', async () => {
    const session = makeTestnetSession();
    const adapter = new WalletConnectAdapter(makeClient(session), {
      requestChainId: 'stellar:pubnet',
    });
    await adapter.connect();

    await expect(
      adapter.signTransaction('UNSIGNED_XDR', { networkPassphrase: 'Test SDF Network ; September 2015' }),
    ).rejects.toThrow(/stellar:pubnet/);

    await expect(
      adapter.signTransaction('UNSIGNED_XDR', { networkPassphrase: 'Test SDF Network ; September 2015' }),
    ).rejects.toThrow(/stellar:testnet/);
  });
});
