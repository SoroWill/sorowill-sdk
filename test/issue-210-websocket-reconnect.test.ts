// @ts-nocheck -- mock SDK types are fundamentally incompatible with real @stellar/stellar-sdk types
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { freighterApiMock, mockState } = vi.hoisted(() => ({
  freighterApiMock: {
    getAddress: vi.fn(async () => ({ address: 'GTESTACCOUNT', error: undefined })),
    requestAccess: vi.fn(),
    getNetworkDetails: vi.fn(),
    isConnected: vi.fn(),
    signTransaction: vi.fn(),
  },
  mockState: {
    createdServerUrls: [] as string[],
    getAccount: vi.fn(async (publicKey: string) => ({ accountId: publicKey, sequence: '1' })),
  },
}));

vi.mock('@stellar/freighter-api', () => ({
  default: freighterApiMock,
}));

vi.mock('@stellar/stellar-sdk', () => {
  class MockAccount {
    constructor(
      public readonly accountId: string,
      public readonly sequence: string,
    ) {}
  }

  class MockServer {
    constructor(public readonly url: string) {
      mockState.createdServerUrls.push(url);
    }
  }

  return {
    Account: MockAccount,
    BASE_FEE: '100',
    Networks: { PUBLIC: 'PUBLIC', TESTNET: 'TESTNET' },
    rpc: { Server: MockServer },
  };
});

import { SoroWillClient } from '../src/SoroWillClient';

