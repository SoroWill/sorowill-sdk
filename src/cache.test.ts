import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IndexedDbCachePersistenceAdapter } from './cache';

/**
 * Minimal fake IndexedDB factory whose open() can be scripted to fail a
 * configurable number of times before succeeding. Only the surface used by
 * IndexedDbCachePersistenceAdapter is implemented.
 */
function createFakeIndexedDB(options: { failuresBeforeSuccess: number }) {
  let openCalls = 0;

  const makeRequest = () => {
    const request: any = {
      onsuccess: null,
      onerror: null,
      onupgradeneeded: null,
      onblocked: null,
      result: undefined,
      error: null,
    };
    return request;
  };

  const fakeDb: any = {
    objectStoreNames: { contains: () => true },
    createObjectStore: () => ({}),
    transaction: () => ({
      objectStore: () => ({
        get: () => {
          const req = makeRequest();
          queueMicrotask(() => {
            req.result = undefined;
            req.onsuccess && req.onsuccess();
          });
          return req;
        },
        put: () => {
          const req = makeRequest();
          queueMicrotask(() => req.onsuccess && req.onsuccess());
          return req;
        },
        delete: () => {
          const req = makeRequest();
          queueMicrotask(() => req.onsuccess && req.onsuccess());
          return req;
        },
      }),
    }),
    close: () => {},
  };

  const indexedDB: any = {
    open: () => {
      openCalls += 1;
      const request = makeRequest();
      const shouldFail = openCalls <= options.failuresBeforeSuccess;
      queueMicrotask(() => {
        if (shouldFail) {
          request.error = new Error('blocked');
          request.onerror && request.onerror();
        } else {
          request.result = fakeDb;
          request.onsuccess && request.onsuccess();
        }
      });
      return request;
    },
  };

  return { indexedDB, getOpenCalls: () => openCalls };
}

describe('IndexedDbCachePersistenceAdapter', () => {
  const originalIndexedDB = (globalThis as any).indexedDB;

  afterEach(() => {
    (globalThis as any).indexedDB = originalIndexedDB;
    vi.restoreAllMocks();
  });

  it('retries open() after a rejected open instead of caching the rejection', async () => {
    const fake = createFakeIndexedDB({ failuresBeforeSuccess: 1 });
    (globalThis as any).indexedDB = fake.indexedDB;

    const adapter = new IndexedDbCachePersistenceAdapter('test-db');

    // First call fails because the first open() rejects.
    await expect(adapter.get('missing')).rejects.toThrow();
    expect(fake.getOpenCalls()).toBe(1);

    // Second call must attempt to open again and succeed.
    await expect(adapter.get('missing')).resolves.toBeUndefined();
    expect(fake.getOpenCalls()).toBe(2);
  });
});
