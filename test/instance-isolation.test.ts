/**
 * Regression test for #121 — no shared mutable state across concurrent SoroWillClient instances.
 *
 * `specPromise` is a private instance field that is populated lazily the first
 * time `getSpec()` is called.  Because it lives on the instance, every client
 * must initialise its own copy from *its own* contractId and RPC server.
 *
 * This file is the explicit, executable proof of that invariant.  It guards
 * against a future refactor that accidentally hoists `specPromise` (or any
 * other per-instance state) to module scope, which would silently cause all
 * clients to share a single cached spec.
 */

// @ts-nocheck -- mock SDK types are fundamentally incompatible with real @stellar/stellar-sdk types
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks — collected per-test via mockRegistry so each client's server
// tracks its own WASM calls independently.
// ---------------------------------------------------------------------------

const { mockRegistry, specFromWasmSpy } = vi.hoisted(() => {
  // Registry maps contractId → tracking info for that server instance.
  const mockRegistry: Map<string, { wasmCallArgs: string[]; contractId: string }> = new Map();

  // Spy that records which WASM bytes fromWasm was called with.
  const specFromWasmSpy = vi.fn((wasm: Uint8Array) => {
    const contractId = new TextDecoder().decode(wasm);
    return {
      _contractId: contractId,
      funcArgsToScVals: () => [],
      funcResToNative: (_method: string, _value: unknown) => ({
        id: 1n,
        owner: 'GOWNER',
        token: 'CTOKEN',
        balance: 1_000_000n,
        beneficiaries: [{ address: 'GBEN', percentage: 100 }],
        checkin_period_days: 90n,
        grace_period_days: 7n,
        last_checkin: 1_700_000_000n,
        trigger_time: undefined,
        status: 'Active',
        guardians: [],
        guardian_votes: 0,
      }),
    };
  });

  return { mockRegistry, specFromWasmSpy };
});

vi.mock('@stellar/stellar-sdk', () => {
  class MockAccount {
    constructor(
      public readonly accountId: string,
      public readonly sequence: string,
    ) {}
  }

  class MockContract {
    constructor(private readonly id: string) {}
    contractId(): string { return this.id; }
    call(method: string, ...args: unknown[]): { contractId: string; method: string; args: unknown[] } {
      return { contractId: this.id, method, args };
    }
  }

  // MockServer looks up registry by the URL it was constructed with to route
  // getContractWasmByContractId to the right per-instance tracker.
  class MockServer {
    constructor(public readonly url: string) {}

    async getContractWasmByContractId(contractId: string): Promise<Uint8Array> {
      // Find the registry entry for this contractId and record the call.
      const entry = mockRegistry.get(contractId);
      if (entry) {
        entry.wasmCallArgs.push(contractId);
        // Return the contractId encoded as UTF-8 so fromWasm can tag the spec.
        return new TextEncoder().encode(contractId);
      }
      // Unknown contractId — return generic bytes.
      return new TextEncoder().encode(contractId);
    }

    async simulateTransaction(): Promise<unknown> {
      return { result: { retval: {} } };
    }

    async getAccount(address: string): Promise<MockAccount> {
      return new MockAccount(address, '0');
    }

    async prepareTransaction(tx: unknown): Promise<unknown> {
      return tx;
    }

    async sendTransaction(): Promise<unknown> {
      return { status: 'PENDING', hash: 'deadbeef' };
    }

    async pollTransaction(): Promise<unknown> {
      return { status: 'SUCCESS', createdAt: 1_700_000_000, returnValue: {} };
    }
  }

  class MockTransactionBuilder {
    private operation: unknown;
    constructor(
      private readonly account: MockAccount,
      private readonly options: { fee: string; networkPassphrase: string },
    ) {}
    addOperation(operation: unknown): this {
      this.operation = operation;
      return this;
    }
    setTimeout(_timeout: number): this { return this; }
    build(): { source: string; fee: string; networkPassphrase: string; operation: unknown; toXDR: () => string } {
      return {
        source: this.account.accountId,
        fee: this.options.fee,
        networkPassphrase: this.options.networkPassphrase,
        operation: this.operation,
        toXDR: () => 'TX_XDR',
      };
    }
    static fromXDR(_xdr: string, _networkPassphrase: string) {
      return new MockTransaction();
    }
  }

  class MockTransaction {}

  return {
    Account: MockAccount,
    BASE_FEE: '100',
    Contract: MockContract,
    Networks: { PUBLIC: 'PUBLIC', TESTNET: 'TESTNET' },
    Transaction: MockTransaction,
    TransactionBuilder: MockTransactionBuilder,
    contract: {
      Spec: Object.assign(
        function Spec(_entries?: unknown) {
          return {
            funcArgsToScVals: (_method: string, args: Record<string, unknown>) => [args],
            funcResToNative: (_method: string, value: unknown) => value,
          };
        },
        { fromWasm: specFromWasmSpy },
      ),
    },
    rpc: {
      Api: {
        GetTransactionStatus: { SUCCESS: 'SUCCESS' },
        isSimulationError: (simulation: { error?: string }) => Boolean(simulation?.error),
        isSimulationRestore: () => false,
      },
      Server: MockServer,
    },
    xdr: {
      ScVal: { scvVoid: () => ({}) },
      Operation: {},
      TransactionEnvelope: {
        fromXDR: () => ({
          switch: () => ({}),
          v1: () => ({ tx: () => ({ operations: () => [] }) }),
          toXDR: () => ({ toString: () => '' }),
        }),
      },
      EnvelopeType: {
        envelopeTypeTx: () => ({}),
        envelopeTypeTxFeeBump: () => ({}),
      },
      DecoratedSignature: { fromXDR: () => ({}) },
    },
  };
});

