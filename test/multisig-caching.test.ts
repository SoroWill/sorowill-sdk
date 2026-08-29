// @ts-nocheck -- mock SDK types are fundamentally incompatible with real @stellar/stellar-sdk types
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockState } = vi.hoisted(() => ({
  mockState: {
    wasmCount: 0,
    specFromWasmCount: 0,
    getContractWasmByContractId: vi.fn(async () => {
      mockState.wasmCount++;
      return new Uint8Array();
    }),
    prepareTransaction: vi.fn(async (tx: { toXDR: () => string }) => ({ toXDR: tx.toXDR })),
  },
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

    call(method: string, ...args: unknown[]): { contractId: string; method: string; args: unknown[] } {
      return { contractId: this.id, method, args };
    }
  }

  class MockSpec {
    static fromWasm(_wasm: Uint8Array): MockSpec {
      mockState.specFromWasmCount++;
      return new MockSpec();
    }

    funcArgsToScVals(_method: string, _args: Record<string, unknown>): unknown[] {
      return [];
    }
  }

  class MockServer {
    constructor(public readonly url: string) {}

    getContractWasmByContractId = mockState.getContractWasmByContractId;
    prepareTransaction = mockState.prepareTransaction;
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

    setTimeout(_timeout: number): this {
      return this;
    }

    build(): {
      source: string;
      fee: string;
      networkPassphrase: string;
      operation: unknown;
      toXDR: () => string;
    } {
      return {
        source: this.account.accountId,
        fee: this.options.fee,
        networkPassphrase: this.options.networkPassphrase,
        operation: this.operation,
        toXDR: () => 'TX_XDR',
      };
    }
  }

  const BASE_FEE = '100';

  return {
    BASE_FEE,
    Account: MockAccount,
    Contract: MockContract,
    TransactionBuilder: MockTransactionBuilder,
    rpc: {
      Server: MockServer,
    },
    contract: {
      Spec: MockSpec,
    },
  };
});

import { buildMultisigTransactionXdr } from '../src/multisig';

describe('multisig - Spec caching', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.wasmCount = 0;
    mockState.specFromWasmCount = 0;
  });

  it('should fetch WASM when spec is not provided', async () => {
    await buildMultisigTransactionXdr({
      rpcUrl: 'https://soroban-testnet.stellar.org',
      networkPassphrase: 'Test SDF Network ; September 2015',
      contractAddress: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
      method: 'transfer',
      args: { amount: 100 },
      sourceAccount: 'GACCOUNT',
    });

    expect(mockState.getContractWasmByContractId).toHaveBeenCalledTimes(1);
    expect(mockState.specFromWasmCount).toBe(1);
  });

  it('should skip WASM fetch when spec is provided', async () => {
    const cachedSpec = {
      funcArgsToScVals: vi.fn(() => []),
    };

    await buildMultisigTransactionXdr({
      rpcUrl: 'https://soroban-testnet.stellar.org',
      networkPassphrase: 'Test SDF Network ; September 2015',
      contractAddress: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
      method: 'transfer',
      args: { amount: 100 },
      sourceAccount: 'GACCOUNT',
      spec: cachedSpec,
    });

    expect(mockState.getContractWasmByContractId).not.toHaveBeenCalled();
    expect(cachedSpec.funcArgsToScVals).toHaveBeenCalledWith('transfer', { amount: 100 });
  });

  it('should avoid redundant spec parsing with cached spec', async () => {
    const cachedSpec = {
      funcArgsToScVals: vi.fn(() => []),
    };

    for (let i = 0; i < 3; i++) {
      await buildMultisigTransactionXdr({
        rpcUrl: 'https://soroban-testnet.stellar.org',
        networkPassphrase: 'Test SDF Network ; September 2015',
        contractAddress: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
        method: 'transfer',
        args: { amount: 100 + i },
        sourceAccount: 'GACCOUNT',
        spec: cachedSpec,
      });
    }

    expect(mockState.getContractWasmByContractId).not.toHaveBeenCalled();
    expect(cachedSpec.funcArgsToScVals).toHaveBeenCalledTimes(3);
  });

  it('should accept realistic Soroban fee with cached spec', async () => {
    const cachedSpec = {
      funcArgsToScVals: vi.fn(() => []),
    };

    const result = await buildMultisigTransactionXdr({
      rpcUrl: 'https://soroban-mainnet.stellar.org',
      networkPassphrase: 'Public Global Stellar Network ; September 2015',
      contractAddress: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
      method: 'execute',
      args: { data: 'test' },
      sourceAccount: 'GMAINNETACCOUNT',
      fee: '50000',
      spec: cachedSpec,
    });

    expect(result).toBeTruthy();
  });
});
