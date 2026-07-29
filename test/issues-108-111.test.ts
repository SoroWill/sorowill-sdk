/**
 * Tests for GitHub issues #108–#111.
 *
 * #109 – getContractId() / getNetwork() accessors
 * #110 – read() throws clearly on empty / malformed simulation.result
 * #111 – configurable transactionTimeoutSeconds
 */

import { Account, xdr } from '@stellar/stellar-sdk';
import { describe, expect, it, vi } from 'vitest';

const VOID_SCVAL = xdr.ScVal.scvVoid();

// ---------------------------------------------------------------------------
// Stub spec – avoids a real WASM fetch for every test
// ---------------------------------------------------------------------------

const stubSpec = {
  funcArgsToScVals: () => [] as xdr.ScVal[],
  funcResToNative: (_method: string, _value: xdr.ScVal) => ({
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

vi.mock('@stellar/stellar-sdk', async () => {
  const actual = await vi.importActual('@stellar/stellar-sdk');
  return {
    ...(actual as Record<string, unknown>),
    contract: {
      ...((actual as Record<string, unknown>).contract as Record<string, unknown>),
      Spec: { fromWasm: vi.fn(() => stubSpec) },
    },
  };
});

vi.mock('../src/wallet', () => ({
  getPublicKey: vi.fn(async () => 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'),
  signTransaction: vi.fn(async (tx: string) => tx),
  getDefaultWalletAdapter: vi.fn(() => ({
    isConnected: async () => true,
    connect: async () => ({ publicKey: 'GAAA', network: 'testnet', networkPassphrase: 'Test SDF Network ; September 2015' }),
    reconnect: async () => ({ publicKey: 'GAAA', network: 'testnet', networkPassphrase: 'Test SDF Network ; September 2015' }),
    disconnect: async () => {},
    getPublicKey: async () => 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
    signTransaction: async (tx: string) => tx,
  })),
}));

import { SoroWillClient } from '../src/SoroWillClient';
import { SoroWillError } from '../src/errors';

const CONTRACT_ID = 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE';

/**
 * Build a client whose specPromise, server, AND rpcPool are all fully
 * stubbed so no real network calls are made.
 */
function makeClient(
  opts: {
    simulateResult?: unknown;
    network?: 'testnet' | 'mainnet';
    contractId?: string;
    transactionTimeoutSeconds?: number;
  } = {},
): SoroWillClient {
  const { simulateResult, network = 'testnet', contractId = CONTRACT_ID, transactionTimeoutSeconds } = opts;

  const client = new SoroWillClient({
    network,
    contractId,
    ...(transactionTimeoutSeconds !== undefined ? { transactionTimeoutSeconds } : {}),
    // Disable the read cache so no async hydration races
    readCache: false,
  });

  // Inject a pre-resolved spec so getSpec() never makes a WASM fetch.
  Object.defineProperty(client, 'specPromise', {
    value: Promise.resolve(stubSpec),
    writable: true,
    configurable: true,
  });

  // Build a stub RPC pool that wraps a single fake server.
  const fakeServer = {
    getContractWasmByContractId: async () => new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
    simulateTransaction: async () => {
      if (simulateResult !== undefined) return simulateResult;
      return { transactionData: 'AAAA', result: { retval: VOID_SCVAL } };
    },
    getAccount: async (address: string) => new Account(address, '1'),
    prepareTransaction: async (tx: unknown) => tx,
    sendTransaction: async () => ({ status: 'PENDING', hash: 'abc123' }),
    pollTransaction: async () => ({ status: 'SUCCESS', createdAt: 1_700_000_000, returnValue: VOID_SCVAL }),
  };

  const fakePool = {
    withFailover: async <T>(operation: (server: typeof fakeServer) => Promise<T>) =>
      operation(fakeServer),
    getActiveRpcUrl: () => 'https://fake.example',
  };

  // Override the private rpcPool and server used internally.
  Object.defineProperty(client, 'rpcPool', { value: fakePool, writable: true, configurable: true });
  Object.defineProperty(client, 'server', { value: fakeServer, writable: true, configurable: true });

  return client;
}

// ===========================================================================
// #109 – getContractId() / getNetwork() accessors
// ===========================================================================

describe('#109 – getContractId() / getNetwork() accessors', () => {
  it('getContractId() returns the contract address the client was constructed with', () => {
    const client = makeClient({ contractId: CONTRACT_ID });
    expect(client.getContractId()).toBe(CONTRACT_ID);
  });

  it('getNetwork() returns "testnet" when constructed with testnet', () => {
    const client = makeClient({ network: 'testnet' });
    expect(client.getNetwork()).toBe('testnet');
  });

  it('getNetwork() returns "mainnet" when constructed with mainnet', () => {
    const client = makeClient({ network: 'mainnet' });
    expect(client.getNetwork()).toBe('mainnet');
  });

  it('getContractId() and getNetwork() both reflect the same options passed to the constructor', () => {
    const ANOTHER_CONTRACT = 'CBQDHNBFBZYE4MKPWBSJOPIYLW4SFSXAXUTSXJN76GNKYVYPCKWC6QUK';
    const client = makeClient({ network: 'mainnet', contractId: ANOTHER_CONTRACT });

    expect(client.getContractId()).toBe(ANOTHER_CONTRACT);
    expect(client.getNetwork()).toBe('mainnet');
  });
});

// ===========================================================================
// #110 – read() throws clearly on empty / malformed simulation.result
// ===========================================================================

describe('#110 – read() error handling for bad simulation result', () => {
  it('throws a clear SoroWillError when simulation.result is absent', async () => {
    // Return a simulation response that has no `result` property at all.
    const client = makeClient({ simulateResult: { transactionData: 'AAAA' /* no result key */ } });

    await expect(client.getWill('1')).rejects.toThrow(SoroWillError);
    await expect(client.getWill('1')).rejects.toThrow(/returned no result/);
  });

  it('throws a clear SoroWillError when simulation.result is explicitly null', async () => {
    const client = makeClient({ simulateResult: { transactionData: 'AAAA', result: null } });

    await expect(client.getWill('1')).rejects.toThrow(SoroWillError);
    await expect(client.getWill('1')).rejects.toThrow(/returned no result/);
  });

  it('throws a SoroWillError (not an unhandled exception) when simulation.result is present but missing retval', async () => {
    // `result` exists but has no `retval` field — structurally malformed response.
    // The SDK must not reach funcResToNative with an undefined ScVal; it must
    // produce a clear, catchable error instead.
    const client = makeClient({ simulateResult: { transactionData: 'AAAA', result: {} /* no retval */ } });

    // The call must reject with a SoroWillError (or a subclass), not an
    // unhandled internal exception such as a TypeError deep inside funcResToNative.
    await expect(client.getWill('1')).rejects.toBeInstanceOf(SoroWillError);
  });
});

// ===========================================================================
// #111 – configurable transactionTimeoutSeconds
// ===========================================================================

describe('#111 – configurable transactionTimeoutSeconds', () => {
  it('defaults to 30 seconds when transactionTimeoutSeconds is not provided', () => {
    const client = makeClient();

    // Access the private field via type assertion to verify the default.
    expect((client as unknown as { transactionTimeoutSeconds: number }).transactionTimeoutSeconds).toBe(30);
  });

  it('stores a custom transactionTimeoutSeconds value', () => {
    const client = makeClient({ transactionTimeoutSeconds: 120 });

    expect((client as unknown as { transactionTimeoutSeconds: number }).transactionTimeoutSeconds).toBe(120);
  });

  it('passes the custom timeout to TransactionBuilder.setTimeout when calling read()', async () => {
    // Track what timeout value each built transaction used by capturing
    // the `setTimeout` calls on the TransactionBuilder prototype.
    const timeoutsUsed: number[] = [];

    const { TransactionBuilder } = await import('@stellar/stellar-sdk');
    const origMethod = TransactionBuilder.prototype.setTimeout;
    TransactionBuilder.prototype.setTimeout = function (timeout: number) {
      timeoutsUsed.push(timeout);
      return origMethod.call(this, timeout);
    };

    try {
      const client = makeClient({ transactionTimeoutSeconds: 90 });
      await client.getWill('1');
    } finally {
      // Restore the original method to avoid leaking between tests.
      TransactionBuilder.prototype.setTimeout = origMethod;
    }

    // The read() path builds one transaction; it must have used 90, not 30.
    expect(timeoutsUsed).toContain(90);
    expect(timeoutsUsed).not.toContain(30);
  });

  it('a client with the default timeout still uses 30 in TransactionBuilder.setTimeout', async () => {
    const timeoutsUsed: number[] = [];

    const { TransactionBuilder } = await import('@stellar/stellar-sdk');
    const origMethod = TransactionBuilder.prototype.setTimeout;
    TransactionBuilder.prototype.setTimeout = function (timeout: number) {
      timeoutsUsed.push(timeout);
      return origMethod.call(this, timeout);
    };

    try {
      const client = makeClient();
      // no transactionTimeoutSeconds → should default to 30
      await client.getWill('1');
    } finally {
      TransactionBuilder.prototype.setTimeout = origMethod;
    }

    expect(timeoutsUsed).toContain(30);
  });
});
