// @ts-nocheck -- mock SDK types are fundamentally incompatible with real @stellar/stellar-sdk types
import { describe, expect, it, vi } from 'vitest';

vi.mock('@stellar/freighter-api', () => ({
  default: {
    getAddress: vi.fn(),
    requestAccess: vi.fn(),
    getNetworkDetails: vi.fn(),
    isConnected: vi.fn(),
    signTransaction: vi.fn(),
  },
}));

vi.mock('@stellar/stellar-sdk', () => {
  class MockContract {
    constructor(private readonly id: string) {}
    contractId(): string {
      return this.id;
    }
    call() {
      return {};
    }
  }
  class MockServer {
    constructor(public readonly url: string) {}
  }
  return {
    Account: class {},
    BASE_FEE: '100',
    Contract: MockContract,
    Networks: { PUBLIC: 'PUBLIC', TESTNET: 'TESTNET' },
    Transaction: class {},
    TransactionBuilder: class {},
    contract: {
      Spec: Object.assign(function Spec() {
        return { funcArgsToScVals: () => [], funcResToNative: (_m: string, v: unknown) => v };
      }, { fromWasm: () => ({ funcArgsToScVals: () => [], funcResToNative: (_m: string, v: unknown) => v }) }),
    },
    rpc: {
      Api: { GetTransactionStatus: { SUCCESS: 'SUCCESS' }, isSimulationError: () => false, isSimulationRestore: () => false },
      Server: MockServer,
    },
    xdr: { ScVal: { scvVoid: () => ({}) } },
  };
});

import { SoroWillClient } from '../src/SoroWillClient';
import type { SoroWillEvent } from '../src/types';

describe('subscribeToEvents — WebSocket connection timeout', () => {
  it('falls back to polling when the WebSocket never fires any event', async () => {
    // A socket stub that accepts assignment of handlers but never invokes any
    // of onopen / onerror / onclose — the exact shape that used to hang the
    // returned promise forever.
    const deadSocket = {
      close: vi.fn(),
      send: vi.fn(),
      onopen: null,
      onerror: null,
      onclose: null,
      onmessage: null,
    };
    const webSocketFactory = vi.fn(() => deadSocket);

    const fetchImpl = vi.fn(async () => ({
      json: async () => ({ result: { events: [], nextCursor: '1' } }),
    }));

    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CCONTRACT',
      webSocketFactory,
      eventStreamUrl: 'wss://stream.example/events',
      eventRpcUrl: 'https://rpc.example',
      fetch: fetchImpl as unknown as typeof fetch,
    });

    const events: SoroWillEvent[] = [];
    const start = Date.now();

    const subscription = await client.subscribeToEvents(
      (event: SoroWillEvent) => events.push(event),
      { transport: 'websocket', websocketConnectTimeoutMs: 20, pollIntervalMs: 10_000 },
    );

    expect(Date.now() - start).toBeLessThan(2_000);
    expect(subscription.transport).toBe('polling');
    expect(deadSocket.close).toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalled();

    subscription.close();
  }, 5_000);
});
