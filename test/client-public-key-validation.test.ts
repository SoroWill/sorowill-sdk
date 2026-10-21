import { Account, Keypair, Networks, TransactionBuilder, xdr } from '@stellar/stellar-sdk';
import { describe, expect, it, vi } from 'vitest';
import { SoroWillClient, type SoroWillRpcServer } from '../src/SoroWillClient';
import { AccountNotFundedError, InvalidPublicKeyError } from '../src/errors';

const PUBLIC_KEY = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const CONTRACT_ID = 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE';

function setup(publicKey = PUBLIC_KEY) {
  const wallet = {
    isConnected: async () => true,
    connect: async () => ({ publicKey, network: 'testnet', networkPassphrase: Networks.TESTNET }),
    reconnect: async () => ({ publicKey, network: 'testnet', networkPassphrase: Networks.TESTNET }),
    disconnect: async () => {},
    getPublicKey: vi.fn(async () => publicKey),
    signTransaction: vi.fn(async (tx: string) => tx),
  };
  const spec = {
    funcArgsToScVals: vi.fn(() => []),
    funcResToNative: vi.fn(() => undefined),
  };
  const server = {
    getAccount: vi.fn(async (key: string) => new Account(key, '1')),
    getContractWasmByContractId: vi.fn(async () => new Uint8Array()),
    simulateTransaction: vi.fn(),
    prepareTransaction: vi.fn(async (tx) => tx),
    sendTransaction: vi.fn(async () => ({ status: 'PENDING' as const, hash: 'hash' })),
    pollTransaction: vi.fn(async () => ({
      status: 'SUCCESS' as const, createdAt: 1, returnValue: xdr.ScVal.scvVoid(),
    })),
  };
  const client = new SoroWillClient({
    network: 'testnet', contractId: CONTRACT_ID, wallet, spec, rpcServer: server as unknown as SoroWillRpcServer,
  });
  return { client, wallet, spec, server };
}

describe('client public key validation', () => {
  const invalidKeys = [
    '', 'GTESTACCOUNT', PUBLIC_KEY.toLowerCase(),
    PUBLIC_KEY.slice(0, -1) + 'A', CONTRACT_ID, Keypair.random().secret(),
  ];

  it.each(invalidKeys)('rejects malformed wallet key %s before encoding or RPC', async (key) => {
    const { client, wallet, spec, server } = setup(key);
    await expect(client.checkIn('1')).rejects.toBeInstanceOf(InvalidPublicKeyError);
    expect(spec.funcArgsToScVals).not.toHaveBeenCalled();
    expect(server.getAccount).not.toHaveBeenCalled();
    expect(wallet.signTransaction).not.toHaveBeenCalled();
  });

  it.each(['buildTransaction', 'buildSep7SigningUri'] as const)(
    '%s rejects explicit invalid keys before encoding or RPC', async (method) => {
      const { client, wallet, spec, server } = setup();
      const result = method === 'buildTransaction'
        ? client.buildTransaction('check_in', {}, '')
        : client.buildSep7SigningUri('check_in', {}, '', { callbackUrl: 'https://example.com/callback' });
      await expect(result).rejects.toMatchObject({
        name: 'InvalidPublicKeyError', field: 'sourcePublicKey',
      });
      expect(spec.funcArgsToScVals).not.toHaveBeenCalled();
      expect(server.getAccount).not.toHaveBeenCalled();
      expect(wallet.getPublicKey).not.toHaveBeenCalled();
    },
  );

  it('validates batch wallet keys before encoding or account lookup', async () => {
    const { client, spec, server, wallet } = setup('invalid');
    await expect(client.batch([{ method: 'check_in', args: {} }]))
      .rejects.toBeInstanceOf(InvalidPublicKeyError);
    expect(spec.funcArgsToScVals).not.toHaveBeenCalled();
    expect(server.getAccount).not.toHaveBeenCalled();
    expect(wallet.signTransaction).not.toHaveBeenCalled();
  });

  it('validates the wallet key before submitting signed transactions', async () => {
    const { client, server } = setup('invalid');
    const tx = new TransactionBuilder(new Account(PUBLIC_KEY, '1'), {
      fee: '100', networkPassphrase: Networks.TESTNET,
    }).setTimeout(30).build();
    await expect(client.submitSignedTransaction(tx.toXDR()))
      .rejects.toBeInstanceOf(InvalidPublicKeyError);
    expect(server.getAccount).not.toHaveBeenCalled();
    expect(server.sendTransaction).not.toHaveBeenCalled();
  });

  it('accepts a valid explicit key without consulting the wallet', async () => {
    const { client, server, wallet } = setup('invalid');
    await client.buildTransaction('check_in', {}, PUBLIC_KEY);
    expect(server.getAccount).toHaveBeenCalledWith(PUBLIC_KEY);
    expect(wallet.getPublicKey).not.toHaveBeenCalled();
  });

  it('preserves funding guidance when an account lookup fails during submission', async () => {
    const { client, server, wallet } = setup();
    const cause = new Error('account not found');
    server.getAccount.mockRejectedValue(cause);
    await expect(client.cancelWill('1')).rejects.toMatchObject({
      name: 'AccountNotFundedError', publicKey: PUBLIC_KEY, cause,
      message: expect.stringContaining('https://friendbot.stellar.org'),
    });
    expect(wallet.signTransaction).not.toHaveBeenCalled();
  });

  it('explains XLM funding, links to testnet funding, and preserves error details', () => {
    const cause = new Error('not found');
    const error = new AccountNotFundedError(PUBLIC_KEY, { cause });
    expect(error.message).toContain('XLM');
    expect(error.message).toContain('reserve and transaction fees');
    expect(error.message).toContain('https://friendbot.stellar.org');
    expect(error.message).toContain('testnet only');
    expect(error.message).toContain('On mainnet, transfer real XLM');
    expect(error.message).not.toContain(PUBLIC_KEY);
    expect(error.publicKey).toBe(PUBLIC_KEY);
    expect(error.cause).toBe(cause);
  });
});
