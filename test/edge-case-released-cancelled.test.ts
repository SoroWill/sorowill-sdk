import { Account, xdr } from '@stellar/stellar-sdk';
import { describe, expect, it, vi } from 'vitest';

const VOID_SCVAL = xdr.ScVal.scvVoid();

function makeStubSpec(willStatus: string, balance: bigint = 0n) {
  return {
    funcArgsToScVals: () => [] as xdr.ScVal[],
    funcResToNative: (_method: string, _value: xdr.ScVal) => {
      return {
        id: 1n,
        owner: 'GOWNER',
        token: 'CTOKEN',
        balance,
        beneficiaries: [{ address: 'GBEN', percentage: 100 }],
        checkin_period_days: 90n,
        grace_period_days: 7n,
        last_checkin: 1_700_000_000n,
        trigger_time: undefined,
        status: willStatus,
        guardians: [],
        guardian_votes: 0,
      };
    },
  };
}

let currentSpec = makeStubSpec('Released', 0n);

vi.mock('@stellar/stellar-sdk', async () => {
  const actual = await vi.importActual('@stellar/stellar-sdk');
  return {
    ...(actual as Record<string, unknown>),
    contract: {
      ...((actual as Record<string, unknown>).contract as Record<string, unknown>),
      Spec: { fromWasm: vi.fn(() => currentSpec) },
    },
  };
});

const TEST_ACCOUNT = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

vi.mock('../src/wallet', () => ({
  getPublicKey: vi.fn(async () => 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'),
  signTransaction: vi.fn(async (tx: string) => tx),
  getDefaultWalletAdapter: vi.fn(() => ({
    isConnected: async () => true,
    connect: async () => ({ publicKey: TEST_ACCOUNT, network: 'testnet', networkPassphrase: 'Test SDF Network ; September 2015' }),
    reconnect: async () => ({ publicKey: TEST_ACCOUNT, network: 'testnet', networkPassphrase: 'Test SDF Network ; September 2015' }),
    disconnect: async () => {},
    getPublicKey: async () => TEST_ACCOUNT,
    signTransaction: async (tx: string) => tx,
  })),
}));

import { SoroWillClient, type SoroWillRpcServer } from '../src/SoroWillClient';
import { WillNotActiveError } from '../src/errors';
import { WillStatus } from '../src/types';

const WASM_BINARY = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);

/** Contract error code the real SoroWill contract returns for WillError::WillNotActive. */
const WILL_NOT_ACTIVE_CODE = 3;

function makeRpcServer(willStatus: string, balance: bigint = 0n): SoroWillRpcServer {
  currentSpec = makeStubSpec(willStatus, balance);
  return {
    async getContractWasmByContractId(): Promise<Uint8Array> {
      return WASM_BINARY;
    },
    async simulateTransaction() {
      return { transactionData: 'AAAA', result: { retval: VOID_SCVAL } } as never;
    },
    async getAccount(address: string) {
      return new Account(address, '1');
    },
    async prepareTransaction(tx: unknown) {
      // Mirror the real contract: state-changing calls simulate/prepare
      // successfully for reads, but fail here once the will has left the
      // Active state, exactly like `mapContractError` expects to see.
      if (willStatus !== 'Active') {
        throw new Error(
          `HostError: Value(Status(ContractError(${WILL_NOT_ACTIVE_CODE}))) ` +
            `Error(Contract, #${WILL_NOT_ACTIVE_CODE})`,
        );
      }
      return tx as never;
    },
    async sendTransaction() {
      return { status: 'PENDING', hash: 'abc123' } as never;
    },
    async pollTransaction() {
      return { status: 'SUCCESS', createdAt: 1_700_000_000, returnValue: VOID_SCVAL } as never;
    },
  };
}

describe('Edge case: Released will with zero balance', () => {
  it('getWill returns Released status with zero balance', async () => {
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
      rpcServer: makeRpcServer(WillStatus.Released, 0n) as unknown as SoroWillRpcServer,
    });

    const will = await client.getWill('1');
    expect(will.status).toBe(WillStatus.Released);
    expect(will.balance).toBe('0');
  });

  it('checkIn on Released will throws WillNotActiveError', async () => {
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
      rpcServer: makeRpcServer(WillStatus.Released, 0n) as unknown as SoroWillRpcServer,
    });

    await expect(client.checkIn('1')).rejects.toThrow(WillNotActiveError);
  });

  it('trigger on Released will throws WillNotActiveError', async () => {
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
      rpcServer: makeRpcServer(WillStatus.Released, 0n) as unknown as SoroWillRpcServer,
    });

    await expect(client.triggerWill('1')).rejects.toThrow(WillNotActiveError);
  });
});

describe('Edge case: Cancelled will with zero balance', () => {
  it('getWill returns Cancelled status with zero balance', async () => {
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
      rpcServer: makeRpcServer(WillStatus.Cancelled, 0n) as unknown as SoroWillRpcServer,
    });

    const will = await client.getWill('1');
    expect(will.status).toBe(WillStatus.Cancelled);
    expect(will.balance).toBe('0');
  });

  it('checkIn on Cancelled will throws WillNotActiveError', async () => {
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
      rpcServer: makeRpcServer(WillStatus.Cancelled, 0n) as unknown as SoroWillRpcServer,
    });

    await expect(client.checkIn('1')).rejects.toThrow(WillNotActiveError);
  });

  it('updateBeneficiaries on Cancelled will throws WillNotActiveError', async () => {
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
      rpcServer: makeRpcServer(WillStatus.Cancelled, 0n) as unknown as SoroWillRpcServer,
    });

    await expect(
      client.updateBeneficiaries({
        willId: '1',
        beneficiaries: [
          { address: 'GA3JE5IXBSOR6DCLZSGN7JIWQWO45RCS7PUFKKVXWSTE4Y75ISIDMHJG', percentage: 100 },
        ],
      })
    ).rejects.toThrow(WillNotActiveError);
  });
});

describe('Edge case: Released will with positive balance edge cases', () => {
  it('getWill accurately reflects balance of released will', async () => {
    const testBalance = 1_000_000n;
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
      rpcServer: makeRpcServer(WillStatus.Released, testBalance) as unknown as SoroWillRpcServer,
    });

    const will = await client.getWill('1');
    expect(will.balance).toBe(testBalance.toString());
    expect(will.status).toBe(WillStatus.Released);
  });

  it('state-changing operations on Released will with balance throw clear error', async () => {
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
      rpcServer: makeRpcServer(WillStatus.Released, 100_000_000n) as unknown as SoroWillRpcServer,
    });

    await expect(client.emergencyCheckIn('1')).rejects.toThrow(WillNotActiveError);
  });
});
