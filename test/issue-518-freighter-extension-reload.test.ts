/**
 * Tests for #518: FreighterWalletAdapter extension reload handling.
 *
 * When the Freighter browser extension reloads (e.g. after a browser update
 * or extension self-update), its injected content script context is
 * invalidated. Any pending or subsequent Freighter API call returns an error
 * with code -3 or a message containing "Extension context invalidated".
 *
 * The adapter must:
 *   1. Detect that error and mark itself as stale (not throw an unhandled error).
 *   2. Expose `isExtensionContextStale` so callers can surface a reconnect prompt.
 *   3. Recover transparently on the next `connect()` / `reconnect()` call.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const freighterApiMock = vi.hoisted(() => ({
  isConnected: vi.fn(),
  requestAccess: vi.fn(),
  getNetworkDetails: vi.fn(),
  getAddress: vi.fn(),
  signTransaction: vi.fn(),
}));

vi.mock('@stellar/freighter-api', () => ({
  default: freighterApiMock,
}));

import { FreighterWalletAdapter } from '../src/wallet';

const CONTEXT_INVALIDATION_ERROR = {
  code: -3,
  message: 'Extension context invalidated',
};

const VALID_CONNECTION = {
  address: 'GTESTPUBKEY12345678901234567890123456789012',
  error: undefined,
};

const VALID_NETWORK = {
  network: 'TESTNET',
  networkPassphrase: 'Test SDF Network ; September 2015',
  error: undefined,
};

describe('FreighterWalletAdapter — extension reload (#518)', () => {
  let adapter: FreighterWalletAdapter;

  beforeEach(() => {
    adapter = new FreighterWalletAdapter();
    freighterApiMock.isConnected.mockReset();
    freighterApiMock.requestAccess.mockReset();
    freighterApiMock.getNetworkDetails.mockReset();
    freighterApiMock.getAddress.mockReset();
    freighterApiMock.signTransaction.mockReset();
  });

  describe('isExtensionContextStale', () => {
    it('is false on a fresh adapter', () => {
      expect(adapter.isExtensionContextStale).toBe(false);
    });

    it('becomes true when isConnected returns context-invalidation error (code -3)', async () => {
      freighterApiMock.isConnected.mockResolvedValue({
        isConnected: false,
        error: CONTEXT_INVALIDATION_ERROR,
      });

      const result = await adapter.isConnected();

      expect(result).toBe(false);
      expect(adapter.isExtensionContextStale).toBe(true);
    });

    it('becomes true when isConnected message contains "Extension context invalidated"', async () => {
      freighterApiMock.isConnected.mockResolvedValue({
        isConnected: false,
        error: { code: 999, message: 'Extension context invalidated.' },
      });

      await adapter.isConnected();

      expect(adapter.isExtensionContextStale).toBe(true);
    });

    it('becomes true when getPublicKey returns a context-invalidation error', async () => {
      freighterApiMock.getAddress.mockResolvedValue({
        address: '',
        error: CONTEXT_INVALIDATION_ERROR,
      });

      await expect(adapter.getPublicKey()).rejects.toThrow('Extension context invalidated');
      expect(adapter.isExtensionContextStale).toBe(true);
    });

    it('is cleared back to false after a successful connect()', async () => {
      // First, trigger the stale state.
      freighterApiMock.isConnected.mockResolvedValue({
        isConnected: false,
        error: CONTEXT_INVALIDATION_ERROR,
      });
      await adapter.isConnected();
      expect(adapter.isExtensionContextStale).toBe(true);

      // Now the extension has recovered — connect() should clear the stale flag.
      freighterApiMock.requestAccess.mockResolvedValue(VALID_CONNECTION);
      freighterApiMock.getNetworkDetails.mockResolvedValue(VALID_NETWORK);

      await adapter.connect();

      expect(adapter.isExtensionContextStale).toBe(false);
    });

    it('is cleared back to false after disconnect()', async () => {
      freighterApiMock.isConnected.mockResolvedValue({
        isConnected: false,
        error: CONTEXT_INVALIDATION_ERROR,
      });
      await adapter.isConnected();
      expect(adapter.isExtensionContextStale).toBe(true);

      await adapter.disconnect();

      expect(adapter.isExtensionContextStale).toBe(false);
    });
  });

  describe('isConnected graceful fallback', () => {
    it('returns false (not throws) when the extension context is invalidated', async () => {
      freighterApiMock.isConnected.mockResolvedValue({
        isConnected: false,
        error: CONTEXT_INVALIDATION_ERROR,
      });

      await expect(adapter.isConnected()).resolves.toBe(false);
    });

    it('still throws FreighterInstallCheckError for non-context errors', async () => {
      freighterApiMock.isConnected.mockResolvedValue({
        isConnected: false,
        error: { code: 500, message: 'Internal Freighter error' },
      });

      await expect(adapter.isConnected()).rejects.toThrow();
      // The stale flag should NOT be set for unrelated errors.
      expect(adapter.isExtensionContextStale).toBe(false);
    });
  });

  describe('reconnect() after extension reload', () => {
    it('falls through to connect() when context is stale', async () => {
      // Mark as stale first.
      freighterApiMock.isConnected.mockResolvedValue({
        isConnected: false,
        error: CONTEXT_INVALIDATION_ERROR,
      });
      await adapter.isConnected();

      // reconnect() should call requestAccess (connect path) not getAddress.
      freighterApiMock.requestAccess.mockResolvedValue(VALID_CONNECTION);
      freighterApiMock.getNetworkDetails.mockResolvedValue(VALID_NETWORK);

      const connection = await adapter.reconnect();

      expect(freighterApiMock.requestAccess).toHaveBeenCalledOnce();
      expect(connection.publicKey).toBe(VALID_CONNECTION.address);
      expect(adapter.isExtensionContextStale).toBe(false);
    });

    it('falls through to connect() when getPublicKey fails with context error mid-reconnect', async () => {
      // getPublicKey throws context error during reconnect.
      freighterApiMock.getAddress.mockResolvedValue({
        address: '',
        error: CONTEXT_INVALIDATION_ERROR,
      });
      // connect path succeeds.
      freighterApiMock.requestAccess.mockResolvedValue(VALID_CONNECTION);
      freighterApiMock.getNetworkDetails.mockResolvedValue(VALID_NETWORK);

      const connection = await adapter.reconnect();

      expect(connection.publicKey).toBe(VALID_CONNECTION.address);
      expect(adapter.isExtensionContextStale).toBe(false);
    });

    it('completes normally when the extension is healthy', async () => {
      freighterApiMock.getAddress.mockResolvedValue(VALID_CONNECTION);
      freighterApiMock.getNetworkDetails.mockResolvedValue(VALID_NETWORK);

      const connection = await adapter.reconnect();

      expect(connection.publicKey).toBe(VALID_CONNECTION.address);
    });
  });

  describe('connect() error propagation', () => {
    it('marks as stale and rethrows when requestAccess returns context error', async () => {
      freighterApiMock.requestAccess.mockResolvedValue({
        address: '',
        error: CONTEXT_INVALIDATION_ERROR,
      });

      await expect(adapter.connect()).rejects.toThrow('Extension context invalidated');
      expect(adapter.isExtensionContextStale).toBe(true);
    });

    it('marks as stale and rethrows when getNetworkDetails returns context error', async () => {
      freighterApiMock.requestAccess.mockResolvedValue(VALID_CONNECTION);
      freighterApiMock.getNetworkDetails.mockResolvedValue({
        network: '',
        networkPassphrase: '',
        error: CONTEXT_INVALIDATION_ERROR,
      });

      await expect(adapter.connect()).rejects.toThrow('Extension context invalidated');
      expect(adapter.isExtensionContextStale).toBe(true);
    });
  });
});
