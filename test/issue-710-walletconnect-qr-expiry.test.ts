import { describe, expect, it, vi } from 'vitest';
import {
  WalletConnectAdapter,
  WalletConnectQrExpiredError,
  WalletConnectTimeoutError,
  type WalletConnectClient,
  type WalletConnectSession,
} from '../src/walletConnect';

function makeHangingClient(uri = 'wc:qr-test@2'): WalletConnectClient {
  return {
    async connect() {
      return {
        uri,
        approval(): Promise<WalletConnectSession> {
          return new Promise(() => {
            // Never resolves — simulates user not scanning the QR code
          });
        },
      };
    },
    async disconnect() {},
    async getSession() {
      return null;
    },
    async request() {
      throw new Error('unreachable');
    },
  };
}

describe('WalletConnectAdapter QR code expiration (#710)', () => {
  it('notifies onQrExpired and rejects with WalletConnectQrExpiredError after 5 minutes by default', async () => {
    vi.useFakeTimers();
    try {
      const onQrExpired = vi.fn();
      const adapter = new WalletConnectAdapter(makeHangingClient('wc:five-min@2'), {
        onQrExpired,
      });

      const connectPromise = adapter.connect();
      // Attach catch handler early so Node/Vitest does not report unhandled rejection
      const settled = connectPromise.catch((err) => err);

      // Default is 5 minutes (300,000 ms)
      await vi.advanceTimersByTimeAsync(299_999);
      expect(onQrExpired).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      const err = await settled;

      expect(onQrExpired).toHaveBeenCalledTimes(1);
      expect(onQrExpired).toHaveBeenCalledWith({
        uri: 'wc:five-min@2',
        timeoutMs: 300_000,
      });
      expect(err).toBeInstanceOf(WalletConnectQrExpiredError);
      expect(err).toBeInstanceOf(WalletConnectTimeoutError);
      expect(err.message).toContain('5 minutes');
      expect(err.message).toContain('generate a new QR code');
    } finally {
      vi.useRealTimers();
    }
  });

  it('fires onQrExpiringSoon warning before the QR code expires', async () => {
    vi.useFakeTimers();
    try {
      const onQrExpiringSoon = vi.fn();
      const onQrExpired = vi.fn();
      const adapter = new WalletConnectAdapter(makeHangingClient('wc:warn@2'), {
        connectTimeoutMs: 300_000,
        qrExpiryWarningMs: 60_000,
        onQrExpiringSoon,
        onQrExpired,
      });

      const settled = adapter.connect().catch((err) => err);

      await vi.advanceTimersByTimeAsync(240_000);
      expect(onQrExpiringSoon).toHaveBeenCalledTimes(1);
      expect(onQrExpiringSoon).toHaveBeenCalledWith({
        uri: 'wc:warn@2',
        remainingMs: 60_000,
      });
      expect(onQrExpired).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(60_000);
      const err = await settled;
      expect(err).toBeInstanceOf(WalletConnectQrExpiredError);
      expect(onQrExpired).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears expiry and warning timers when approval succeeds before timeout', async () => {
    vi.useFakeTimers();
    try {
      const onQrExpiringSoon = vi.fn();
      const onQrExpired = vi.fn();
      const session: WalletConnectSession = {
        topic: 'topic-ok',
        namespaces: {
          stellar: {
            accounts: ['stellar:testnet:GAPPROVED123'],
            methods: ['stellar_signXDR'],
            events: [],
          },
        },
      };

      const client: WalletConnectClient = {
        async connect() {
          return {
            uri: 'wc:fast@2',
            async approval() {
              return session;
            },
          };
        },
        async disconnect() {},
        async getSession() {
          return session;
        },
        async request() {
          throw new Error('unreachable');
        },
      };

      const adapter = new WalletConnectAdapter(client, {
        connectTimeoutMs: 300_000,
        onQrExpiringSoon,
        onQrExpired,
      });

      const connection = await adapter.connect();
      expect(connection.publicKey).toBe('GAPPROVED123');

      await vi.advanceTimersByTimeAsync(350_000);
      expect(onQrExpiringSoon).not.toHaveBeenCalled();
      expect(onQrExpired).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
