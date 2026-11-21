import { Account, xdr } from '@stellar/stellar-sdk';
import { describe, expect, it, vi } from 'vitest';

import { SoroWillClient, type SoroWillRpcServer } from '../src/SoroWillClient';
import { SoroWillInvalidAmountError } from '../src/errors';

const TEST_ACCOUNT = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const VOID_SCVAL = xdr.ScVal.scvVoid();
const NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';

function makeClient() {
  const rpcServer = {
    getContractWasmByContractId: vi.fn(async () => new Uint8Array()),
    simulateTransaction: vi.fn(async () => ({ result: { retval: VOID_SCVAL } }) as never),
    getAccount: vi.fn(async (address: string) => new Account(address, '1')),
    prepareTransaction: vi.fn(async (tx: unknown) => tx as never),
    sendTransaction: vi.fn(async () => ({ status: 'PENDING', hash: 'fund123' }) as never),
    pollTransaction: vi.fn(
      async () => ({ status: 'SUCCESS', createdAt: 1_700_000_000, returnValue: VOID_SCVAL }) as never,
    ),
  };
  const connection = { publicKey: TEST_ACCOUNT, network: 'testnet', networkPassphrase: NETWORK_PASSPHRASE };
  const wallet = {
    isConnected: vi.fn(async () => true),
    connect: vi.fn(async () => connection),
    reconnect: vi.fn(async () => connection),
    disconnect: vi.fn(async () => {}),
    getPublicKey: vi.fn(async () => TEST_ACCOUNT),
    signTransaction: vi.fn(async (transactionXdr: string) => transactionXdr),
  };
  const client = new SoroWillClient({
    network: 'testnet',
    contractId: 'CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR',
    wallet,
    readCache: false,
    spec: {
      funcArgsToScVals: () => [] as xdr.ScVal[],
      funcResToNative: () => undefined,
    },
    rpcServer: rpcServer as unknown as SoroWillRpcServer,
  });
  return { client, rpcServer, wallet };
}

describe('Issue #725: fundWill supports partial top-ups', () => {
  it.each([
    ['zero', '0'],
    ['negative', '-10'],
    ['decimal', '1.5'],
    ['non-numeric', 'abc'],
    ['empty', ''],
  ])('rejects a %s amount before any wallet or RPC interaction', async (_label, amount) => {
    const { client, rpcServer, wallet } = makeClient();

    await expect(client.fundWill('1', amount)).rejects.toBeInstanceOf(SoroWillInvalidAmountError);

    expect(wallet.getPublicKey).not.toHaveBeenCalled();
    expect(rpcServer.simulateTransaction).not.toHaveBeenCalled();
    expect(rpcServer.sendTransaction).not.toHaveBeenCalled();
  });

  it('forwards a custom partial amount to the top-up and returns the remaining balance', async () => {
    const { client } = makeClient();
    const topUp = vi.spyOn(client, 'topUp').mockResolvedValue({ txHash: 'fund123' });
    vi.spyOn(client, 'getWill').mockResolvedValue({ balance: '750' } as never);

    const result = await client.fundWill('7', '250');

    expect(topUp).toHaveBeenCalledWith('7', '250', undefined);
    expect(result).toEqual({ txHash: 'fund123', remainingBalance: '750' });
  });

  it('reads the balance after the top-up has been submitted', async () => {
    const { client } = makeClient();
    const order: string[] = [];
    vi.spyOn(client, 'topUp').mockImplementation(async () => {
      order.push('topUp');
      return { txHash: 'fund123' };
    });
    vi.spyOn(client, 'getWill').mockImplementation(async () => {
      order.push('getWill');
      return { balance: '1000' } as never;
    });

    await client.fundWill('7', '1');

    expect(order).toEqual(['topUp', 'getWill']);
  });

  it('accepts amounts larger than Number.MAX_SAFE_INTEGER', async () => {
    const { client } = makeClient();
    const topUp = vi.spyOn(client, 'topUp').mockResolvedValue({ txHash: 'fund123' });
    vi.spyOn(client, 'getWill').mockResolvedValue({ balance: '9007199254740993' } as never);

    const result = await client.fundWill('7', '9007199254740993');

    expect(topUp).toHaveBeenCalledWith('7', '9007199254740993', undefined);
    expect(result.remainingBalance).toBe('9007199254740993');
  });
});
