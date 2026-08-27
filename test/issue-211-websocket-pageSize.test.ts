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

describe('Issue #211: EventSubscriptionOptions.pageSize ignored by WebSocket transport', () => {
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

  it('should demonstrate that pageSize is not included in WebSocket subscribe message', async () => {
    const pageSize = 50;

    const subscriptionPromise = client.subscribeToEvents(
      () => {}, // listener
      { pageSize, transport: 'websocket' },
    );

    if (mockWebSocket.onopen) {
      mockWebSocket.onopen();
    }

    await subscriptionPromise;

    expect(mockWebSocket.send).toHaveBeenCalled();
    const sentMessage = mockWebSocket.send.mock.calls[0][0];
    const parsed = JSON.parse(sentMessage);

    expect(parsed).toEqual({
      type: 'subscribe',
      contractId: 'TESTCONTRACT',
      cursor: undefined,
    });
    expect(parsed.pageSize).toBeUndefined();
  });

  it('should show that WebSocket subscribe message does not contain pagination field', async () => {
    const subscriptionPromise = client.subscribeToEvents(
      () => {}, // listener
      { pageSize: 100, cursor: 'test_cursor_123', transport: 'websocket' },
    );

    if (mockWebSocket.onopen) {
      mockWebSocket.onopen();
    }

    await subscriptionPromise;

    expect(mockWebSocket.send).toHaveBeenCalledWith(
      expect.not.stringContaining('"pageSize"'),
    );

    const sentMessage = mockWebSocket.send.mock.calls[0][0];
    const parsed = JSON.parse(sentMessage);

    expect(parsed.pageSize).toBeUndefined();
    expect(parsed.cursor).toBe('test_cursor_123');
    expect(parsed.contractId).toBe('TESTCONTRACT');
  });

  it('should document that pageSize silently ignored in WebSocket subscribe', async () => {
    const pageSizes = [25, 50, 100, 500];

    for (const pageSize of pageSizes) {
      mockWebSocket.send.mockClear();

      const subscriptionPromise = client.subscribeToEvents(
        () => {}, // listener
        { pageSize, transport: 'websocket' },
      );

      if (mockWebSocket.onopen) {
        mockWebSocket.onopen();
      }

      await subscriptionPromise;

      const sentMessage = mockWebSocket.send.mock.calls[0][0];
      const parsed = JSON.parse(sentMessage);

      expect(parsed.pageSize).toBeUndefined();
    }
  });

  it('should verify polling transport includes pageSize in RPC call', async () => {
    let capturedPageSize: number | undefined;

    client = new SoroWillClient({
      network: 'testnet',
      contractId: 'TESTCONTRACT',
      fetchImpl: async (url, options) => {
        const body = JSON.parse((options as any).body);
        capturedPageSize = body.params.pagination.limit;

        return new Response(
          JSON.stringify({
            result: { events: [], nextCursor: undefined },
          }),
        );
      },
    });

    const pageSize = 100;
    const subscription = await client.subscribeToEvents(
      () => {}, // listener
      { pageSize, transport: 'polling' },
    );

    subscription.close();
    expect(capturedPageSize).toBe(pageSize);
  });

  it('should show contrast: polling uses pageSize, WebSocket does not', async () => {
    const pageSize = 75;

    // Test WebSocket (pageSize ignored)
    mockWebSocket.send.mockClear();

    const wsPromise = client.subscribeToEvents(
      () => {}, // listener
      { pageSize, transport: 'websocket' },
    );

    if (mockWebSocket.onopen) {
      mockWebSocket.onopen();
    }

    await wsPromise;

    const wsSentMessage = mockWebSocket.send.mock.calls[0][0];
    const wsParsed = JSON.parse(wsSentMessage);
    expect(wsParsed.pageSize).toBeUndefined();

    // Test Polling (pageSize included)
    let pollingPageSize: number | undefined;
    client = new SoroWillClient({
      network: 'testnet',
      contractId: 'TESTCONTRACT',
      fetchImpl: async (url, options) => {
        const body = JSON.parse((options as any).body);
        pollingPageSize = body.params.pagination.limit;
        return new Response(
          JSON.stringify({
            result: { events: [], nextCursor: undefined },
          }),
        );
      },
    });

    const pollingSubscription = await client.subscribeToEvents(
      () => {}, // listener
      { pageSize, transport: 'polling' },
    );

    expect(pollingPageSize).toBe(pageSize);
    pollingSubscription.close();
  });

  it('should document WebSocket subscribe payload structure', async () => {
    const subscriptionPromise = client.subscribeToEvents(
      () => {}, // listener
      {
        pageSize: 200,
        cursor: 'explicit_cursor_value',
        transport: 'websocket',
      },
    );

    if (mockWebSocket.onopen) {
      mockWebSocket.onopen();
    }

    await subscriptionPromise;

    const sentMessage = mockWebSocket.send.mock.calls[0][0];
    const payload = JSON.parse(sentMessage);

    expect(Object.keys(payload).sort()).toEqual(['contractId', 'cursor', 'type']);
  });
});
