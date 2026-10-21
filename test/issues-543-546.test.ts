import { StrKey } from '@stellar/stellar-sdk';
import { describe, expect, it, vi } from 'vitest';
import { ReadCache, type CachePersistenceAdapter, type PersistedCacheEntry } from '../src/cache';
import { RequestPriority, RequestQueue } from '../src/requestQueue';
import { HanaWalletAdapter } from '../src/adapters';
import { SoroWillClient } from '../src/SoroWillClient';
import { InvalidContractIdError } from '../src/errors';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function persistence() {
  const entries = new Map<string, PersistedCacheEntry>();
  const adapter: CachePersistenceAdapter = {
    readAll: async () => [...entries.values()],
    write: vi.fn(async (entry: PersistedCacheEntry) => { entries.set(entry.key, entry); }),
    delete: vi.fn(async (key: string) => { entries.delete(key); }),
    clear: vi.fn(async () => { entries.clear(); }),
  };
  return { adapter, entries };
}

describe('cache persistence locking (#543)', () => {
  it('serializes concurrent writes across caches sharing an adapter', async () => {
    const { adapter, entries } = persistence();
    const gate = deferred();
    let active = 0;
    let maxActive = 0;
    const writes: string[] = [];
    adapter.write = vi.fn(async (entry) => {
      active++;
      maxActive = Math.max(maxActive, active);
      writes.push(entry.value);
      if (writes.length === 1) await gate.promise;
      entries.set(entry.key, entry);
      active--;
    });
    const caches = [new ReadCache({ persistence: adapter }), new ReadCache({ persistence: adapter })];
    await Promise.all(caches.map((cache) => cache.ready()));
    await Promise.all(Array.from({ length: 20 }, async (_, i) => {
      await Promise.resolve();
      caches[i % 2]!.set('shared', i);
    }));
    expect(writes).toEqual(['0']);
    gate.resolve();
    await vi.waitFor(() => expect(writes).toHaveLength(20));
    expect(maxActive).toBe(1);
    expect(writes).toEqual(Array.from({ length: 20 }, (_, i) => String(i)));
    expect(entries.get('shared')?.value).toBe('19');
  });

  it('protects adapters that update multiple keys in one document and snapshots queued values', async () => {
    const { adapter } = persistence();
    let document: PersistedCacheEntry[] = [];
    adapter.write = async (entry) => {
      const snapshot = [...document];
      await Promise.resolve();
      document = [...snapshot.filter((stored) => stored.key !== entry.key), entry];
    };
    const cache = new ReadCache({ persistence: adapter });
    await cache.ready();
    const value = { count: 1 };
    cache.set('first', value);
    cache.set('second', 2);
    value.count = 99;
    await vi.waitFor(() => expect(document).toHaveLength(2));
    expect(document.map((entry) => [entry.key, entry.value])).toEqual([
      ['first', '{"count":1}'], ['second', '2'],
    ]);
  });

  it('orders deletion and clearing after pending writes and before subsequent writes', async () => {
    const { adapter, entries } = persistence();
    const gate = deferred();
    vi.mocked(adapter.write).mockImplementationOnce(async (entry) => {
      await gate.promise;
      entries.set(entry.key, entry);
    });
    const cache = new ReadCache({ persistence: adapter });
    await cache.ready();
    cache.set('key', 'stale');
    const invalidated = cache.invalidate('key');
    await Promise.resolve();
    expect(adapter.delete).not.toHaveBeenCalled();
    gate.resolve();
    await invalidated;
    expect(entries.has('key')).toBe(false);
    cache.set('key', 'before clear');
    cache.clear();
    cache.set('key', 'after clear');
    await vi.waitFor(() => expect(entries.get('key')?.value).toBe('"after clear"'));
    expect(adapter.clear).toHaveBeenCalledOnce();
  });

  it('releases the lock after rejected and synchronously thrown writes', async () => {
    const { adapter, entries } = persistence();
    vi.mocked(adapter.write)
      .mockRejectedValueOnce(new Error('storage failure'))
      .mockImplementationOnce(() => { throw new Error('sync storage failure'); });
    const cache = new ReadCache({ persistence: adapter });
    await cache.ready();
    cache.set('key', 1);
    cache.set('key', 2);
    cache.set('key', 3);
    await vi.waitFor(() => expect(entries.get('key')?.value).toBe('3'));
    expect(cache.get('key')).toBe(3);
  });

  it('does not delete a fresh write while hydrating an expired version', async () => {
    const { adapter, entries } = persistence();
    const gate = deferred();
    adapter.readAll = async () => {
      await gate.promise;
      return [{ key: 'key', value: '0', expiresAt: 1, willIds: [] }];
    };
    const cache = new ReadCache({ persistence: adapter, now: () => 100 });
    cache.set('key', 42);
    gate.resolve();
    await cache.ready();
    await vi.waitFor(() => expect(entries.get('key')?.value).toBe('42'));
    expect(adapter.delete).not.toHaveBeenCalled();
    expect(cache.get('key')).toBe(42);
  });
});

