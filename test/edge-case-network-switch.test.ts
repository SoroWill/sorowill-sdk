import { Account, xdr, Networks } from '@stellar/stellar-sdk';
import { describe, expect, it, vi } from 'vitest';

const VOID_SCVAL = xdr.ScVal.scvVoid();

function makeStubSpec() {
  return {
    funcArgsToScVals: () => [] as xdr.ScVal[],
    funcResToNative: (_method: string, _value: xdr.ScVal) => {
      return {
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
      };
    },
  };
}

const stubSpec = makeStubSpec();

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
    connect: async () => ({
      publicKey: 'GAA',
      network: 'testnet',
      networkPassphrase: Networks.TESTNET_PASSPHRASE,
    }),
    reconnect: async () => ({
      publicKey: 'GAA',
      network: 'testnet',
      networkPassphrase: Networks.TESTNET_PASSPHRASE,
    }),
    disconnect: async () => {},
    getPublicKey: async () => 'GAA',
    signTransaction: async (tx: string) => tx,
  })),
}));

import { SoroWillClient, type SoroWillRpcServer } from '../src/SoroWillClient';
import { WalletNetworkMismatchError } from '../src/errors';

const WASM_BINARY = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);

function makeRpcServer(): SoroWillRpcServer {
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
      return tx;
    },
    async sendTransaction() {
      return { status: 'PENDING', hash: 'abc123' } as never;
    },
    async pollTransaction() {
      return { status: 'SUCCESS', createdAt: 1_700_000_000, returnValue: VOID_SCVAL } as never;
    },
  };
}

