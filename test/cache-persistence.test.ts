import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { LocalStorageCachePersistenceAdapter, MemoryCachePersistenceAdapter, PersistedCacheEntry, ReadCache, IndexedDbCachePersistenceAdapter } from '../src/cache';

describe('LocalStorageCachePersistenceAdapter', () => {
  let storage: Storage;

  beforeEach(() => {
    storage = {
      getItem: (key: string) => null,
      setItem: () => {},
      removeItem: () => {},
      clear: () => {},
      key: () => null,
      length: 0,
    };
  });

  it('readAll returns empty array when no storage key exists', async () => {
    const adapter = new LocalStorageCachePersistenceAdapter(storage);
    const result = await adapter.readAll();
    expect(result).toEqual([]);
  });

  it('readAll returns empty array and clears storage when JSON is corrupted', async () => {
    let storedValue: string | null = '{ invalid json }';
    let removedKey: string | null = null;

    storage = {
      getItem: (key: string) => storedValue,
      setItem: () => {},
      removeItem: (key: string) => {
        removedKey = key;
        storedValue = null;
      },
      clear: () => {},
      key: () => null,
      length: 0,
    };

    const adapter = new LocalStorageCachePersistenceAdapter(storage);
    const result = await adapter.readAll();

    expect(result).toEqual([]);
    expect(removedKey).toBeDefined();
  });

  it('readAll handles JSON that is not an array', async () => {
    storage = {
      getItem: (key: string) => '{"not": "an array"}',
      setItem: () => {},
      removeItem: () => {},
      clear: () => {},
      key: () => null,
      length: 0,
    };

    const adapter = new LocalStorageCachePersistenceAdapter(storage);
    const result = await adapter.readAll();

    expect(result).toEqual([]);
  });

  it('readAll successfully parses valid cache entries', async () => {
    const entries: PersistedCacheEntry[] = [
      {
        key: 'test:key1',
        value: '"cached value"',
        expiresAt: Date.now() + 60000,
        willIds: [],
      },
    ];

    storage = {
      getItem: (key: string) => JSON.stringify(entries),
      setItem: () => {},
      removeItem: () => {},
      clear: () => {},
      key: () => null,
      length: 0,
    };

    const adapter = new LocalStorageCachePersistenceAdapter(storage);
    const result = await adapter.readAll();

    expect(result).toEqual(entries);
  });

  it('write stores entries in localStorage', async () => {
    let lastSetValue: string = '';

    storage = {
      getItem: () => null,
      setItem: (_key: string, value: string) => {
        lastSetValue = value;
      },
      removeItem: () => {},
      clear: () => {},
      key: () => null,
      length: 0,
    };

    const adapter = new LocalStorageCachePersistenceAdapter(storage);
    const entry: PersistedCacheEntry = {
      key: 'test:key',
      value: '"test value"',
      expiresAt: null,
      willIds: [],
    };

    await adapter.write(entry);

    const parsed = JSON.parse(lastSetValue) as PersistedCacheEntry[];
    expect(parsed).toContainEqual(entry);
  });

  it('delete removes entry from localStorage', async () => {
    const entries: PersistedCacheEntry[] = [
      { key: 'key1', value: '"val1"', expiresAt: null, willIds: [] },
      { key: 'key2', value: '"val2"', expiresAt: null, willIds: [] },
    ];

    let lastSetValue: string = '';

    storage = {
      getItem: () => JSON.stringify(entries),
      setItem: (_key: string, value: string) => {
        lastSetValue = value;
      },
      removeItem: () => {},
      clear: () => {},
      key: () => null,
      length: 0,
    };

    const adapter = new LocalStorageCachePersistenceAdapter(storage);
    await adapter.delete('key1');

    const remaining = JSON.parse(lastSetValue) as PersistedCacheEntry[];
    expect(remaining).toHaveLength(1);
    expect(remaining[0].key).toBe('key2');
  });

  it('clear removes the storage key', async () => {
    let removedKey: string | null = null;

    storage = {
      getItem: () => null,
      setItem: () => {},
      removeItem: (key: string) => {
        removedKey = key;
      },
      clear: () => {},
      key: () => null,
      length: 0,
    };

    const adapter = new LocalStorageCachePersistenceAdapter(storage);
    await adapter.clear();

    expect(removedKey).toBeDefined();
  });

  it('ReadCache construction does not throw with corrupted LocalStorageCachePersistenceAdapter', async () => {
    let removedKey: string | null = null;

    storage = {
      getItem: () => '{ invalid json }',
      setItem: () => {},
      removeItem: (key: string) => {
        removedKey = key;
      },
      clear: () => {},
      key: () => null,
      length: 0,
    };

    const adapter = new LocalStorageCachePersistenceAdapter(storage);
    const cache = new ReadCache({ persistence: adapter });

    await cache.ready();

    expect(removedKey).toBeDefined();
    expect(cache.get('test')).toBeUndefined();
  });
});

