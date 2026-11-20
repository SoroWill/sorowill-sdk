import { describe, expect, it, vi } from 'vitest';
import { Networks } from '@stellar/stellar-sdk';

import { SoroWillClient, type SoroWillRpcServer } from '../src/SoroWillClient';
import { ReadOnlyModeError, WalletSessionError } from '../src/errors';
import type { WalletAdapter } from '../src/wallet';

const CONTRACT_ID = 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE';
const PUBLIC_KEY = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';

function makeWallet(overrides: Partial<WalletAdapter> = {}): WalletAdapter {
  return {
    isConnected: async () => true,
    connect: async () => ({
      publicKey: PUBLIC_KEY,
      network: 'testnet',
      networkPassphrase: Networks.TESTNET,
    }),
    reconnect: async () => ({
      publicKey: PUBLIC_KEY,
      network: 'testnet',
      networkPassphrase: Networks.TESTNET,
    }),
    disconnect: async () => {},
    getPublicKey: async () => PUBLIC_KEY,
    signTransaction: async (tx: string) => tx,
    ...overrides,
  };
}

describe('Issue #665: automatic client state recovery after reconnect', () => {
  it('reconnects the wallet and clears stale caches, in-flight reads, and fee stats', async () => {
    const reconnectSpy = vi.fn(async () => ({
      publicKey: PUBLIC_KEY,
      network: 'testnet',
      networkPassphrase: Networks.TESTNET,
    }));
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: CONTRACT_ID,
      rpcServer: {} as SoroWillRpcServer,
      wallet: makeWallet({ reconnect: reconnectSpy }),
    });

    const internal = client as unknown as {
      inFlightReads: Map<string, Promise<unknown>>;
      feeStatsCache: Map<string, unknown>;
      signedTransactionHashes: Set<string>;
      readCache?: { set: (k: string, v: unknown) => Promise<void>; get: (k: string) => Promise<unknown> };
    };

    internal.inFlightReads.set('stale-read', Promise.resolve('stale'));
    internal.feeStatsCache.set(Networks.TESTNET, { latestLedger: 1 });
    internal.signedTransactionHashes.add('deadbeef');

    const connection = await client.reconnect();

    expect(reconnectSpy).toHaveBeenCalledOnce();
    expect(connection.publicKey).toBe(PUBLIC_KEY);
    expect(internal.inFlightReads.size).toBe(0);
    expect(internal.feeStatsCache.size).toBe(0);
    expect(internal.signedTransactionHashes.size).toBe(0);
  });

  it('throws ReadOnlyModeError when reconnect() is called in read-only mode', async () => {
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: CONTRACT_ID,
      rpcServer: {} as SoroWillRpcServer,
      readOnly: true,
    });

    await expect(client.reconnect()).rejects.toBeInstanceOf(ReadOnlyModeError);
  });

  it('refreshes or validates wallet session during reconnect recovery', async () => {
    const refreshSession = vi.fn(async () => ({
      token: 'fresh-token',
      expiresAt: Date.now() + 60_000,
    }));
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: CONTRACT_ID,
      rpcServer: {} as SoroWillRpcServer,
      wallet: makeWallet({
        getSession: async () => ({ token: 'old-token', expiresAt: Date.now() - 1_000 }),
        refreshSession,
      }),
    });

    await client.reconnect();
    expect(refreshSession).toHaveBeenCalledOnce();

    const badClient = new SoroWillClient({
      network: 'testnet',
      contractId: CONTRACT_ID,
      rpcServer: {} as SoroWillRpcServer,
      wallet: makeWallet({
        getSession: async () => ({ token: 'bad token', expiresAt: Date.now() + 60_000 }),
      }),
    });

    await expect(badClient.reconnect()).rejects.toBeInstanceOf(WalletSessionError);
  });
});
