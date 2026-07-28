import { Account, Keypair, Networks, Operation, TransactionBuilder } from '@stellar/stellar-sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const publicKeyMock = vi.fn();
const txMock = vi.fn();

vi.mock('@albedo-link/intent', () => ({
  default: {
    publicKey: (...args: unknown[]) => publicKeyMock(...args),
    tx: (...args: unknown[]) => txMock(...args),
  },
}));

import { createAlbedoAdapter } from '../src/adapters/albedo';
import { freighterAdapter, type WalletAdapter } from '../src/wallet';

// A no-op reference to prove the exported adapters are assignable to the
// public WalletAdapter interface (compile-time contract check).
const _adapters: WalletAdapter[] = [freighterAdapter, createAlbedoAdapter()];
void _adapters;

describe('freighterAdapter', () => {
  it('implements the WalletAdapter interface', () => {
    expect(typeof freighterAdapter.getPublicKey).toBe('function');
    expect(typeof freighterAdapter.signTransaction).toBe('function');
  });
});

describe('createAlbedoAdapter', () => {
  beforeEach(() => {
    publicKeyMock.mockReset();
    txMock.mockReset();
  });

  it('returns the public key selected in Albedo', async () => {
    publicKeyMock.mockResolvedValue({ pubkey: 'GABC' });
    const adapter = createAlbedoAdapter();

    await expect(adapter.getPublicKey()).resolves.toBe('GABC');
  });

  it('signs a transaction and returns the signed envelope XDR', async () => {
    txMock.mockResolvedValue({ signed_envelope_xdr: 'SIGNED_XDR' });
    const adapter = createAlbedoAdapter();

    const signed = await adapter.signTransaction('UNSIGNED_XDR', {
      networkPassphrase: Networks.TESTNET,
    });

    expect(signed).toBe('SIGNED_XDR');
    expect(txMock).toHaveBeenCalledWith(
      expect.objectContaining({ xdr: 'UNSIGNED_XDR', network: 'testnet' }),
    );
  });

  it('maps the public network passphrase to Albedo "public"', async () => {
    txMock.mockResolvedValue({ signed_envelope_xdr: 'SIGNED_XDR' });
    const adapter = createAlbedoAdapter();

    await adapter.signTransaction('UNSIGNED_XDR', {
      networkPassphrase: Networks.PUBLIC,
    });

    expect(txMock).toHaveBeenCalledWith(expect.objectContaining({ network: 'public' }));
  });

  it('passes unknown passphrases through unchanged', async () => {
    txMock.mockResolvedValue({ signed_envelope_xdr: 'SIGNED_XDR' });
    const adapter = createAlbedoAdapter();

    await adapter.signTransaction('UNSIGNED_XDR', {
      networkPassphrase: 'Standalone Network ; February 2017',
    });

    expect(txMock).toHaveBeenCalledWith(
      expect.objectContaining({ network: 'Standalone Network ; February 2017' }),
    );
  });

  it('pins signatures to the previously selected public key', async () => {
    publicKeyMock.mockResolvedValue({ pubkey: 'GSELECTED' });
    txMock.mockResolvedValue({ signed_envelope_xdr: 'SIGNED_XDR' });
    const adapter = createAlbedoAdapter();

    await adapter.getPublicKey();
    await adapter.signTransaction('UNSIGNED_XDR', {
      networkPassphrase: Networks.TESTNET,
    });

    expect(txMock).toHaveBeenCalledWith(expect.objectContaining({ pubkey: 'GSELECTED' }));
  });

  it('omits pubkey before any account has been selected', async () => {
    txMock.mockResolvedValue({ signed_envelope_xdr: 'SIGNED_XDR' });
    const adapter = createAlbedoAdapter();

    await adapter.signTransaction('UNSIGNED_XDR', {
      networkPassphrase: Networks.TESTNET,
    });

    const call = txMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call).not.toHaveProperty('pubkey');
  });
});

describe('SoroWillClient wallet injection', () => {
  it('defaults to the Freighter adapter when no wallet is supplied', async () => {
    const { SoroWillClient } = await import('../src/SoroWillClient');
    const client = new SoroWillClient({ network: 'testnet', contractId: 'CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR' });
    expect(client).toBeInstanceOf(SoroWillClient);
  });

  it('accepts a custom WalletAdapter', async () => {
    const { SoroWillClient } = await import('../src/SoroWillClient');
    const customWallet: WalletAdapter = {
      isConnected: vi.fn().mockResolvedValue(true),
      connect: vi.fn().mockResolvedValue({ publicKey: 'GCUSTOM', network: 'testnet', networkPassphrase: Networks.TESTNET }),
      reconnect: vi.fn(),
      disconnect: vi.fn(),
      getPublicKey: vi.fn().mockResolvedValue('GCUSTOM'),
      signTransaction: vi.fn().mockResolvedValue('SIGNED'),
    };
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR',
      wallet: customWallet,
    });
    expect(client).toBeInstanceOf(SoroWillClient);
  });
});