describe('MemoryCachePersistenceAdapter', () => {
  it('readAll returns empty array initially', async () => {
    const adapter = new MemoryCachePersistenceAdapter();
    const result = await adapter.readAll();
    expect(result).toEqual([]);
  });

  it('write and readAll store and retrieve entries', async () => {
    const adapter = new MemoryCachePersistenceAdapter();
    const entry: PersistedCacheEntry = {
      key: 'test:key',
      value: '"test value"',
      expiresAt: null,
      willIds: [],
    };

    await adapter.write(entry);
    const result = await adapter.readAll();

    expect(result).toContainEqual(entry);
  });

  it('write updates existing entry with same key', async () => {
    const adapter = new MemoryCachePersistenceAdapter();
    const entry1: PersistedCacheEntry = {
      key: 'test:key',
      value: '"value1"',
      expiresAt: null,
      willIds: [],
    };
    const entry2: PersistedCacheEntry = {
      key: 'test:key',
      value: '"value2"',
      expiresAt: null,
      willIds: [],
    };

    await adapter.write(entry1);
    await adapter.write(entry2);
    const result = await adapter.readAll();

    expect(result).toHaveLength(1);
    expect(result[0].value).toBe('"value2"');
  });

  it('delete removes entry', async () => {
    const adapter = new MemoryCachePersistenceAdapter();
    const entry: PersistedCacheEntry = {
      key: 'test:key',
      value: '"test value"',
      expiresAt: null,
      willIds: [],
    };

    await adapter.write(entry);
    await adapter.delete('test:key');
    const result = await adapter.readAll();

    expect(result).toEqual([]);
  });

  it('clear removes all entries', async () => {
    const adapter = new MemoryCachePersistenceAdapter();
    const entry1: PersistedCacheEntry = {
      key: 'key1',
      value: '"val1"',
      expiresAt: null,
      willIds: [],
    };
    const entry2: PersistedCacheEntry = {
      key: 'key2',
      value: '"val2"',
      expiresAt: null,
      willIds: [],
    };

    await adapter.write(entry1);
    await adapter.write(entry2);
    await adapter.clear();
    const result = await adapter.readAll();

    expect(result).toEqual([]);
  });
});

describe.skipIf(!globalThis.indexedDB)('IndexedDbCachePersistenceAdapter', () => {
  let adapter: IndexedDbCachePersistenceAdapter;
  const dbName = `test-db-${Math.random()}`;
  const storeName = 'test-store';

  beforeEach(async () => {
    adapter = new IndexedDbCachePersistenceAdapter({
      dbName,
      storeName,
    });
  });

  afterEach(async () => {
    try {
      await adapter.clear();
    } catch {
      // Ignore cleanup errors
    }
    const deleteReq = indexedDB.deleteDatabase(dbName);
    await new Promise<void>((resolve) => {
      deleteReq.onsuccess = () => resolve();
      deleteReq.onerror = () => resolve();
    });
  });

  it('readAll returns empty array initially', async () => {
    const result = await adapter.readAll();
    expect(result).toEqual([]);
  });

  it('write and readAll store and retrieve entries', async () => {
    const entry: PersistedCacheEntry = {
      key: 'test:key',
      value: '"test value"',
      expiresAt: null,
      willIds: [],
    };

    await adapter.write(entry);
    const result = await adapter.readAll();

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(entry);
  });

  it('write updates existing entry with same key', async () => {
    const entry1: PersistedCacheEntry = {
      key: 'test:key',
      value: '"value1"',
      expiresAt: null,
      willIds: [],
    };
    const entry2: PersistedCacheEntry = {
      key: 'test:key',
      value: '"value2"',
      expiresAt: null,
      willIds: [],
    };

    await adapter.write(entry1);
    await adapter.write(entry2);
    const result = await adapter.readAll();

    expect(result).toHaveLength(1);
    expect(result[0].value).toBe('"value2"');
  });

  it('delete removes specific entry', async () => {
    const entry1: PersistedCacheEntry = {
      key: 'key1',
      value: '"val1"',
      expiresAt: null,
      willIds: [],
    };
    const entry2: PersistedCacheEntry = {
      key: 'key2',
      value: '"val2"',
      expiresAt: null,
      willIds: [],
    };

    await adapter.write(entry1);
    await adapter.write(entry2);
    await adapter.delete('key1');
    const result = await adapter.readAll();

    expect(result).toHaveLength(1);
    expect(result[0].key).toBe('key2');
  });

  it('clear removes all entries', async () => {
    const entry1: PersistedCacheEntry = {
      key: 'key1',
      value: '"val1"',
      expiresAt: null,
      willIds: [],
    };
    const entry2: PersistedCacheEntry = {
      key: 'key2',
      value: '"val2"',
      expiresAt: null,
      willIds: [],
    };

    await adapter.write(entry1);
    await adapter.write(entry2);
    await adapter.clear();
    const result = await adapter.readAll();

    expect(result).toEqual([]);
  });

  it('handles multiple entries with bigint values', async () => {
    const entries: PersistedCacheEntry[] = [
      {
        key: 'key1',
        value: '{"__type":"bigint","value":"123456789"}',
        expiresAt: Date.now() + 60000,
        willIds: ['will1'],
      },
      {
        key: 'key2',
        value: '{"data":"test"}',
        expiresAt: null,
        willIds: ['will2', 'will3'],
      },
    ];

    for (const entry of entries) {
      await adapter.write(entry);
    }

    const result = await adapter.readAll();
    expect(result).toHaveLength(2);
    expect(result).toContainEqual(entries[0]);
    expect(result).toContainEqual(entries[1]);
  });
});
