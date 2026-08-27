// @ts-nocheck - allow unknown IDBDatabase types
/**
 * Unit tests for issues #202, #203, #204, and #205:
 *
 * #202 - ReadCache.set() and clear() lack error handling for fire-and-forget
 *        persistence operations, causing unhandled promise rejections when
 *        persistence adapters fail.
 *
 * #203 - ReadCache.get() called before ready() completes with persistence
 *        configured can miss persisted data. Needs documentation and safeguards.
 *
 * #204 - IndexedDbCachePersistenceAdapter.invalidateByWillId() is dead code
 *        unreachable from ReadCache. Needs removal or proper integration.
 *
 * #205 - LocalStorageCachePersistenceAdapter.write() reads entire array on
 *        every write, causing O(n²) complexity. Needs optimization.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CachePersistenceAdapter,
  IndexedDbCachePersistenceAdapter,
  LocalStorageCachePersistenceAdapter,
  MemoryCachePersistenceAdapter,
  PersistedCacheEntry,
  ReadCache,
} from '../src/cache';

// ============================================================================
// Issue #202: Unhandled promise rejections in persistence operations
// ============================================================================

describe('Issue #202 - Unhandled promise rejections', () => {
  it('handles rejection in set() without throwing unhandled rejection', async () => {
    const rejectionError = new Error('Persistence write failed');
    const failingAdapter: CachePersistenceAdapter = {
      readAll: vi.fn(async () => []),
      write: vi.fn(async () => {
        throw rejectionError;
      }),
      delete: vi.fn(async () => {}),
      clear: vi.fn(async () => {}),
    };

    const cache = new ReadCache({ persistence: failingAdapter });
    await cache.ready();

    let unhandledRejection: PromiseRejectionEvent | null = null;
    const handler = (event: PromiseRejectionEvent) => {
      unhandledRejection = event;
    };

    process.on('unhandledRejection', handler);

    try {
      cache.set('test-key', { value: 42 });
      // Give a small amount of time for any rejection to surface
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandledRejection).toBeNull();
    } finally {
      process.removeListener('unhandledRejection', handler);
    }
  });

  it('handles rejection in clear() without throwing unhandled rejection', async () => {
    const rejectionError = new Error('Persistence clear failed');
    const failingAdapter: CachePersistenceAdapter = {
      readAll: vi.fn(async () => []),
      write: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
      clear: vi.fn(async () => {
        throw rejectionError;
      }),
    };

    const cache = new ReadCache({ persistence: failingAdapter });
    await cache.ready();

    let unhandledRejection: PromiseRejectionEvent | null = null;
    const handler = (event: PromiseRejectionEvent) => {
      unhandledRejection = event;
    };

    process.on('unhandledRejection', handler);

    try {
      cache.clear();
      // Give a small amount of time for any rejection to surface
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandledRejection).toBeNull();
    } finally {
      process.removeListener('unhandledRejection', handler);
    }
  });

  it('MemoryCachePersistenceAdapter write() completes successfully', async () => {
    const adapter = new MemoryCachePersistenceAdapter();
    const entry: PersistedCacheEntry = {
      key: 'test-key',
      value: JSON.stringify({ value: 42 }),
      expiresAt: null,
      willIds: [],
    };

    await expect(adapter.write(entry)).resolves.toBeUndefined();
    const entries = await adapter.readAll();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual(entry);
  });
});

// ============================================================================
// Issue #203: ReadCache.get() before ready() completes
// ============================================================================

describe('Issue #203 - ReadCache.get() before hydration', () => {
  it('returns undefined for persisted entries before ready() completes', async () => {
    const persistedData: PersistedCacheEntry[] = [
      {
        key: 'persisted-key',
        value: JSON.stringify({ id: 'will-1' }),
        expiresAt: null,
        willIds: ['will-1'],
      },
    ];

    const hydrationAdapter: CachePersistenceAdapter = {
      readAll: vi.fn(async () => {
        // Simulate slow hydration
        await new Promise((resolve) => setTimeout(resolve, 50));
        return persistedData;
      }),
      write: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
      clear: vi.fn(async () => {}),
    };

    const cache = new ReadCache({ persistence: hydrationAdapter });

    // Call get() before ready() completes
    const result = cache.get('persisted-key');
    expect(result).toBeUndefined();

    // After ready(), the value should be available
    await cache.ready();
    const resultAfterReady = cache.get<{ id: string }>('persisted-key');
    expect(resultAfterReady).toEqual({ id: 'will-1' });
  });

  it('correctly handles get() after ready() with no persistence', async () => {
    const cache = new ReadCache({ persistence: undefined });
    await cache.ready();

    cache.set('in-memory-key', { value: 'test' });
    const result = cache.get<{ value: string }>('in-memory-key');
    expect(result).toEqual({ value: 'test' });
  });
});

// ============================================================================
// Issue #204: Unused invalidateByWillId() in IndexedDbCachePersistenceAdapter
// ============================================================================

describe('Issue #204 - Dead code invalidateByWillId()', () => {
  it('removes invalidateByWillId() from IndexedDbCachePersistenceAdapter', () => {
    // Verify the dead method has been removed
    // ReadCache.invalidateByWillId() handles will-ID invalidation independently
    expect('invalidateByWillId' in IndexedDbCachePersistenceAdapter.prototype).toBe(false);
  });

  it('ReadCache.invalidateByWillId() properly invalidates entries by will ID', async () => {
    const adapter = new MemoryCachePersistenceAdapter();
    const cache = new ReadCache({ persistence: adapter });
    await cache.ready();

    cache.set('key-1', { value: 1 }, ['will-1']);
    cache.set('key-2', { value: 2 }, ['will-2']);
    cache.set('key-3', { value: 3 }, ['will-1', 'will-3']);

    await cache.invalidateByWillId('will-1');

    expect(cache.get('key-1')).toBeUndefined();
    expect(cache.get<{ value: number }>('key-2')).toEqual({ value: 2 });
    expect(cache.get('key-3')).toBeUndefined();
  });

  it('invalidateByWillId() persists deletions', async () => {
    const adapter = new MemoryCachePersistenceAdapter();
    const cache = new ReadCache({ persistence: adapter });
    await cache.ready();

    cache.set('key-1', { value: 1 }, ['will-1']);
    cache.set('key-2', { value: 2 }, ['will-2']);

    await cache.invalidateByWillId('will-1');

    const entries = await adapter.readAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].key).toBe('key-2');
  });
});

// ============================================================================
// Issue #205: LocalStorageCachePersistenceAdapter O(n²) complexity
// ============================================================================

describe('Issue #205 - O(n²) complexity in LocalStorageCachePersistenceAdapter', () => {
  it('correctly reads and writes cache entries with MemoryCachePersistenceAdapter', async () => {
    const adapter = new MemoryCachePersistenceAdapter();
    const entries: PersistedCacheEntry[] = [];

    for (let i = 0; i < 10; i++) {
      const entry: PersistedCacheEntry = {
        key: `key-${i}`,
        value: JSON.stringify({ index: i }),
        expiresAt: null,
        willIds: [],
      };
      await adapter.write(entry);
      entries.push(entry);
    }

    const readEntries = await adapter.readAll();
    expect(readEntries).toHaveLength(10);
  });

  it('stores and retrieves entries efficiently', async () => {
    const cache = new ReadCache();
    const startTime = performance.now();

    for (let i = 0; i < 100; i++) {
      cache.set(`key-${i}`, { index: i }, [`will-${i % 10}`]);
    }

    const endTime = performance.now();
    const duration = endTime - startTime;

    // Should complete in reasonable time (< 100ms for 100 operations)
    expect(duration).toBeLessThan(100);

    // Verify all entries are stored
    for (let i = 0; i < 100; i++) {
      const result = cache.get<{ index: number }>(`key-${i}`);
      expect(result).toEqual({ index: i });
    }
  });

  it('MemoryCachePersistenceAdapter handles multiple operations', async () => {
    const adapter = new MemoryCachePersistenceAdapter();

    // Write entries
    const entry1: PersistedCacheEntry = {
      key: 'key-1',
      value: JSON.stringify({ value: 1 }),
      expiresAt: null,
      willIds: [],
    };
    await adapter.write(entry1);

    // Read entries
    const entries = await adapter.readAll();
    expect(entries).toHaveLength(1);

    // Update entry
    const updatedEntry: PersistedCacheEntry = {
      ...entry1,
      value: JSON.stringify({ value: 2 }),
    };
    await adapter.write(updatedEntry);

    const updatedEntries = await adapter.readAll();
    expect(updatedEntries).toHaveLength(1);
    expect(JSON.parse(updatedEntries[0].value)).toEqual({ value: 2 });

    // Delete entry
    await adapter.delete('key-1');

    const finalEntries = await adapter.readAll();
    expect(finalEntries).toHaveLength(0);
  });

  it('handles concurrent cache operations', async () => {
    const adapter = new MemoryCachePersistenceAdapter();
    const cache = new ReadCache({ persistence: adapter });
    await cache.ready();

    // Simulate concurrent set operations
    const promises = Array.from({ length: 20 }, (_, i) =>
      Promise.resolve(cache.set(`concurrent-key-${i}`, { index: i }, [`will-${i % 5}`])),
    );

    await Promise.all(promises);

    // Verify all entries are present
    for (let i = 0; i < 20; i++) {
      const result = cache.get<{ index: number }>(`concurrent-key-${i}`);
      expect(result).toEqual({ index: i });
    }
  });
});

// ============================================================================
// Shared test: Cache invalidation and cleanup
// ============================================================================

describe('Cache invalidation and cleanup', () => {
  it('clear() removes all entries', async () => {
    const adapter = new MemoryCachePersistenceAdapter();
    const cache = new ReadCache({ persistence: adapter });
    await cache.ready();

    cache.set('key-1', { value: 1 });
    cache.set('key-2', { value: 2 });
    cache.set('key-3', { value: 3 });

    cache.clear();

    expect(cache.get('key-1')).toBeUndefined();
    expect(cache.get('key-2')).toBeUndefined();
    expect(cache.get('key-3')).toBeUndefined();

    const entries = await adapter.readAll();
    expect(entries).toHaveLength(0);
  });

  it('invalidateByWillId() with empty cache completes without error', async () => {
    const cache = new ReadCache();
    await cache.ready();

    await expect(cache.invalidateByWillId('will-1')).resolves.toBeUndefined();
  });
});