describe('Issue #210: WebSocket reconnect/fallback handling for post-open connection drop', () => {
  let client: SoroWillClient;
  let mockWebSocket: {
    send: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    onopen?: () => void;
    onmessage?: (event: { data: string }) => void;
    onerror?: () => void;
    onclose?: () => void;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockState.createdServerUrls = [];

    mockWebSocket = {
      send: vi.fn(),
      close: vi.fn(),
    };

    const webSocketFactory = vi.fn(() => mockWebSocket);

    client = new SoroWillClient({
      network: 'testnet',
      contractId: 'TESTCONTRACT',
      webSocketFactory: webSocketFactory,
      eventStreamUrl: 'ws://test-stream.local',
    });
  });

  it('should call onError callback when WebSocket drops after successfully opening', async () => {
    const onErrorSpy = vi.fn();

    const subscriptionPromise = client.subscribeToEvents(
      () => {}, // listener
      { onError: onErrorSpy, transport: 'websocket' },
    );

    if (mockWebSocket.onopen) {
      mockWebSocket.onopen();
    }

    await subscriptionPromise;

    if (mockWebSocket.onerror) {
      mockWebSocket.onerror();
    }

    expect(onErrorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('WebSocket'),
      }),
    );
  });

  it('should mark subscription as closed when WebSocket closes after opening', async () => {
    const subscriptionPromise = client.subscribeToEvents(
      () => {}, // listener
      { transport: 'websocket' },
    );

    if (mockWebSocket.onopen) {
      mockWebSocket.onopen();
    }

    const subscription = await subscriptionPromise;

    if (mockWebSocket.onclose) {
      mockWebSocket.onclose();
    }

    expect(subscription.closed).toBe(true);
  });

  it('should document that subscription errors but does not auto-reconnect on post-open drop', async () => {
    const onErrorSpy = vi.fn();

    const subscriptionPromise = client.subscribeToEvents(
      () => {}, // listener
      { onError: onErrorSpy, transport: 'websocket' },
    );

    if (mockWebSocket.onopen) {
      mockWebSocket.onopen();
    }

    const subscription = await subscriptionPromise;
    const initialTransport = subscription.transport;

    if (mockWebSocket.onerror) {
      mockWebSocket.onerror();
    }

    expect(initialTransport).toBe('websocket');
    expect(onErrorSpy).toHaveBeenCalled();
    expect(subscription.closed).toBe(true);
  });

  it('should verify onError fires only once when WebSocket drops', async () => {
    const onErrorSpy = vi.fn();

    const subscriptionPromise = client.subscribeToEvents(
      () => {}, // listener
      { onError: onErrorSpy, transport: 'websocket' },
    );

    if (mockWebSocket.onopen) {
      mockWebSocket.onopen();
    }

    await subscriptionPromise;

    if (mockWebSocket.onerror) {
      mockWebSocket.onerror();
    }

    expect(onErrorSpy).toHaveBeenCalledTimes(1);
  });

  it('should demonstrate that WebSocket error after open does not fall back to polling', async () => {
    let pollingCalled = false;

    client = new SoroWillClient({
      network: 'testnet',
      contractId: 'TESTCONTRACT',
      webSocketFactory: () => mockWebSocket,
      eventStreamUrl: 'ws://test-stream.local',
      fetchImpl: async () => {
        pollingCalled = true;
        return new Response(
          JSON.stringify({
            result: { events: [], nextCursor: undefined },
          }),
        );
      },
    });

    const subscriptionPromise = client.subscribeToEvents(
      () => {}, // listener
      { transport: 'websocket' },
    );

    if (mockWebSocket.onopen) {
      mockWebSocket.onopen();
    }

    const subscription = await subscriptionPromise;

    // Polling should not be called at this point
    expect(pollingCalled).toBe(false);

    // Simulate post-open error
    if (mockWebSocket.onerror) {
      mockWebSocket.onerror();
    }

    // Polling still should not be called (no auto-fallback)
    expect(pollingCalled).toBe(false);

    // Connection should be closed
    expect(subscription.closed).toBe(true);
  });

  it('should differ from initial connection failure which does fall back to polling', async () => {
    let pollingFallbackCalled = false;

    const newClient = new SoroWillClient({
      network: 'testnet',
      contractId: 'TESTCONTRACT',
      webSocketFactory: () => {
        const failingSocket = {
          send: vi.fn(),
          close: vi.fn(),
          onopen: undefined,
          onmessage: undefined,
          onerror: undefined,
          onclose: undefined,
        };
        // Trigger error immediately (before open)
        setTimeout(() => {
          if (failingSocket.onerror) failingSocket.onerror();
        }, 0);
        return failingSocket;
      },
      eventStreamUrl: 'ws://test-stream.local',
      fetchImpl: async () => {
        pollingFallbackCalled = true;
        return new Response(
          JSON.stringify({
            result: { events: [], nextCursor: undefined },
          }),
        );
      },
    });

    const subscription = await newClient.subscribeToEvents(
      () => {}, // listener
      { transport: 'websocket' },
    );

    // Initial connection failure should fall back to polling
    expect(subscription.transport).toBe('polling');
  });

  it('should test that listener does not receive events after post-open WebSocket drop', async () => {
    const eventListener = vi.fn();

    const subscriptionPromise = client.subscribeToEvents(eventListener, {
      transport: 'websocket',
    });

    if (mockWebSocket.onopen) {
      mockWebSocket.onopen();
    }

    const subscription = await subscriptionPromise;

    // Simulate receiving an event while connected
    if (mockWebSocket.onmessage) {
      mockWebSocket.onmessage({
        data: JSON.stringify({
          result: {
            events: [
              {
                type: 'contract',
                id: 'event-1',
                createdAt: 123456,
                ledger: 100,
                ledgerClosedAt: '2024-01-01T00:00:00Z',
                contractId: 'TESTCONTRACT',
                txHash: 'tx-hash-1',
                topics: [],
                data: {},
              },
            ],
          },
        }),
      });
    }

    expect(eventListener).toHaveBeenCalledTimes(1);

    // Simulate WebSocket drop
    if (mockWebSocket.onclose) {
      mockWebSocket.onclose();
    }

    // Simulate attempt to send event after close
    if (mockWebSocket.onmessage) {
      mockWebSocket.onmessage({
        data: JSON.stringify({
          result: {
            events: [
              {
                type: 'contract',
                id: 'event-2',
                createdAt: 123457,
                ledger: 101,
                ledgerClosedAt: '2024-01-01T00:00:01Z',
                contractId: 'TESTCONTRACT',
                txHash: 'tx-hash-2',
                topics: [],
                data: {},
              },
            ],
          },
        }),
      });
    }

    // Listener should not receive events after connection closes
    expect(eventListener).toHaveBeenCalledTimes(1);
    expect(subscription.closed).toBe(true);
  });

  it('should document current behavior: post-open drop is not auto-recovered', async () => {
    const eventListener = vi.fn();
    const onErrorSpy = vi.fn();

    const subscriptionPromise = client.subscribeToEvents(eventListener, {
      onError: onErrorSpy,
      transport: 'websocket',
    });

    if (mockWebSocket.onopen) {
      mockWebSocket.onopen();
    }

    const subscription = await subscriptionPromise;
    expect(subscription.transport).toBe('websocket');

    // Trigger post-open error
    if (mockWebSocket.onerror) {
      mockWebSocket.onerror();
    }

    // Verify the behavior: error fires but no auto-recovery
    expect(onErrorSpy).toHaveBeenCalled();
    expect(subscription.transport).toBe('websocket'); // Still websocket, not switched
    expect(subscription.closed).toBe(true); // But marked as closed
  });
});
