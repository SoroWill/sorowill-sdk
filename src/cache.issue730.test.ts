/**
 * Tests for issue #730: persistent cache with IndexedDB.
 *
 * Covers the optional IndexedDB adapter: graceful fallback when IndexedDB is
 * unavailable, the 1 MB size budget, and automatic cleanup of expired entries.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  IndexedDbCachePersistenceAdapter,
  DEFAULT_INDEXEDDB_CACHE_MAX_BYTES,
  isIndexedDbAvailable,
  type PersistedCacheEntry,
} from './cache';

/** Minimal in-memory IndexedDB stand-in covering the calls the adapter makes. */
function installFakeIndexedDb(): void {
  const stores = new Map<string, Map<string, PersistedCacheEntry>>();

  const makeRequest = (): Record<string, unknown> => ({
    result: undefined,
    error: null,
    onsuccess: null,
    onerror: null,
  });
  const complete = (request: Record<string, unknown>, result: unknown): void => {
    queueMicrotask(() => {
      request.result = result;
      (request.onsuccess as (() => void) | null)?.();
    });
  };

  const db = {
    objectStoreNames: { contains: (name: string) => stores.has(name) },
    createObjectStore: (name: string) => {
      stores.set(name, new Map());
    },
    transaction: (name: string) => ({
      objectStore: () => {
        const table = () => stores.get(name)!;
        return {
          getAll: () => {
            const request = makeRequest();
            complete(request, [...table().values()].map((e) => structuredClone(e)));
            return request;
          },
          put: (entry: PersistedCacheEntry) => {
            const request = makeRequest();
            table().set(entry.key, structuredClone(entry));
            complete(request, entry.key);
            return request;
          },
          delete: (key: string) => {
            const request = makeRequest();
            table().delete(key);
            complete(request, undefined);
            return request;
          },
          clear: () => {
            const request = makeRequest();
            table().clear();
            complete(request, undefined);
            return request;
          },
        };
      },
    }),
  };

  (globalThis as { indexedDB?: unknown }).indexedDB = {
    open: () => {
      const request = makeRequest();
      queueMicrotask(() => {
        (request as { onupgradeneeded?: (e: unknown) => void }).onupgradeneeded?.({
          target: { result: db },
        });
        request.result = db;
        (request.onsuccess as (() => void) | null)?.();
      });
      return request;
    },
  };
}

function entry(key: string, valueLength: number, expiresAt: number | null): PersistedCacheEntry {
  return { key, value: 'x'.repeat(valueLength), expiresAt, willIds: [] };
}

describe('#730 IndexedDbCachePersistenceAdapter', () => {
  const originalIndexedDb = (globalThis as { indexedDB?: unknown }).indexedDB;

  afterEach(() => {
    (globalThis as { indexedDB?: unknown }).indexedDB = originalIndexedDb;
  });

  describe('graceful fallback', () => {
    beforeEach(() => {
      delete (globalThis as { indexedDB?: unknown }).indexedDB;
    });

    it('reports IndexedDB as unavailable when the API is missing', () => {
      expect(isIndexedDbAvailable()).toBe(false);
      expect(new IndexedDbCachePersistenceAdapter().isAvailable()).toBe(false);
    });

    it('returns no entries and does not throw when IndexedDB is missing', async () => {
      const adapter = new IndexedDbCachePersistenceAdapter();
      await expect(adapter.readAll()).resolves.toEqual([]);
      await expect(adapter.write(entry('a', 10, null))).resolves.toBeUndefined();
      await expect(adapter.delete('a')).resolves.toBeUndefined();
      await expect(adapter.clear()).resolves.toBeUndefined();
    });
  });

  describe('with IndexedDB available', () => {
    beforeEach(() => {
      installFakeIndexedDb();
    });

    it('defaults the size budget to 1 MB', () => {
      expect(DEFAULT_INDEXEDDB_CACHE_MAX_BYTES).toBe(1_048_576);
    });

    it('round-trips a written entry', async () => {
      const adapter = new IndexedDbCachePersistenceAdapter('db-roundtrip');
      expect(adapter.isAvailable()).toBe(true);
      await adapter.write(entry('a', 5, Date.now() + 60_000));
      const stored = await adapter.readAll();
      expect(stored.map((e) => e.key)).toEqual(['a']);
    });

    it('rejects a single entry larger than the size budget', async () => {
      const adapter = new IndexedDbCachePersistenceAdapter('db-oversize', 'entries', {
        maxBytes: 100,
      });
      // (1 key char + 100 value chars) * 2 bytes = 202 bytes > 100
      await expect(adapter.write(entry('a', 100, null))).rejects.toThrow(/exceeds/);
    });

    it('evicts the entries closest to expiry when the total exceeds the budget', async () => {
      const adapter = new IndexedDbCachePersistenceAdapter('db-budget', 'entries', {
        maxBytes: 1_000,
      });
      const now = Date.now();
      // Each entry is (1 + 199) * 2 = 400 bytes.
      await adapter.write(entry('soonest', 199, now + 1_000));
      await adapter.write(entry('middle', 199, now + 2_000));
      await adapter.write(entry('latest', 199, now + 3_000));

      const keys = (await adapter.readAll()).map((e) => e.key).sort();
      expect(keys).toEqual(['latest', 'middle']);
    });

    it('keeps entries without an expiry longest during budget eviction', async () => {
      const adapter = new IndexedDbCachePersistenceAdapter('db-no-expiry', 'entries', {
        maxBytes: 1_000,
      });
      const now = Date.now();
      await adapter.write(entry('forever', 199, null));
      await adapter.write(entry('expiring', 199, now + 1_000));
      await adapter.write(entry('extra', 199, now + 5_000));

      const keys = (await adapter.readAll()).map((e) => e.key).sort();
      expect(keys).toContain('forever');
      expect(keys).not.toContain('expiring');
    });

    it('automatically drops expired entries when the store is read', async () => {
      const adapter = new IndexedDbCachePersistenceAdapter('db-expired');
      await adapter.write(entry('stale', 5, Date.now() - 1));
      await adapter.write(entry('fresh', 5, Date.now() + 60_000));

      const first = (await adapter.readAll()).map((e) => e.key);
      expect(first).toEqual(['fresh']);

      // The stale entry was removed from storage, not just filtered out.
      await new Promise((resolve) => setTimeout(resolve, 0));
      const second = (await adapter.readAll()).map((e) => e.key);
      expect(second).toEqual(['fresh']);
    });
  });
});
