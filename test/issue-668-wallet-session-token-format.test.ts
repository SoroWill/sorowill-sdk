import { describe, expect, it, vi } from 'vitest';

import {
  assertWalletSessionActive,
  ensureValidSession,
  isValidWalletSessionToken,
  validateWalletSessionToken,
  WalletSessionError,
  type WalletAdapter,
} from '../src/wallet';

const NOW = 1_700_000_000_000;

function makeWallet(overrides: Partial<WalletAdapter> = {}): WalletAdapter {
  return {
    isConnected: async () => true,
    connect: async () => ({ publicKey: 'GABC', network: 'testnet', networkPassphrase: 'pp' }),
    reconnect: async () => ({ publicKey: 'GABC', network: 'testnet', networkPassphrase: 'pp' }),
    disconnect: async () => {},
    getPublicKey: async () => 'GABC',
    signTransaction: async (xdr: string) => xdr,
    ...overrides,
  };
}

describe('Issues #662 / #668: WalletSession token format validation', () => {
  it('accepts valid session token formats', () => {
    expect(isValidWalletSessionToken('abc123')).toBe(true);
    expect(isValidWalletSessionToken('session-token_1.0+abc/def==')).toBe(true);
    expect(isValidWalletSessionToken('GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7')).toBe(true);
    expect(validateWalletSessionToken('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig')).toBe(
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig',
    );
  });

  it('rejects empty, whitespace, control-char, and arbitrary punctuation tokens', () => {
    for (const bad of ['', '   ', 'bad token', 'abc\ndef', 'abc\tdef', '<script>', 'foo;bar', '🔑', null, undefined, 123]) {
      expect(isValidWalletSessionToken(bad)).toBe(false);
      expect(() => validateWalletSessionToken(bad)).toThrow(WalletSessionError);
    }
    expect(isValidWalletSessionToken('a'.repeat(4097))).toBe(false);
  });

  it('rejects malformed session tokens in ensureValidSession without sending them to the wallet', async () => {
    const refreshSession = vi.fn(async () => ({ token: 'valid-token', expiresAt: NOW + 60_000 }));
    const wallet = makeWallet({
      getSession: async () => ({ token: 'invalid token with spaces', expiresAt: NOW + 60_000 }),
      refreshSession,
    });

    await expect(ensureValidSession(wallet, NOW)).rejects.toBeInstanceOf(WalletSessionError);
    expect(refreshSession).not.toHaveBeenCalled();
  });

  it('rejects malformed refreshed tokens in ensureValidSession', async () => {
    const wallet = makeWallet({
      getSession: async () => undefined,
      refreshSession: async () => ({ token: 'bad token!', expiresAt: NOW + 60_000 }),
    });

    await expect(ensureValidSession(wallet, NOW)).rejects.toBeInstanceOf(WalletSessionError);
  });

  it('rejects malformed session tokens in assertWalletSessionActive before signing', async () => {
    const wallet = makeWallet({
      getSession: async () => ({ token: 'bad\ntoken', expiresAt: NOW + 60_000 }),
    });

    await expect(assertWalletSessionActive(wallet, NOW)).rejects.toBeInstanceOf(WalletSessionError);
  });
});
