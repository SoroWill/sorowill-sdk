/**
 * Tests for issue #609: cache eviction doesn't use an LRU strategy, so old
 * entries are never evicted and memory grows unbounded for long-running
 * client instances.
 *
 * Fix: `ReadCache` is bounded by default (`DEFAULT_MAX_CACHE_ENTRIES`), the
 * bound is configurable through `maxEntries`, expired entries are pruned
 * before live ones, and the least-recently-used entry is evicted first.
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_MAX_CACHE_ENTRIES,
  MemoryCachePersistenceAdapter,
  ReadCache,
} from '../src/cache';

describe('ReadCache LRU eviction (#609)', () => {
  it('is bounded by DEFAULT_MAX_CACHE_ENTRIES when maxEntries is omitted', () => {
    const cache = new ReadCache();
    expect(cache.capacity).toBe(DEFAULT_MAX_CACHE_ENTRIES);

    for (let i = 0; i < DEFAULT_MAX_CACHE_ENTRIES + 50; i++) {
      cache.set(`key-${i}`, i);
    }

    expect(cache.size).toBe(DEFAULT_MAX_CACHE_ENTRIES);
    expect(cache.get('key-0')).toBeUndefined();
    expect(cache.get(`key-${DEFAULT_MAX_CACHE_ENTRIES + 49}`)).toBe(DEFAULT_MAX_CACHE_ENTRIES + 49);
  });

  it('respects a configured maxEntries', () => {
    const cache = new ReadCache({ maxEntries: 3 });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    cache.set('d', 4);

    expect(cache.size).toBe(3);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('d')).toBe(4);
  });

  it('evicts the least-recently-read entry rather than the oldest written', () => {
    const cache = new ReadCache({ maxEntries: 3 });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);

    // Touch `a` so `b` becomes the least-recently-used entry.
    expect(cache.get('a')).toBe(1);
    cache.set('d', 4);

    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(1);
    expect(cache.get('c')).toBe(3);
    expect(cache.get('d')).toBe(4);
  });

  it('treats overwriting a key as a use', () => {
    const cache = new ReadCache({ maxEntries: 2 });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('a', 10);
    cache.set('c', 3);

    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(10);
  });

  it('prunes expired entries before evicting live ones', () => {
    let now = 0;
    const cache = new ReadCache({ maxEntries: 2, ttlMs: 100, now: () => now });
    cache.set('stale', 1);
    now = 50;
    cache.set('fresh', 2);
    now = 120; // `stale` has expired, `fresh` has not.
    cache.set('newest', 3);

    expect(cache.size).toBe(2);
    expect(cache.get('fresh')).toBe(2);
    expect(cache.get('newest')).toBe(3);
  });

  it('removes evicted entries from persistence', async () => {
    const persistence = new MemoryCachePersistenceAdapter();
    const cache = new ReadCache({ maxEntries: 1, persistence });
    await cache.ready();

    cache.set('a', 1);
    cache.set('b', 2);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const keys = (await persistence.readAll()).map((entry) => entry.key);
    expect(keys).toEqual(['b']);
  });

  it('allows an explicitly unbounded cache with Infinity', () => {
    const cache = new ReadCache({ maxEntries: Infinity });
    for (let i = 0; i < DEFAULT_MAX_CACHE_ENTRIES + 10; i++) {
      cache.set(`key-${i}`, i);
    }
    expect(cache.size).toBe(DEFAULT_MAX_CACHE_ENTRIES + 10);
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects invalid maxEntries %s', (maxEntries) => {
    expect(() => new ReadCache({ maxEntries })).toThrow(/maxEntries/);
  });
});