import {
  HanaWalletAdapter,
  HotWalletAdapter,
  LedgerWalletAdapter,
  LobstrWalletAdapter,
  type InjectedWalletProvider,
  type LedgerStellarApp,
} from '../src/adapters';

const connection = {
  publicKey: 'GTEST',
  network: 'testnet',
  networkPassphrase: Networks.TESTNET,
};

function injectedProvider(): InjectedWalletProvider {
  return {
    connect: vi.fn().mockResolvedValue(connection),
    disconnect: vi.fn().mockResolvedValue(undefined),
    signTransaction: vi.fn().mockResolvedValue({ signedTxXdr: 'signed-xdr' }),
  };
}

describe.each([
  ['HanaWalletAdapter', HanaWalletAdapter],
  ['HotWalletAdapter', HotWalletAdapter],
])('%s', (_name, Adapter) => {
  it('connects and signs through its injected provider', async () => {
    const provider = injectedProvider();
    const adapter = new Adapter(provider);

    await expect(adapter.connect()).resolves.toEqual(connection);
    await expect(
      adapter.signTransaction('unsigned-xdr', {
        networkPassphrase: Networks.TESTNET,
      }),
    ).resolves.toBe('signed-xdr');
    await expect(adapter.getPublicKey()).resolves.toBe('GTEST');
  });

  it('clears its local connection on disconnect', async () => {
    const adapter = new Adapter(injectedProvider());
    await adapter.connect();
    await adapter.disconnect();

    await expect(adapter.isConnected()).resolves.toBe(false);
    await expect(adapter.getPublicKey()).rejects.toThrow('Call connect() first');
  });
});

describe('LobstrWalletAdapter', () => {
  it('publishes a pairing URI and waits for mobile approval', async () => {
    const approved = vi.fn().mockResolvedValue(connection);
    const onPairingUri = vi.fn();
    const openDeepLink = vi.fn();
    const client = {
      connect: vi.fn().mockResolvedValue({
        uri: 'wc:pairing@2?key=value',
        approval: approved,
      }),
      disconnect: vi.fn().mockResolvedValue(undefined),
      isConnected: vi.fn().mockResolvedValue(true),
      getPublicKey: vi.fn().mockResolvedValue('GTEST'),
      signTransaction: vi.fn().mockResolvedValue('signed-xdr'),
    };
    const adapter = new LobstrWalletAdapter({ client, onPairingUri, openDeepLink });

    await expect(adapter.connect()).resolves.toEqual(connection);
    expect(onPairingUri).toHaveBeenCalledWith('wc:pairing@2?key=value');
    expect(openDeepLink).toHaveBeenCalledWith(
      'lobstr://wallet-connect?uri=wc%3Apairing%402%3Fkey%3Dvalue',
    );
    expect(approved).toHaveBeenCalledOnce();
  });
});

describe('LedgerWalletAdapter', () => {
  it('waits for device confirmation and returns XDR with the Ledger signature', async () => {
    const keypair = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7));
    const transaction = new TransactionBuilder(new Account(keypair.publicKey(), '1'), {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(Operation.manageData({ name: 'test', value: 'value' }))
      .setTimeout(0)
      .build();

    let confirm: ((value: { signature: Buffer }) => void) | undefined;
    const confirmation = new Promise<{ signature: Buffer }>((resolve) => {
      confirm = resolve;
    });
    const app: LedgerStellarApp = {
      getPublicKey: vi.fn().mockResolvedValue({ rawPublicKey: keypair.rawPublicKey() }),
      signTransaction: vi.fn().mockReturnValue(confirmation),
    };
    const adapter = new LedgerWalletAdapter({
      transport: {} as never,
      app,
      network: 'testnet',
      networkPassphrase: Networks.TESTNET,
    });
    await adapter.connect();

    let resolved = false;
    const signing = adapter
      .signTransaction(transaction.toXDR(), { networkPassphrase: Networks.TESTNET })
      .then((xdr) => {
        resolved = true;
        return xdr;
      });
    await Promise.resolve();
    expect(resolved).toBe(false);

    confirm?.({ signature: keypair.sign(transaction.hash()) });
    const signed = TransactionBuilder.fromXDR(await signing, Networks.TESTNET);
    expect(signed.signatures).toHaveLength(1);
  });
});
