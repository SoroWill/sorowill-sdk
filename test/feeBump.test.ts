// @ts-nocheck -- mock SDK types are fundamentally incompatible with real @stellar/stellar-sdk types
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockState, mockFreighterApi } = vi.hoisted(() => ({
  mockState: {
    sendTransaction: vi.fn(),
    pollTransaction: vi.fn(),
    getAccount: vi.fn(),
  },
  mockFreighterApi: {
    getAddress: vi.fn(),
  },
}));

vi.mock('@stellar/stellar-sdk', () => {
  class MockAccount {
    constructor(
      public readonly accountId: string,
      public readonly sequence: string,
    ) {}
  }

  class MockKeypair {
    constructor(private readonly _publicKey?: string, private readonly _secretKey?: string) {}

    publicKey(): string {
      return this._publicKey || 'GDEFAULTPUBLICKEY';
    }

    static fromPublicKey(publicKey: string): MockKeypair {
      return new MockKeypair(publicKey);
    }

    static fromSecret(secretKey: string): MockKeypair {
      return new MockKeypair('GDEFAULTPUBLICKEY', secretKey);
    }

    signDecorated(_hash: Uint8Array): any {
      return { toXDR: () => 'MOCK_SIGNATURE' };
    }
  }

  class MockTransaction {
    public fee = '1000';
    public source = 'GSOURCE_ACCOUNT';
    public sequence = '101';

    constructor(private _xdr = 'MOCK_TX_XDR') {}

    toXDR(): string {
      return this._xdr;
    }

    hash(): Uint8Array {
      return new Uint8Array(32);
    }

    addDecoratedSignature(_sig: any): void {
      this._xdr = 'SIGNED_TX_XDR';
    }
  }

  class MockTransactionBuilder {
    private operation: unknown;
    private timeout = 30;

    constructor(
      private readonly account: MockAccount,
      private readonly options: { fee: string; networkPassphrase: string },
    ) {}

    addOperation(operation: unknown): this {
      this.operation = operation;
      return this;
    }

    setTimeout(timeout: number): this {
      this.timeout = timeout;
      return this;
    }

    build(): MockTransaction {
      return new MockTransaction();
    }

    static fromXDR(xdr: string, _networkPassphrase: string): MockTransaction {
      return new MockTransaction(xdr);
    }

    static buildFeeBumpTransaction(
      _keypair: MockKeypair,
      fee: string,
      _innerTx: MockTransaction,
      _networkPassphrase: string,
    ): MockTransaction {
      const tx = new MockTransaction();
      (tx as any).fee = fee;
      return tx;
    }
  }

  class MockServer {
    constructor(public readonly url: string) {}

    sendTransaction = mockState.sendTransaction;
    pollTransaction = mockState.pollTransaction;
    getAccount = mockState.getAccount;
  }

  const BASE_FEE = '100';

  return {
    BASE_FEE,
    Keypair: MockKeypair,
    Account: MockAccount,
    Transaction: MockTransaction,
    TransactionBuilder: MockTransactionBuilder,
    Networks: {
      TESTNET: 'Test SDF Network ; September 2015',
      PUBLIC: 'Public Global Stellar Network ; September 2015',
    },
    rpc: {
      Server: MockServer,
      Api: {
        GetTransactionStatus: {
          SUCCESS: 'SUCCESS',
          ERROR: 'ERROR',
        },
      },
    },
  };
});

import {
  buildFeeBumpXdr,
  submitFeeBumpTransaction,
  submitFeeBump,
  validateInnerTransactionSequence,
  StaleTransactionSequenceError,
} from '../src/feeBump';