describe('constructor contract StrKey validation (#544)', () => {
  it.each(['', 'C'.repeat(56), StrKey.encodeEd25519PublicKey(Buffer.alloc(32))])(
    'rejects invalid contract ID %s before constructing an RPC server', (contractId) => {
      expect(() => new SoroWillClient({ network: 'testnet', contractId, rpcUrl: 'invalid-url' }))
        .toThrow(InvalidContractIdError);
    },
  );

  it('uses the installed SDK contract validator and accepts a valid contract ID', () => {
    const validator = vi.spyOn(StrKey, 'isValidContract');
    const contractId = StrKey.encodeContract(Buffer.alloc(32, 7));
    const client = new SoroWillClient({ network: 'testnet', contractId });
    expect(validator).toHaveBeenCalledWith(contractId);
    client.destroy();
    validator.mockRestore();
  });
});

describe('wallet connection paths (#545)', () => {
  const connection = { publicKey: 'GTEST', network: 'testnet', networkPassphrase: 'test' };

  it('supports first connection and repeated successful provider connections', async () => {
    const provider = { connect: vi.fn().mockResolvedValue(connection), signTransaction: vi.fn() };
    const wallet = new HanaWalletAdapter(provider);
    await expect(wallet.isConnected()).resolves.toBe(false);
    await expect(wallet.connect()).resolves.toEqual(connection);
    await expect(wallet.connect()).resolves.toEqual(connection);
    expect(provider.connect).toHaveBeenCalledTimes(2);
    await expect(wallet.reconnect()).resolves.toEqual(connection);
    expect(provider.connect).toHaveBeenCalledTimes(2);
  });

  it('propagates provider rejection on repeated connect and preserves the existing session', async () => {
    const denied = new Error('Connection approval denied');
    const provider = {
      connect: vi.fn().mockResolvedValueOnce(connection).mockRejectedValueOnce(denied),
      signTransaction: vi.fn(),
    };
    const wallet = new HanaWalletAdapter(provider);
    await wallet.connect();
    await expect(wallet.connect()).rejects.toBe(denied);
    await expect(wallet.reconnect()).resolves.toEqual(connection);
    expect(provider.connect).toHaveBeenCalledTimes(2);
  });
});

describe('atomic queue removal (#546)', () => {
  it('runs requests from concurrent producers sharing a core exactly once', async () => {
    const queues = Array.from({ length: 4 }, () => new RequestQueue({
      account: 'issue-546', maxConcurrent: 4, requestsPerSecond: 1000,
    }));
    const calls = Array<number>(100).fill(0);
    let active = 0;
    let peak = 0;
    try {
      const results = await Promise.all(Array.from({ length: 100 }, async (_, i) => {
        await Promise.resolve();
        return queues[i % queues.length]!.enqueue(async () => {
          calls[i]!++;
          active++;
          peak = Math.max(peak, active);
          await Promise.resolve();
          active--;
          return i;
        });
      }));
      expect(results).toEqual(Array.from({ length: 100 }, (_, i) => i));
      expect(calls).toEqual(Array(100).fill(1));
      expect(peak).toBe(4);
    } finally {
      queues.forEach((queue) => queue.release());
    }
  });

  it('handles reentrant enqueue and abort while draining without losing pending requests', async () => {
    const queue = new RequestQueue({ maxConcurrent: 1, requestsPerSecond: 100 });
    const gate = deferred();
    const first = queue.enqueue(() => gate.promise);
    const controller = new AbortController();
    const canceled = vi.fn(async () => 'canceled');
    const canceledResult = queue.enqueue(canceled, undefined, controller.signal).catch((error: unknown) => error);
    const order: string[] = [];
    let nested!: Promise<void>;
    const high = queue.enqueue(async () => {
      controller.abort('canceled');
      order.push('high');
      nested = queue.enqueue(async () => { order.push('nested'); });
    }, undefined, undefined, RequestPriority.High);
    const normal = queue.enqueue(async () => { order.push('normal'); });
    gate.resolve();
    await Promise.all([first, high, normal]);
    await nested;
    expect(await canceledResult).toBe('canceled');
    expect(canceled).not.toHaveBeenCalled();
    expect(order).toEqual(['high', 'normal', 'nested']);
  });
});