describe('Edge case: Network switch mid-session', () => {
  it('detects network mismatch when wallet is on different network than client', async () => {
    const testnetClient = new SoroWillClient({
      network: 'testnet',
      contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
      rpcServer: makeRpcServer() as unknown as SoroWillRpcServer,
    });

    const mockWalletAdapter = {
      isConnected: async () => true,
      connect: async () => ({
        publicKey: 'GAA',
        network: 'mainnet',
        networkPassphrase: Networks.PUBLIC_NETWORK_PASSPHRASE,
      }),
      reconnect: async () => ({
        publicKey: 'GAA',
        network: 'mainnet',
        networkPassphrase: Networks.PUBLIC_NETWORK_PASSPHRASE,
      }),
      disconnect: async () => {},
      getPublicKey: async () => 'GAA',
      signTransaction: async (_tx: string) => 'signed_tx',
    };

    await expect(
      testnetClient.checkIn('1', { publicKey: 'GOWNER' }, { walletAdapter: mockWalletAdapter as any })
    ).rejects.toThrow(WalletNetworkMismatchError);
  });

  it('throws WalletNetworkMismatchError with expected and actual network info', async () => {
    const testnetClient = new SoroWillClient({
      network: 'testnet',
      contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
      rpcServer: makeRpcServer() as unknown as SoroWillRpcServer,
    });

    const mockWalletAdapter = {
      isConnected: async () => true,
      connect: async () => ({
        publicKey: 'GAA',
        network: 'mainnet',
        networkPassphrase: Networks.PUBLIC_NETWORK_PASSPHRASE,
      }),
      reconnect: async () => ({
        publicKey: 'GAA',
        network: 'mainnet',
        networkPassphrase: Networks.PUBLIC_NETWORK_PASSPHRASE,
      }),
      disconnect: async () => {},
      getPublicKey: async () => 'GAA',
      signTransaction: async (_tx: string) => 'signed_tx',
    };

    try {
      await testnetClient.checkIn('1', { publicKey: 'GOWNER' }, { walletAdapter: mockWalletAdapter as any });
      expect.unreachable('Should have thrown WalletNetworkMismatchError');
    } catch (error) {
      if (error instanceof WalletNetworkMismatchError) {
        expect(error.expectedNetworkPassphrase).toBe(Networks.TESTNET_PASSPHRASE);
        expect(error.actualNetworkPassphrase).toBe(Networks.PUBLIC_NETWORK_PASSPHRASE);
        expect(error.message).toContain('configured');
        expect(error.message).toContain('wallet');
      } else {
        throw error;
      }
    }
  });

  it('prevents silent state mixing between testnet and mainnet', async () => {
    const testnetClient = new SoroWillClient({
      network: 'testnet',
      contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
      rpcServer: makeRpcServer() as unknown as SoroWillRpcServer,
    });

    const mainnetWalletAdapter = {
      isConnected: async () => true,
      connect: async () => ({
        publicKey: 'GMAINNET_ACCOUNT',
        network: 'mainnet',
        networkPassphrase: Networks.PUBLIC_NETWORK_PASSPHRASE,
      }),
      reconnect: async () => ({
        publicKey: 'GMAINNET_ACCOUNT',
        network: 'mainnet',
        networkPassphrase: Networks.PUBLIC_NETWORK_PASSPHRASE,
      }),
      disconnect: async () => {},
      getPublicKey: async () => 'GMAINNET_ACCOUNT',
      signTransaction: async (_tx: string) => 'signed_tx',
    };

    const trigger = testnetClient.trigger('1', { publicKey: 'GOWNER' }, {
      walletAdapter: mainnetWalletAdapter as any,
    });

    await expect(trigger).rejects.toThrow(WalletNetworkMismatchError);
  });

  it('handles switch from testnet to mainnet mid-session gracefully', async () => {
    const testnetClient = new SoroWillClient({
      network: 'testnet',
      contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
      rpcServer: makeRpcServer() as unknown as SoroWillRpcServer,
    });

    const testnetAdapter = {
      isConnected: async () => true,
      connect: async () => ({
        publicKey: 'GTESTNET_ACCOUNT',
        network: 'testnet',
        networkPassphrase: Networks.TESTNET_PASSPHRASE,
      }),
      reconnect: async () => ({
        publicKey: 'GTESTNET_ACCOUNT',
        network: 'testnet',
        networkPassphrase: Networks.TESTNET_PASSPHRASE,
      }),
      disconnect: async () => {},
      getPublicKey: async () => 'GTESTNET_ACCOUNT',
      signTransaction: async (_tx: string) => 'signed_tx',
    };

    const mainnetAdapter = {
      isConnected: async () => true,
      connect: async () => ({
        publicKey: 'GMAINNET_ACCOUNT',
        network: 'mainnet',
        networkPassphrase: Networks.PUBLIC_NETWORK_PASSPHRASE,
      }),
      reconnect: async () => ({
        publicKey: 'GMAINNET_ACCOUNT',
        network: 'mainnet',
        networkPassphrase: Networks.PUBLIC_NETWORK_PASSPHRASE,
      }),
      disconnect: async () => {},
      getPublicKey: async () => 'GMAINNET_ACCOUNT',
      signTransaction: async (_tx: string) => 'signed_tx',
    };

    // First call with testnet adapter should work
    // (In reality this would fail with actual RPC, but mocked it doesn't)
    // The important thing is mainnet adapter should throw

    const mainnetCall = testnetClient.checkIn('1', { publicKey: 'GOWNER' }, {
      walletAdapter: mainnetAdapter as any,
    });

    await expect(mainnetCall).rejects.toThrow(WalletNetworkMismatchError);
  });

  it('detects mismatch between mainnet client and testnet wallet', async () => {
    const mainnetClient = new SoroWillClient({
      network: 'mainnet',
      contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
      rpcServer: makeRpcServer() as unknown as SoroWillRpcServer,
    });

    const testnetAdapter = {
      isConnected: async () => true,
      connect: async () => ({
        publicKey: 'GTESTNET_ACCOUNT',
        network: 'testnet',
        networkPassphrase: Networks.TESTNET_PASSPHRASE,
      }),
      reconnect: async () => ({
        publicKey: 'GTESTNET_ACCOUNT',
        network: 'testnet',
        networkPassphrase: Networks.TESTNET_PASSPHRASE,
      }),
      disconnect: async () => {},
      getPublicKey: async () => 'GTESTNET_ACCOUNT',
      signTransaction: async (_tx: string) => 'signed_tx',
    };

    await expect(
      mainnetClient.checkIn('1', { publicKey: 'GOWNER' }, { walletAdapter: testnetAdapter as any })
    ).rejects.toThrow(WalletNetworkMismatchError);
  });
});