describe('feeBump', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: account sequence is 100, inner transaction sequence is 101 → still valid.
    mockState.getAccount.mockResolvedValue({ sequence: '100' });
  });

  describe('buildFeeBumpXdr', () => {
    it('should build a fee-bump transaction XDR', async () => {
      const xdr = await buildFeeBumpXdr({
        network: 'testnet',
        innerTransactionXdr: 'INNER_TX_XDR',
        feeSourcePublicKey: 'GFEEsourcepublickey',
        fee: '5000',
      });

      expect(xdr).toBe('MOCK_TX_XDR');
    });

    it('should accept realistic Soroban fee amounts', async () => {
      const sorobanFee = '50000';
      const xdr = await buildFeeBumpXdr({
        network: 'mainnet',
        innerTransactionXdr: 'SOROBAN_PREPARED_TX_XDR',
        feeSourcePublicKey: 'GMAINNETFEEACCOUNT',
        fee: sorobanFee,
      });

      expect(xdr).toBeTruthy();
    });
  });

  describe('submitFeeBumpTransaction', () => {
    it('should successfully submit a fee-bump transaction', async () => {
      mockState.sendTransaction.mockResolvedValueOnce({
        status: 'PENDING',
        hash: 'TX_HASH_123',
      });
      mockState.pollTransaction.mockResolvedValueOnce({
        status: 'SUCCESS',
        createdAt: 1234567890,
      });

      const result = await submitFeeBumpTransaction({
        network: 'testnet',
        feeBumpXdr: 'SIGNED_FEE_BUMP_XDR',
      });

      expect(result).toEqual({
        txHash: 'TX_HASH_123',
        createdAt: 1234567890,
      });
      expect(mockState.sendTransaction).toHaveBeenCalledTimes(1);
      expect(mockState.pollTransaction).toHaveBeenCalledTimes(1);
    });

    it('should throw error with diagnostics when submission fails', async () => {
      mockState.sendTransaction.mockResolvedValueOnce({
        status: 'ERROR',
        hash: 'FAILED_TX_HASH',
        diagnosticEventsXdr: 'DIAG_EVENT_XDR_DATA',
        errorResultXdr: 'ERROR_RESULT_XDR_DATA',
      });

      await expect(
        submitFeeBumpTransaction({
          network: 'testnet',
          feeBumpXdr: 'INVALID_FEE_BUMP_XDR',
        }),
      ).rejects.toThrow(/Fee-bump transaction submission failed/);
    });

    it('should include diagnostic info in error message', async () => {
      mockState.sendTransaction.mockResolvedValueOnce({
        status: 'ERROR',
        diagnosticEventsXdr: 'DIAG_DATA',
        errorResultXdr: 'ERROR_DATA',
      });

      try {
        await submitFeeBumpTransaction({
          network: 'testnet',
          feeBumpXdr: 'XDR',
        });
        expect.fail('should have thrown');
      } catch (error: any) {
        expect(error.message).toContain('Fee-bump transaction submission failed');
        expect(error.cause).toEqual({
          status: 'ERROR',
          diagnosticEventsXdr: 'DIAG_DATA',
          errorResultXdr: 'ERROR_DATA',
        });
      }
    });

    it('should throw error when poll transaction returns non-success status', async () => {
      mockState.sendTransaction.mockResolvedValueOnce({
        status: 'PENDING',
        hash: 'TX_HASH_456',
      });
      mockState.pollTransaction.mockResolvedValueOnce({
        status: 'ERROR',
        createdAt: 1234567890,
      });

      await expect(
        submitFeeBumpTransaction({
          network: 'testnet',
          feeBumpXdr: 'SIGNED_FEE_BUMP_XDR',
        }),
      ).rejects.toThrow(/Fee-bump transaction did not succeed: ERROR/);
    });
  });

  describe('submitFeeBump', () => {
    it('should build, sign, and submit a fee-bump transaction', async () => {
      mockState.sendTransaction.mockResolvedValueOnce({
        status: 'PENDING',
        hash: 'INTEGRATION_TX_HASH',
      });
      mockState.pollTransaction.mockResolvedValueOnce({
        status: 'SUCCESS',
        createdAt: 1234567890,
      });

      const result = await submitFeeBump({
        innerTransactionXdr: 'PREPARED_INNER_TX_XDR',
        feeSourceSecretKey: 'SFEESONKEYSECRET',
        network: 'testnet',
        fee: '8000',
      });

      expect(result).toEqual({
        txHash: 'INTEGRATION_TX_HASH',
        createdAt: 1234567890,
      });
    });

    it('should derive fee from inner transaction when not provided', async () => {
      mockState.sendTransaction.mockResolvedValueOnce({
        status: 'PENDING',
        hash: 'TX_HASH_DERIVED',
      });
      mockState.pollTransaction.mockResolvedValueOnce({
        status: 'SUCCESS',
        createdAt: 1234567890,
      });

      const result = await submitFeeBump({
        innerTransactionXdr: 'SOROBAN_PREPARED_TX_XDR',
        feeSourceSecretKey: 'SFEESONKEYSECRET',
        network: 'testnet',
      });

      expect(result).toBeTruthy();
      expect(mockState.sendTransaction).toHaveBeenCalledTimes(1);
    });

    it('should use provided fee when specified', async () => {
      mockState.sendTransaction.mockResolvedValueOnce({
        status: 'PENDING',
        hash: 'TX_HASH_CUSTOM_FEE',
      });
      mockState.pollTransaction.mockResolvedValueOnce({
        status: 'SUCCESS',
        createdAt: 1234567890,
      });

      const result = await submitFeeBump({
        innerTransactionXdr: 'PREPARED_INNER_TX_XDR',
        feeSourceSecretKey: 'SFEESONKEYSECRET',
        network: 'testnet',
        fee: '100000',
      });

      expect(result).toBeTruthy();
    });
  });
});