vi.mock('../src/wallet', () => ({
  freighterAdapter: { getPublicKey: vi.fn(), signTransaction: vi.fn() },
  getPublicKey: vi.fn(async () => 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'),
  signTransaction: vi.fn(async (tx: string) => tx),
  getDefaultWalletAdapter: vi.fn(() => ({
    isConnected: async () => true,
    connect: async () => ({
      publicKey: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
      network: 'testnet',
      networkPassphrase: 'Test SDF Network ; September 2015',
    }),
    reconnect: async () => ({
      publicKey: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
      network: 'testnet',
      networkPassphrase: 'Test SDF Network ; September 2015',
    }),
    disconnect: async () => {},
    getPublicKey: async () => 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
    signTransaction: async (tx: string) => tx,
  })),
}));

import { SoroWillClient } from '../src/SoroWillClient';

// ---------------------------------------------------------------------------
// Test constants — valid Stellar contract strkeys
// ---------------------------------------------------------------------------

const CONTRACT_A = 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE';
const CONTRACT_B = 'CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SoroWillClient — instance isolation (#121)', () => {
  beforeEach(() => {
    mockRegistry.clear();
    specFromWasmSpy.mockClear();
  });

  it('each instance fetches WASM using its own contractId', async () => {
    // Register per-instance trackers.
    const trackerA = { wasmCallArgs: [] as string[], contractId: CONTRACT_A };
    const trackerB = { wasmCallArgs: [] as string[], contractId: CONTRACT_B };
    mockRegistry.set(CONTRACT_A, trackerA);
    mockRegistry.set(CONTRACT_B, trackerB);

    const clientA = new SoroWillClient({ network: 'testnet', contractId: CONTRACT_A });
    const clientB = new SoroWillClient({ network: 'testnet', contractId: CONTRACT_B });

    // Trigger lazy spec initialisation in both clients.
    await Promise.all([clientA.getWill('1'), clientB.getWill('1')]);

    // Each server must have been called exactly once with its own contractId.
    // If specPromise were shared, one server would be called 0 or 2 times.
    expect(trackerA.wasmCallArgs).toHaveLength(1);
    expect(trackerB.wasmCallArgs).toHaveLength(1);

    // Each server must have been called with its own contractId — never the
    // other's.  This fails if specPromise is accidentally hoisted to module
    // scope so that both clients share the first-resolved value.
    expect(trackerA.wasmCallArgs[0]).toBe(CONTRACT_A);
    expect(trackerB.wasmCallArgs[0]).toBe(CONTRACT_B);
  });

  it('each instance caches its own specPromise independently', async () => {
    const trackerA = { wasmCallArgs: [] as string[], contractId: CONTRACT_A };
    const trackerB = { wasmCallArgs: [] as string[], contractId: CONTRACT_B };
    mockRegistry.set(CONTRACT_A, trackerA);
    mockRegistry.set(CONTRACT_B, trackerB);

    const clientA = new SoroWillClient({ network: 'testnet', contractId: CONTRACT_A });
    const clientB = new SoroWillClient({ network: 'testnet', contractId: CONTRACT_B });

    // Make three calls on each client — the WASM fetch should happen exactly
    // once per instance (subsequent calls hit the per-instance cache).
    await clientA.getWill('1');
    await clientA.getWill('2');
    await clientA.getWill('3');

    await clientB.getWill('1');
    await clientB.getWill('2');
    await clientB.getWill('3');

    // getContractWasmByContractId must be called exactly once per client —
    // not once per call, and not once globally.
    expect(trackerA.wasmCallArgs).toHaveLength(1);
    expect(trackerB.wasmCallArgs).toHaveLength(1);
  });

  it('resolving one instance spec does not populate the other instance spec', async () => {
    const trackerA = { wasmCallArgs: [] as string[], contractId: CONTRACT_A };
    // trackerB will gate its WASM resolution via a promise so we can observe
    // the race condition clearly.
    let resolveWasmB!: (value: Uint8Array) => void;
    const pendingWasmB = new Promise<Uint8Array>((resolve) => {
      resolveWasmB = resolve;
    });

    mockRegistry.set(CONTRACT_A, trackerA);

    // Override CONTRACT_B to use a pending promise.
    const originalMockServer = (await import('@stellar/stellar-sdk')).rpc.Server;
    // Patch mockRegistry to capture wasmCallArgs for B and block resolution.
    const trackerB = { wasmCallArgs: [] as string[], contractId: CONTRACT_B };
    mockRegistry.set(CONTRACT_B, {
      ...trackerB,
      // We'll intercept via a custom getContractWasmByContractId below.
    });

    // For CONTRACT_B, we need a custom server that blocks on pendingWasmB.
    // We use the `rpcServer` option to inject it directly (this bypasses rpcPool).
    const blockingServer = {
      async getContractWasmByContractId(contractId: string): Promise<Uint8Array> {
        trackerB.wasmCallArgs.push(contractId);
        return pendingWasmB;
      },
      async simulateTransaction() { return { result: { retval: {} } }; },
      async getAccount(address: string) { return { accountId: address, sequence: '0' }; },
      async prepareTransaction(tx: unknown) { return tx; },
      async sendTransaction() { return { status: 'PENDING', hash: 'deadbeef' }; },
      async pollTransaction() { return { status: 'SUCCESS', createdAt: 1_700_000_000, returnValue: {} }; },
    };

    const clientA = new SoroWillClient({ network: 'testnet', contractId: CONTRACT_A });
    const clientB = new SoroWillClient({
      network: 'testnet',
      contractId: CONTRACT_B,
      rpcServer: blockingServer as never,
    });

    // Kick off both calls concurrently — clientA resolves immediately,
    // clientB blocks until we release pendingWasmB.
    const promiseA = clientA.getWill('1');
    const promiseB = clientB.getWill('1');

    // clientA must resolve on its own.
    await promiseA;

    // serverB must have been called for CONTRACT_B, proving clientB started
    // its own independent fetch rather than reusing clientA's result.
    expect(trackerB.wasmCallArgs).toHaveLength(1);
    expect(trackerB.wasmCallArgs[0]).toBe(CONTRACT_B);

    // Now release clientB's pending WASM so the test tears down cleanly.
    resolveWasmB(new TextEncoder().encode(CONTRACT_B));
    await promiseB;
  });

  it('Spec.fromWasm is called once per instance, not once across all instances', async () => {
    const trackerA = { wasmCallArgs: [] as string[], contractId: CONTRACT_A };
    const trackerB = { wasmCallArgs: [] as string[], contractId: CONTRACT_B };
    mockRegistry.set(CONTRACT_A, trackerA);
    mockRegistry.set(CONTRACT_B, trackerB);

    const clientA = new SoroWillClient({ network: 'testnet', contractId: CONTRACT_A });
    const clientB = new SoroWillClient({ network: 'testnet', contractId: CONTRACT_B });

    // Drive spec initialisation for both clients, two calls each.
    await clientA.getWill('1');
    await clientA.getWill('2');
    await clientB.getWill('1');
    await clientB.getWill('2');

    // fromWasm must be called exactly twice — once for each distinct instance.
    // If it were called more than twice the per-instance cache is broken;
    // if it were called only once the two instances would be sharing a spec.
    expect(specFromWasmSpy).toHaveBeenCalledTimes(2);

    // Verify each call received the correct WASM bytes (i.e. routed through
    // the correct server for each contractId).
    const callArgs = specFromWasmSpy.mock.calls.map((args: unknown[]) =>
      new TextDecoder().decode(args[0] as Uint8Array),
    );
    expect(callArgs).toContain(CONTRACT_A);
    expect(callArgs).toContain(CONTRACT_B);
  });
});
