// @ts-nocheck -- mock SDK types are fundamentally incompatible with real @stellar/stellar-sdk types
/**
 * Tests for issue #638: SoroWillClient.checkIn() doesn't validate check-in
 * period boundaries — calling checkIn during the grace period (Triggered state)
 * produces an opaque contract error.
 *
 * After the fix, checkIn throws a clear CheckInDuringGracePeriodError before
 * building or submitting any transaction.
 *
 * Acceptance criteria:
 * - Grace period state validation is applied in checkIn
 * - Clear error is thrown when the will is in the Triggered (grace period) state
 * - Test covers the grace period check
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { freighterApiMock, mockState } = vi.hoisted(() => ({
  freighterApiMock: {
    getAddress: vi.fn(async () => ({ address: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF', error: undefined })),
    requestAccess: vi.fn(),
    getNetworkDetails: vi.fn().mockResolvedValue({ network: 'TESTNET', networkPassphrase: 'Test SDF Network ; September 2015' }),
    isConnected: vi.fn(),
    signTransaction: vi.fn(),
  },
  mockState: {
    getAccount: vi.fn(async (publicKey: string) => ({ accountId: publicKey, sequence: '1' })),
    getContractWasmByContractId: vi.fn(async () => new Uint8Array()),
    pollTransaction: vi.fn(),
    prepareTransaction: vi.fn(async (tx: { toXDR: () => string }) => ({ toXDR: tx.toXDR })),
    sendTransaction: vi.fn(),
    simulateTransaction: vi.fn(),
  },
}));

vi.mock('@stellar/freighter-api', () => ({
  default: freighterApiMock,
}));

vi.mock('@stellar/stellar-sdk', async () => {
  const { StrKey } = await vi.importActual('@stellar/stellar-sdk');

  class MockAccount {
    constructor(public readonly accountId, public readonly sequence) {}
    incrementSequenceNumber() {}
    sequenceNumber() { return this.sequence; }
  }

  class MockContract {
    constructor(private readonly id) {}
    contractId() { return this.id; }
    call(method, ...args) { return { contractId: this.id, method, args }; }
  }

  class MockServer {
    getAccount = mockState.getAccount;
    getContractWasmByContractId = mockState.getContractWasmByContractId;
    pollTransaction = mockState.pollTransaction;
    prepareTransaction = mockState.prepareTransaction;
    sendTransaction = mockState.sendTransaction;
    simulateTransaction = mockState.simulateTransaction;
  }

  class MockTransactionBuilder {
    constructor(private account, private options) {}
    addOperation(op) { this._op = op; return this; }
    setTimeout(_t) { return this; }
    build() {
      return {
        source: this.account.accountId,
        fee: this.options.fee,
        networkPassphrase: this.options.networkPassphrase,
        operation: this._op,
        toXDR: () => 'TX_XDR',
      };
    }
    static fromXDR(_xdr, _np) { return new MockTransaction(); }
  }

  class MockTransaction {}

  return {
    Account: MockAccount,
    BASE_FEE: '100',
    Contract: MockContract,
    StrKey,
    Networks: { PUBLIC: 'Public Global Stellar Network ; September 2015', TESTNET: 'Test SDF Network ; September 2015' },
    Transaction: MockTransaction,
    TransactionBuilder: MockTransactionBuilder,
    contract: {
      Spec: Object.assign(
        function Spec(_entries) {
          return {
            funcArgsToScVals: (_method, args) => [args],
            funcResToNative: (_method, value) => value,
          };
        },
        {
          fromWasm: () => ({
            funcArgsToScVals: (_method, args) => [args],
            funcResToNative: (_method, value) => value,
          }),
        },
      ),
    },
    rpc: {
      Api: {
        GetTransactionStatus: { SUCCESS: 'SUCCESS' },
        isSimulationError: (sim) => Boolean(sim.error),
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

import { SoroWillClient } from '../src/SoroWillClient';
import { CheckInDuringGracePeriodError } from '../src/errors';
import { WillStatus } from '../src/types';

const CONTRACT_ID = 'CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR';
const OWNER = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

const mockWallet = {
  async isConnected() { return true; },
  async connect() { return { publicKey: OWNER, network: 'testnet', networkPassphrase: 'Test SDF Network ; September 2015' }; },
  async reconnect() { return { publicKey: OWNER, network: 'testnet', networkPassphrase: 'Test SDF Network ; September 2015' }; },
  async disconnect() {},
  async getPublicKey() { return OWNER; },
  async signTransaction(xdrStr) { return xdrStr; },
  async getNetwork() { return { network: 'testnet', networkPassphrase: 'Test SDF Network ; September 2015' }; },
};

function makeActiveWill() {
  return {
    id: 1n,
    owner: OWNER,
    token: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
    balance: 1_000_000n,
    beneficiaries: [{ address: 'GC6HGXZGSXRY2NLLRYGVHCCDNULAQ6N2QX6Q47UUW42FTH2HBAXTM2WO', percentage: 100 }],
    checkin_period_days: 90n,
    grace_period_days: 7n,
    last_checkin: 1_700_000_000n,
    trigger_time: undefined,
    status: WillStatus.Active,
    guardians: [],
    guardian_votes: 0,
  };
}

function makeTriggeredWill() {
  return { ...makeActiveWill(), status: WillStatus.Triggered, trigger_time: 1_700_000_000n };
}

function makeClient(willResult) {
  mockState.simulateTransaction.mockResolvedValue({
    result: { retval: willResult },
  });
  const spec = {
    funcArgsToScVals: (_method, args) => [args],
    funcResToNative: (method, _value) => {
      if (method === 'get_will') return willResult;
      return undefined;
    },
  };
  return new SoroWillClient({
    network: 'testnet',
    contractId: CONTRACT_ID,
    readCache: false,
    wallet: mockWallet,
    spec,
  });
}

describe('Issue #638: checkIn grace period state validation', () => {
  beforeEach(() => {
    mockState.sendTransaction.mockReset();
    mockState.pollTransaction.mockReset();
    mockState.simulateTransaction.mockReset();
    freighterApiMock.getAddress.mockClear();
  });

  it('throws CheckInDuringGracePeriodError when the will is in the Triggered state', async () => {
    const client = makeClient(makeTriggeredWill());
    await expect(client.checkIn('1')).rejects.toThrow(CheckInDuringGracePeriodError);
  });

  it('error message mentions emergencyCheckIn', async () => {
    const client = makeClient(makeTriggeredWill());
    await expect(client.checkIn('1')).rejects.toThrow(/emergencyCheckIn/);
  });

  it('error exposes the willId on the thrown error', async () => {
    const client = makeClient(makeTriggeredWill());
    let thrown;
    try {
      await client.checkIn('1');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CheckInDuringGracePeriodError);
    expect(thrown.willId).toBe('1');
  });

  it('no transaction is submitted when CheckInDuringGracePeriodError is thrown', async () => {
    const client = makeClient(makeTriggeredWill());
    await expect(client.checkIn('1')).rejects.toThrow(CheckInDuringGracePeriodError);
    expect(mockState.sendTransaction).not.toHaveBeenCalled();
  });

  it('does NOT throw CheckInDuringGracePeriodError when the will is Active', async () => {
    const client = makeClient(makeActiveWill());
    // Active will should not throw CheckInDuringGracePeriodError — it passes
    // the status check and proceeds to the contract invocation. Any error that
    // occurs deeper (e.g. in the network mock) will not be a grace-period error.
    let thrown: unknown;
    try {
      await client.checkIn('1');
    } catch (err) {
      thrown = err;
    }
    // The key assertion: whatever happened, it was NOT a CheckInDuringGracePeriodError.
    expect(thrown).not.toBeInstanceOf(CheckInDuringGracePeriodError);
  });

  // ── Public export from package index ──────────────────────────────────────

  it('CheckInDuringGracePeriodError is exported from the main package index', async () => {
    const pkg = await import('../src/index');
    expect(pkg.CheckInDuringGracePeriodError).toBeDefined();
    const err = new pkg.CheckInDuringGracePeriodError('42');
    expect(err).toBeInstanceOf(CheckInDuringGracePeriodError);
    expect(err.willId).toBe('42');
  });
});
