// @ts-nocheck -- mock SDK types are fundamentally incompatible with real @stellar/stellar-sdk types
/**
 * Tests for issues #153, #156, #155, and #154:
 *   #153 – SoroWillClient constructor throws InvalidContractIdError for bad contractId
 *   #156 – createWill() throws TooManyGuardiansError before invoking when guardians > 3
 *   #155 – createWill() calls validateBeneficiaries() and throws BeneficiaryValidationError fast
 *   #154 – FreighterWalletAdapter.signTransaction() rejects with SignTransactionTimeoutError on timeout
 */
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
  const { StrKey } = await vi.importActual<typeof import('@stellar/stellar-sdk')>(
    '@stellar/stellar-sdk',
  );

  class MockAccount {
    constructor(
      public readonly accountId: string,
      public readonly sequence: string,
    ) {}
  }

  class MockContract {
    constructor(private readonly id: string) {
      // Simulate the real Contract constructor rejecting obviously wrong IDs.
      // Real validation only runs when not mocked, so we mirror it minimally:
      // reject completely empty strings to allow tests for #153.
      if (!id) throw new Error(`Invalid contract ID: "${id}"`);
    }
    contractId(): string { return this.id; }
    call(method: string, ...args: unknown[]) { return { contractId: this.id, method, args }; }
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
    private operation: unknown;
    constructor(
      private readonly account: MockAccount,
      private readonly options: { fee: string; networkPassphrase: string },
    ) {}
    addOperation(op: unknown): this { this.operation = op; return this; }
    setTimeout(_t: number): this { return this; }
    build() {
      return {
        source: this.account.accountId,
        fee: this.options.fee,
        networkPassphrase: this.options.networkPassphrase,
        operation: this.operation,
        toXDR: () => 'TX_XDR',
      };
    }
    static fromXDR(xdr: string, networkPassphrase: string) { return { xdr, networkPassphrase }; }
  }

  return {
    Account: MockAccount,
    BASE_FEE: '100',
    Contract: MockContract,
    StrKey,
    Networks: { PUBLIC: 'PUBLIC', TESTNET: 'TESTNET' },
    Transaction: class MockTransaction {},
    TransactionBuilder: MockTransactionBuilder,
    contract: {
      Spec: Object.assign(
        function Spec(_entries?: unknown) {
          return {
            funcArgsToScVals: (_method: string, args: Record<string, unknown>) => [args],
            funcResToNative: (_method: string, value: unknown) => value,
          };
        },
        {
          fromWasm: () => ({
            funcArgsToScVals: (_method: string, args: Record<string, unknown>) => [args],
            funcResToNative: (_method: string, value: unknown) => value,
          }),
        },
      ),
    },
    rpc: {
      Api: {
        GetTransactionStatus: { SUCCESS: 'SUCCESS' },
        isSimulationError: (sim: { error?: string }) => Boolean(sim.error),
        isSimulationRestore: () => false,
        EventRecord: {},
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
import {
  BeneficiaryValidationError,
  InvalidContractIdError,
  SignTransactionTimeoutError,
  SoroWillError,
  TooManyGuardiansError,
} from '../src/errors';
import { FreighterWalletAdapter } from '../src/wallet';
import { MAX_GUARDIANS } from '../src/utils';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_BENEFICIARIES = [
  { address: 'GA3JE5IXBSOR6DCLZSGN7JIWQWO45RCS7PUFKKVXWSTE4Y75ISIDMHJG', percentage: 60 },
  { address: 'GAKUAEWGL2TSFIMEXD2VDVPX2BMJTAFFZEPJS4QQRJJF3X54P6S3QCZ6', percentage: 40 },
];

const BASE_CREATE_WILL_PARAMS = {
  token: 'CTOKEN',
  amount: '1000000',
  beneficiaries: VALID_BENEFICIARIES,
  checkinPeriodDays: 90,
  gracePeriodDays: 7,
  guardians: [],
};

function makeClient() {
  return new SoroWillClient({ network: 'testnet', contractId: 'CCONTRACT' });
}

// ---------------------------------------------------------------------------
// #153 – constructor contractId validation
// ---------------------------------------------------------------------------

describe('#153 – SoroWillClient constructor contractId validation', () => {
  it('constructs successfully with a valid-looking contract ID', () => {
    expect(() => new SoroWillClient({ network: 'testnet', contractId: 'CCONTRACT' })).not.toThrow();
  });

  it('throws InvalidContractIdError (not a raw StrKey error) when contractId is empty', () => {
    expect(() => new SoroWillClient({ network: 'testnet', contractId: '' })).toThrowError(
      InvalidContractIdError,
    );
  });

  it('InvalidContractIdError message includes the supplied contractId', () => {
    let thrown: unknown;
    try {
      new SoroWillClient({ network: 'testnet', contractId: '' });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(InvalidContractIdError);
    expect((thrown as InvalidContractIdError).contractId).toBe('');
  });

  it('InvalidContractIdError is a SoroWillError subclass', () => {
    expect(() => new SoroWillClient({ network: 'testnet', contractId: '' })).toThrowError(
      SoroWillError,
    );
  });

  it('error name is "InvalidContractIdError"', () => {
    let thrown: unknown;
    try {
      new SoroWillClient({ network: 'testnet', contractId: '' });
    } catch (err) {
      thrown = err;
    }
    expect((thrown as Error).name).toBe('InvalidContractIdError');
  });
});

// ---------------------------------------------------------------------------
// #156 – createWill guardians.length validation
// ---------------------------------------------------------------------------

describe('#156 – createWill() guardians count fast-fail', () => {
  let client: SoroWillClient;

  beforeEach(() => {
    mockState.simulateTransaction.mockReset();
    mockState.sendTransaction.mockReset();
    client = makeClient();
  });

  it('accepts exactly MAX_GUARDIANS guardians without throwing', async () => {
    // Should reach the wallet/invoke stage (not throw synchronously).
    // We just want it not to throw TooManyGuardiansError — any other error is fine.
    const params = {
      ...BASE_CREATE_WILL_PARAMS,
      guardians: Array.from({ length: MAX_GUARDIANS }, (_, i) => `GGUARDIAN${i}`),
    };
    // It will fail at invoke (no mock set up) but not with TooManyGuardiansError.
    await expect(client.createWill(params)).rejects.not.toThrow(TooManyGuardiansError);
  });

  it('throws TooManyGuardiansError synchronously for MAX_GUARDIANS + 1 guardians', async () => {
    const params = {
      ...BASE_CREATE_WILL_PARAMS,
      guardians: Array.from({ length: MAX_GUARDIANS + 1 }, (_, i) => `GGUARDIAN${i}`),
    };
    await expect(client.createWill(params)).rejects.toThrow(TooManyGuardiansError);
  });

  it('never calls simulateTransaction when too many guardians are supplied', async () => {
    const params = {
      ...BASE_CREATE_WILL_PARAMS,
      guardians: ['G1', 'G2', 'G3', 'G4'], // 4 > MAX_GUARDIANS (3)
    };
    await expect(client.createWill(params)).rejects.toThrow(TooManyGuardiansError);
    expect(mockState.simulateTransaction).not.toHaveBeenCalled();
    expect(mockState.sendTransaction).not.toHaveBeenCalled();
  });

  it('TooManyGuardiansError carries .supplied and .max properties', async () => {
    const guardians = ['G1', 'G2', 'G3', 'G4'];
    const params = { ...BASE_CREATE_WILL_PARAMS, guardians };
    let thrown: unknown;
    try {
      await client.createWill(params);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(TooManyGuardiansError);
    expect((thrown as TooManyGuardiansError).supplied).toBe(4);
    expect((thrown as TooManyGuardiansError).max).toBe(MAX_GUARDIANS);
  });

  it('TooManyGuardiansError is a SoroWillError subclass', async () => {
    const params = {
      ...BASE_CREATE_WILL_PARAMS,
      guardians: ['G1', 'G2', 'G3', 'G4'],
    };
    await expect(client.createWill(params)).rejects.toThrow(SoroWillError);
  });

  it('error name is "TooManyGuardiansError"', async () => {
    const params = { ...BASE_CREATE_WILL_PARAMS, guardians: ['G1', 'G2', 'G3', 'G4'] };
    let thrown: unknown;
    try {
      await client.createWill(params);
    } catch (err) {
      thrown = err;
    }
    expect((thrown as Error).name).toBe('TooManyGuardiansError');
  });
});

// ---------------------------------------------------------------------------
// #155 – createWill() beneficiary validation fast-fail
// ---------------------------------------------------------------------------

describe('#155 – createWill() beneficiary validation fast-fail', () => {
  let client: SoroWillClient;

  beforeEach(() => {
    mockState.simulateTransaction.mockReset();
    mockState.sendTransaction.mockReset();
    client = makeClient();
  });

  it('throws BeneficiaryValidationError when percentages do not sum to 100', async () => {
    const params = {
      ...BASE_CREATE_WILL_PARAMS,
      beneficiaries: [
        { address: 'GBENA', percentage: 60 },
        { address: 'GBENB', percentage: 39 }, // sums to 99
      ],
    };
    await expect(client.createWill(params)).rejects.toThrow(BeneficiaryValidationError);
  });

  it('never calls simulateTransaction when beneficiaries are invalid', async () => {
    const params = {
      ...BASE_CREATE_WILL_PARAMS,
      beneficiaries: [{ address: 'GBENA', percentage: 99 }], // sums to 99, not 100
    };
    await expect(client.createWill(params)).rejects.toThrow(BeneficiaryValidationError);
    expect(mockState.simulateTransaction).not.toHaveBeenCalled();
    expect(mockState.sendTransaction).not.toHaveBeenCalled();
  });

  it('throws BeneficiaryValidationError for an empty beneficiary list', async () => {
    const params = { ...BASE_CREATE_WILL_PARAMS, beneficiaries: [] };
    await expect(client.createWill(params)).rejects.toThrow(BeneficiaryValidationError);
  });

  it('throws BeneficiaryValidationError when a percentage is zero', async () => {
    const params = {
      ...BASE_CREATE_WILL_PARAMS,
      beneficiaries: [
        { address: 'GBENA', percentage: 0 },
        { address: 'GBENB', percentage: 100 },
      ],
    };
    await expect(client.createWill(params)).rejects.toThrow(BeneficiaryValidationError);
  });

  it('throws BeneficiaryValidationError for more than 10 beneficiaries', async () => {
    const params = {
      ...BASE_CREATE_WILL_PARAMS,
      beneficiaries: Array.from({ length: 11 }, (_, i) => ({
        address: `GBEN${i}`,
        percentage: i === 10 ? 10 : 9,
      })),
    };
    await expect(client.createWill(params)).rejects.toThrow(BeneficiaryValidationError);
  });

  it('BeneficiaryValidationError is a SoroWillError subclass', async () => {
    const params = {
      ...BASE_CREATE_WILL_PARAMS,
      beneficiaries: [{ address: 'GBENA', percentage: 50 }], // sums to 50, not 100
    };
    await expect(client.createWill(params)).rejects.toThrow(SoroWillError);
  });
});

// ---------------------------------------------------------------------------
// #154 – signTransaction timeout
// ---------------------------------------------------------------------------

describe('#154 – FreighterWalletAdapter.signTransaction timeout', () => {
  const testXdr = 'AAAAAgAAAAD...base64xdr...';
  const networkPassphrase = 'Test SDF Network ; September 2015';

  beforeEach(() => {
    freighterApiMock.signTransaction.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves with the signed XDR before the timeout fires', async () => {
    freighterApiMock.signTransaction.mockResolvedValue({
      signedTxXdr: 'SIGNED_XDR',
      error: undefined,
    });

    const adapter = new FreighterWalletAdapter();
    const result = await adapter.signTransaction(testXdr, {
      networkPassphrase,
      timeoutMs: 5_000,
    });

    expect(result).toBe('SIGNED_XDR');
  });

  it('rejects with SignTransactionTimeoutError when Freighter never resolves', async () => {
    // freighterApi.signTransaction returns a promise that never settles.
    freighterApiMock.signTransaction.mockReturnValue(new Promise(() => {}));

    const adapter = new FreighterWalletAdapter();
    const signPromise = adapter.signTransaction(testXdr, {
      networkPassphrase,
      timeoutMs: 1_000,
    });

    // Advance timers past the timeout.
    vi.advanceTimersByTime(1_001);

    await expect(signPromise).rejects.toThrow(SignTransactionTimeoutError);
  });

  it('SignTransactionTimeoutError.timeoutMs equals the configured timeout', async () => {
    freighterApiMock.signTransaction.mockReturnValue(new Promise(() => {}));

    const adapter = new FreighterWalletAdapter();
    const signPromise = adapter.signTransaction(testXdr, {
      networkPassphrase,
      timeoutMs: 2_000,
    });

    vi.advanceTimersByTime(2_001);

    let thrown: unknown;
    try {
      await signPromise;
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SignTransactionTimeoutError);
    expect((thrown as SignTransactionTimeoutError).timeoutMs).toBe(2_000);
  });

  it('SignTransactionTimeoutError is a SoroWillError subclass', async () => {
    freighterApiMock.signTransaction.mockReturnValue(new Promise(() => {}));

    const adapter = new FreighterWalletAdapter();
    const signPromise = adapter.signTransaction(testXdr, { networkPassphrase, timeoutMs: 500 });

    vi.advanceTimersByTime(501);

    await expect(signPromise).rejects.toThrow(SoroWillError);
  });

  it('error name is "SignTransactionTimeoutError"', async () => {
    freighterApiMock.signTransaction.mockReturnValue(new Promise(() => {}));

    const adapter = new FreighterWalletAdapter();
    const signPromise = adapter.signTransaction(testXdr, { networkPassphrase, timeoutMs: 500 });

    vi.advanceTimersByTime(501);

    let thrown: unknown;
    try {
      await signPromise;
    } catch (err) {
      thrown = err;
    }
    expect((thrown as Error).name).toBe('SignTransactionTimeoutError');
  });

  it('uses DEFAULT_SIGN_TIMEOUT_MS (120s) when no timeoutMs is given', async () => {
    freighterApiMock.signTransaction.mockReturnValue(new Promise(() => {}));

    const adapter = new FreighterWalletAdapter();
    const signPromise = adapter.signTransaction(testXdr, { networkPassphrase });

    // Just before default timeout: should still be pending.
    vi.advanceTimersByTime(119_999);
    // Should not have rejected yet (we can't easily assert "still pending" with
    // Promise.race, so we just advance past the threshold and assert it throws).
    vi.advanceTimersByTime(2);

    await expect(signPromise).rejects.toThrow(SignTransactionTimeoutError);
  });
});
