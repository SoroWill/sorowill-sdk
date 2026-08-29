// @ts-nocheck -- mock SDK types are fundamentally incompatible with real @stellar/stellar-sdk types
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { freighterApiMock, mockState } = vi.hoisted(() => ({
  freighterApiMock: {
    getAddress: vi.fn(async () => ({ address: 'GTESTACCOUNT', error: undefined })),
    requestAccess: vi.fn(),
    getNetworkDetails: vi.fn(),
    isConnected: vi.fn(),
    signTransaction: vi.fn(async () => ({ signedTxXdr: 'SIGNED_XDR', error: undefined })),
  },
  mockState: {
    getAccount: vi.fn(async (publicKey: string) => ({ accountId: publicKey, sequence: '1' })),
    getContractWasmByContractId: vi.fn(async () => new Uint8Array()),
    pollTransaction: vi.fn(async () => ({ status: 'SUCCESS', createdAt: 1_700_000_000, returnValue: 1n })),
    prepareTransaction: vi.fn(async (tx: { toXDR: () => string }) => ({ toXDR: tx.toXDR })),
    sendTransaction: vi.fn(async () => ({ status: 'PENDING', hash: 'TXHASH' })),
    simulateTransaction: vi.fn(),
    // Records every (method, args) pair bound for the contract so tests can
    // assert what actually gets sent on-chain.
    funcArgsCalls: [] as Array<{ method: string; args: Record<string, unknown> }>,
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

  class MockContract {
    constructor(private readonly id: string) {}
    contractId(): string {
      return this.id;
    }
    call(method: string, ...args: unknown[]) {
      return { contractId: this.id, method, args };
    }
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
    addOperation(op: unknown): this {
      this.operation = op;
      return this;
    }
    setTimeout(_t: number): this {
      return this;
    }
    build() {
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

  class MockTransaction {
    toXDR(): string {
      return 'TX_XDR';
    }
  }

  function specImpl() {
    return {
      funcArgsToScVals: (method: string, args: Record<string, unknown>) => {
        mockState.funcArgsCalls.push({ method, args });
        return [args];
      },
      funcResToNative: (_method: string, value: unknown) => value,
    };
  }

  return {
    Account: MockAccount,
    BASE_FEE: '100',
    Contract: MockContract,
    Networks: { PUBLIC: 'PUBLIC', TESTNET: 'TESTNET' },
    Transaction: MockTransaction,
    TransactionBuilder: MockTransactionBuilder,
    contract: {
      Spec: Object.assign(function Spec(_entries?: unknown) {
        return specImpl();
      }, { fromWasm: () => specImpl() }),
    },
    rpc: {
      Api: {
        GetTransactionStatus: { SUCCESS: 'SUCCESS' },
        isSimulationError: (sim: { error?: string }) => Boolean(sim.error),
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

function makeClient() {
  return new SoroWillClient({ network: 'testnet', contractId: 'CCONTRACT' });
}

function beneficiariesFor(method: string): Array<{ address: string; basis_points: number }> {
  const call = mockState.funcArgsCalls.find((c) => c.method === method);
  if (!call) {
    throw new Error(`no ${method} call was recorded`);
  }
  return call.args.beneficiaries as Array<{ address: string; basis_points: number }>;
}

describe('beneficiary percentage -> contract basis points', () => {
  beforeEach(() => {
    mockState.funcArgsCalls.length = 0;
    mockState.sendTransaction.mockClear();
    mockState.pollTransaction.mockClear();
  });

  it('scales createWill beneficiary percentages to basis points (30% -> 3000)', async () => {
    await makeClient().createWill({
      token: 'CTOKEN',
      amount: '1000000',
      beneficiaries: [
        { address: 'GBENA', percentage: 30 },
        { address: 'GBENB', percentage: 70 },
      ],
      checkinPeriodDays: 90,
      gracePeriodDays: 7,
      guardians: [],
    });

    expect(beneficiariesFor('create_will')).toEqual([
      { address: 'GBENA', basis_points: 3000 },
      { address: 'GBENB', basis_points: 7000 },
    ]);
  });

  it('scales updateBeneficiaries percentages to basis points and keeps the sum at 10000', async () => {
    mockState.pollTransaction.mockResolvedValueOnce({
      status: 'SUCCESS',
      createdAt: 1_700_000_000,
      returnValue: undefined,
    });

    await makeClient().updateBeneficiaries({
      willId: '1',
      beneficiaries: [
        { address: 'GBENA', percentage: 33 },
        { address: 'GBENB', percentage: 33 },
        { address: 'GBENC', percentage: 34 },
      ],
    });

    const bound = beneficiariesFor('update_beneficiaries');
    expect(bound).toEqual([
      { address: 'GBENA', basis_points: 3300 },
      { address: 'GBENB', basis_points: 3300 },
      { address: 'GBENC', basis_points: 3400 },
    ]);
    expect(bound.reduce((sum, b) => sum + b.basis_points, 0)).toBe(10_000);
  });
});
