/**
 * Tests for issue #620: Cache.get() doesn't check expiration before
 * returning, so expired entries can be served as fresh.
 *
 * Fix: ReadCache.get checks expiration on every retrieval (the expiry instant
 * itself counts as expired), invalidates expired entries in memory and in
 * persistence, and treats corrupted expiry timestamps as expired.
 */

import { describe, it, expect } from 'vitest';
import {
  MemoryCachePersistenceAdapter,
  ReadCache,
  type PersistedCacheEntry,
} from '../src/cache';

function clock(start = 1_000) {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe('issue #620 — ReadCache.get expiration', () => {
  it('returns the value right up to the expiration boundary', () => {
    const c = clock();
    const cache = new ReadCache({ ttlMs: 100, now: c.now });
    cache.set('k', 'v');

    c.advance(99);
    expect(cache.get('k')).toBe('v');
  });

  it('treats the exact expiration instant as expired', () => {
    const c = clock();
    const cache = new ReadCache({ ttlMs: 100, now: c.now });
    cache.set('k', 'v');

    c.advance(100);
    expect(cache.get('k')).toBeUndefined();
  });

  it('keeps an expired entry invalidated even if the clock moves backwards', () => {
    const c = clock();
    const cache = new ReadCache({ ttlMs: 100, now: c.now });
    cache.set('k', 'v');

    c.advance(150);
    expect(cache.get('k')).toBeUndefined();
    c.advance(-100);
    expect(cache.get('k')).toBeUndefined();
  });

  it('removes expired entries from persistence on retrieval', async () => {
    const c = clock();
    const persistence = new MemoryCachePersistenceAdapter();
    const cache = new ReadCache({ ttlMs: 100, now: c.now, persistence });
    await cache.ready();
    cache.set('k', 'v');
    await Promise.resolve();
    expect((await persistence.readAll()).map((e) => e.key)).toEqual(['k']);

    c.advance(100);
    expect(cache.get('k')).toBeUndefined();
    await Promise.resolve();
    expect(await persistence.readAll()).toEqual([]);
  });

  it('does not hydrate entries that expire exactly at load time', async () => {
    const persistence = new MemoryCachePersistenceAdapter();
    await persistence.write({ key: 'k', value: '"v"', expiresAt: 1_000, willIds: [] });

    const cache = new ReadCache({ ttlMs: 100, now: () => 1_000, persistence });
    await cache.ready();

    expect(cache.get('k')).toBeUndefined();
    expect(await persistence.readAll()).toEqual([]);
  });

  it('treats a corrupted persisted expiresAt as expired', async () => {
    const persistence = new MemoryCachePersistenceAdapter();
    await persistence.write({
      key: 'k',
      value: '"v"',
      expiresAt: 'tomorrow' as unknown as number,
      willIds: [],
    } as PersistedCacheEntry);

    const cache = new ReadCache({ ttlMs: 100, now: () => 1_000, persistence });
    await cache.ready();

    expect(cache.get('k')).toBeUndefined();
  });
});
