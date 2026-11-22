import { describe, expect, it, vi } from 'vitest';

import { SoroWillClient, type SoroWillRpcServer } from '../src/SoroWillClient';
import type { BatchOperation } from '../src/types';
import type { WalletAdapter } from '../src/wallet';

const CONTRACT_ID = 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE';
const PUBLIC_KEY = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';

const wallet: WalletAdapter = {
  isConnected: async () => true,
  connect: async () => ({ publicKey: PUBLIC_KEY, network: '', networkPassphrase: '' }),
  reconnect: async () => ({ publicKey: PUBLIC_KEY, network: '', networkPassphrase: '' }),
  disconnect: async () => {},
  getPublicKey: async () => PUBLIC_KEY,
  signTransaction: async (tx: string) => tx,
};

type InvokeFn = (method: string, args: Record<string, unknown>) => Promise<{ txHash: string }>;

function makeClient(invoke: InvokeFn): { client: SoroWillClient; invokeSpy: ReturnType<typeof vi.fn> } {
  const client = new SoroWillClient({
    network: 'testnet',
    contractId: CONTRACT_ID,
    rpcServer: {} as SoroWillRpcServer,
    wallet,
  });
  const invokeSpy = vi.fn(invoke);
  (client as unknown as { invoke: InvokeFn }).invoke = invokeSpy;
  return { client, invokeSpy };
}

describe('Issue #660: conditional execution in SoroWillClient batch operations', () => {
  it('skips operations whose `when` predicate returns false based on prior results', async () => {
    const { client, invokeSpy } = makeClient(async (_method, args) => {
      if (args.will_id === '1') {
        throw new Error('first failed');
      }
      return { txHash: `tx-${String(args.will_id)}` };
    });

    const operations: BatchOperation[] = [
      { method: 'check_in', args: { will_id: '1' } },
      {
        method: 'check_in',
        args: { will_id: '2' },
        when: (prior) => prior[0]?.status === 'success',
      },
      {
        method: 'check_in',
        args: { will_id: '3' },
        when: (prior) => prior[1]?.status === 'skipped',
      },
    ];

    const result = await client.batchSequential(operations, { onFailure: 'continue' });

    expect(result.results.map((r) => r.status)).toEqual(['failed', 'skipped', 'success']);
    expect(result.succeededCount).toBe(1);
    expect(result.failedCount).toBe(1);
    expect(result.skippedCount).toBe(1);
    expect(result.results[1]!.attempts).toBe(0);
    expect(invokeSpy).toHaveBeenCalledTimes(2);
  });

  it('supports async `when` predicates in batchSequential', async () => {
    const { client, invokeSpy } = makeClient(async (_method, args) => ({
      txHash: `tx-${String(args.will_id)}`,
    }));

    const result = await client.batchSequential([
      { method: 'check_in', args: { will_id: '1' } },
      {
        method: 'check_in',
        args: { will_id: '2' },
        when: async () => false,
      },
    ]);

    expect(result.results.map((r) => r.status)).toEqual(['success', 'skipped']);
    expect(invokeSpy).toHaveBeenCalledTimes(1);
  });

  it('marks operation failed if `when` throws and respects onFailure', async () => {
    const { client, invokeSpy } = makeClient(async (_method, args) => ({
      txHash: `tx-${String(args.will_id)}`,
    }));

    const result = await client.batchSequential([
      {
        method: 'check_in',
        args: { will_id: '1' },
        when: () => {
          throw new Error('predicate boom');
        },
      },
      { method: 'check_in', args: { will_id: '2' } },
    ]);

    expect(result.results.map((r) => r.status)).toEqual(['failed', 'skipped']);
    expect(result.results[0]!.error?.message).toBe('predicate boom');
    expect(invokeSpy).not.toHaveBeenCalled();
  });

  it('skips a single operation in batch() when `when` returns false', async () => {
    const { client } = makeClient(async () => ({ txHash: 'unused' }));
    const result = await client.batch([
      {
        method: 'check_in',
        args: { will_id: '1' },
        when: () => false,
      },
    ]);

    expect(result.success).toBe(false);
    expect(result.txHash).toBe('');
    expect(result.results[0]).toMatchObject({ index: 0, method: 'check_in', status: 'skipped', attempts: 0 });
  });
});
