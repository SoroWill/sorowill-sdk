import { afterEach, describe, expect, it, vi } from 'vitest';

import { LobstrWalletAdapter, type LobstrSessionClient } from '../src/adapters/lobstr';
import { isMobileBrowser } from '../src/adapters/lobstr';

const CONNECTION = { publicKey: 'GABC', network: 'testnet', networkPassphrase: 'pp' };

function makeClient(overrides: Partial<LobstrSessionClient> = {}): LobstrSessionClient {
  return {
    connect: vi.fn(async () => ({
      uri: 'wc:abc123@2?relay-protocol=irn',
      approval: async () => CONNECTION,
    })),
    disconnect: vi.fn(async () => {}),
    isConnected: vi.fn(async () => false),
    getPublicKey: vi.fn(async () => 'GABC'),
    signTransaction: vi.fn(async () => 'SIGNED'),
    ...overrides,
  };
}

describe('Issue #721: LOBSTR mobile support via WalletConnect deeplink', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('launches LOBSTR with a deeplink carrying the encoded WalletConnect URI', async () => {
    const openDeepLink = vi.fn();
    const adapter = new LobstrWalletAdapter({ client: makeClient(), openDeepLink });

    await adapter.connect();

    expect(openDeepLink).toHaveBeenCalledTimes(1);
    expect(openDeepLink).toHaveBeenCalledWith(
      `lobstr://wallet-connect?uri=${encodeURIComponent('wc:abc123@2?relay-protocol=irn')}`,
    );
  });

  it('does not open a deeplink when the session client returns no pairing URI', async () => {
    const openDeepLink = vi.fn();
    const client = makeClient({
      connect: vi.fn(async () => ({ approval: async () => CONNECTION })),
    });
    const adapter = new LobstrWalletAdapter({ client, openDeepLink });

    await expect(adapter.connect()).resolves.toEqual(CONNECTION);
    expect(openDeepLink).not.toHaveBeenCalled();
  });

  it('detects mobile browsers from the user agent', () => {
    expect(isMobileBrowser('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')).toBe(true);
    expect(isMobileBrowser('Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile Safari/537.36')).toBe(true);
    expect(isMobileBrowser('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120')).toBe(false);
  });

  it('falls back to the deeplink flow when the WalletConnect session fails to start', async () => {
    const openDeepLink = vi.fn();
    const onFallback = vi.fn();
    const client = makeClient({
      connect: vi.fn(async () => {
        throw new Error('relay unavailable');
      }),
    });
    const adapter = new LobstrWalletAdapter({
      client,
      openDeepLink,
      fallbackToDeepLink: true,
      onFallback,
    } as ConstructorParameters<typeof LobstrWalletAdapter>[0]);

    await expect(adapter.connect()).rejects.toThrow();

    expect(onFallback).toHaveBeenCalledWith(expect.objectContaining({ reason: 'relay unavailable' }));
    expect(openDeepLink).toHaveBeenCalledWith(expect.stringMatching(/^lobstr:\/\/wallet-connect\?uri=/));
  });
});