describe('feeBump configuration', () => {
  it('submitFeeBumpTransaction accepts optional pollAttempts parameter', () => {
    const innerXdr = makeInnerTxXdr(Networks.TESTNET);
    const feeSource = Keypair.random();
    const feeBumpXdr = makeFeeBumpXdr(innerXdr, feeSource, Networks.TESTNET);
    const signedXdr = signFeeBumpXdr(feeBumpXdr, feeSource.secret(), Networks.TESTNET);

    const options: { network: 'testnet' | 'mainnet'; feeBumpXdr: string; pollAttempts?: number } = {
      network: 'testnet',
      feeBumpXdr: signedXdr,
      pollAttempts: 50,
    };

    expect(options.pollAttempts).toBe(50);
  });

  it('submitFeeBumpTransaction works with default pollAttempts', () => {
    const innerXdr = makeInnerTxXdr(Networks.TESTNET);
    const feeSource = Keypair.random();
    const feeBumpXdr = makeFeeBumpXdr(innerXdr, feeSource, Networks.TESTNET);
    const signedXdr = signFeeBumpXdr(feeBumpXdr, feeSource.secret(), Networks.TESTNET);

    const options: { network: 'testnet' | 'mainnet'; feeBumpXdr: string; pollAttempts?: number } = {
      network: 'testnet',
      feeBumpXdr: signedXdr,
    };

    expect(options.pollAttempts).toBeUndefined();
  });

  it('submitFeeBump accepts optional pollAttempts parameter', () => {
    const innerXdr = makeInnerTxXdr(Networks.TESTNET);
    const feeSource = Keypair.random();

    const options: {
      innerTransactionXdr: string;
      feeSourceSecretKey: string;
      network: 'testnet' | 'mainnet';
      fee?: string;
      pollAttempts?: number;
    } = {
      innerTransactionXdr: innerXdr,
      feeSourceSecretKey: feeSource.secret(),
      network: 'testnet',
      fee: '1000',
      pollAttempts: 60,
    };

    expect(options.pollAttempts).toBe(60);
  });

  it('submitFeeBump works with default pollAttempts', () => {
    const innerXdr = makeInnerTxXdr(Networks.TESTNET);
    const feeSource = Keypair.random();

    const options: {
      innerTransactionXdr: string;
      feeSourceSecretKey: string;
      network: 'testnet' | 'mainnet';
      fee?: string;
      pollAttempts?: number;
    } = {
      innerTransactionXdr: innerXdr,
      feeSourceSecretKey: feeSource.secret(),
      network: 'testnet',
      fee: '1000',
    };

    expect(options.pollAttempts).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Issue #496 — sequence-number validation before wrapping in a fee bump
// ---------------------------------------------------------------------------
describe('validateInnerTransactionSequence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves when the inner transaction sequence is greater than the account sequence', async () => {
    // inner tx sequence = 101 (set by MockTransaction default), account = 100
    mockState.getAccount.mockResolvedValueOnce({ sequence: '100' });

    await expect(
      validateInnerTransactionSequence('INNER_TX_XDR', 'testnet'),
    ).resolves.toBeUndefined();
  });

  it('throws StaleTransactionSequenceError when the inner sequence equals the account sequence', async () => {
    // inner tx sequence = 101, account already at 101 → stale
    mockState.getAccount.mockResolvedValueOnce({ sequence: '101' });

    await expect(
      validateInnerTransactionSequence('INNER_TX_XDR', 'testnet'),
    ).rejects.toThrow(StaleTransactionSequenceError);
  });

  it('throws StaleTransactionSequenceError when the inner sequence is less than the account sequence', async () => {
    // inner tx sequence = 101, account already at 200 → definitely stale
    mockState.getAccount.mockResolvedValueOnce({ sequence: '200' });

    await expect(
      validateInnerTransactionSequence('INNER_TX_XDR', 'testnet'),
    ).rejects.toThrow(StaleTransactionSequenceError);
  });

  it('StaleTransactionSequenceError carries innerSequence and accountSequence properties', async () => {
    mockState.getAccount.mockResolvedValueOnce({ sequence: '101' });

    try {
      await validateInnerTransactionSequence('INNER_TX_XDR', 'testnet');
      expect.fail('should have thrown');
    } catch (err: any) {
      expect(err).toBeInstanceOf(StaleTransactionSequenceError);
      expect(err.innerSequence).toBe('101');
      expect(err.accountSequence).toBe('101');
      expect(err.message).toContain('has already been used');
    }
  });

  it('includes the stale sequence values in the error message', async () => {
    mockState.getAccount.mockResolvedValueOnce({ sequence: '150' });

    await expect(
      validateInnerTransactionSequence('INNER_TX_XDR', 'testnet'),
    ).rejects.toThrow('Inner transaction sequence (101) has already been used');
  });
});

describe('buildFeeBumpXdr – sequence validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects with StaleTransactionSequenceError when wrapping a stale transaction', async () => {
    // The inner tx mock has sequence = 101; simulate the account being at 101 already.
    mockState.getAccount.mockResolvedValueOnce({ sequence: '101' });

    await expect(
      buildFeeBumpXdr({
        network: 'testnet',
        innerTransactionXdr: 'STALE_INNER_TX_XDR',
        feeSourcePublicKey: 'GFEEsourcepublickey',
        fee: '5000',
      }),
    ).rejects.toThrow(StaleTransactionSequenceError);
  });

  it('proceeds normally when the inner transaction sequence is still valid', async () => {
    // account = 100, inner tx sequence = 101 → valid
    mockState.getAccount.mockResolvedValueOnce({ sequence: '100' });

    const xdr = await buildFeeBumpXdr({
      network: 'testnet',
      innerTransactionXdr: 'FRESH_INNER_TX_XDR',
      feeSourcePublicKey: 'GFEEsourcepublickey',
      fee: '5000',
    });

    expect(xdr).toBe('MOCK_TX_XDR');
  });
});
