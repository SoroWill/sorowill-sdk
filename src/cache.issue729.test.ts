/**
 * Tests for issue #729: cache statistics API for debugging.
 *
 * Verifies that ReadCache.getCacheStats() reports hit rate, eviction count,
 * and an estimated memory footprint.
 */
import { describe, it, expect } from 'vitest';
import { ReadCache } from './cache';

describe('#729 ReadCache.getCacheStats', () => {
  it('starts with empty counters and a 0% hit rate', () => {
    const cache = new ReadCache({ ttlMs: 60_000 });
    expect(cache.getCacheStats()).toEqual({
      hits: 0,
      misses: 0,
      hitRate: 0,
      evictions: 0,
      size: 0,
      memoryUsageBytes: 0,
    });
  });

  it('tracks hits, misses and the hit rate percentage', () => {
    const cache = new ReadCache({ ttlMs: 60_000 });
    cache.set('a', 1);
    cache.get('a'); // hit
    cache.get('a'); // hit
    cache.get('a'); // hit
    cache.get('missing'); // miss

    const stats = cache.getCacheStats();
    expect(stats.hits).toBe(3);
    expect(stats.misses).toBe(1);
    expect(stats.hitRate).toBe(75);
  });

  it('counts an expired lookup as a miss', () => {
    let now = 1_000;
    const cache = new ReadCache({ ttlMs: 100, now: () => now });
    cache.set('a', 'value');
    now += 100;
    expect(cache.get('a')).toBeUndefined();

    const stats = cache.getCacheStats();
    expect(stats.hits).toBe(0);
    expect(stats.misses).toBe(1);
  });

  it('tracks eviction count when maxEntries is exceeded', () => {
    const cache = new ReadCache({ ttlMs: 60_000, maxEntries: 2 });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3); // evicts 'a'
    cache.set('d', 4); // evicts 'b'

    const stats = cache.getCacheStats();
    expect(stats.evictions).toBe(2);
    expect(stats.size).toBe(2);
    expect(cache.get('a')).toBeUndefined();
  });

  it('estimates memory usage from stored keys and serialized values', () => {
    const cache = new ReadCache({ ttlMs: 60_000 });
    cache.set('k', 'abcdefghij');
    const small = cache.getCacheStats().memoryUsageBytes;
    expect(small).toBeGreaterThan(0);

    cache.set('k2', 'x'.repeat(1_000));
    expect(cache.getCacheStats().memoryUsageBytes).toBeGreaterThan(small + 1_000);
  });

  it('reports memory as zero again after clear()', () => {
    const cache = new ReadCache({ ttlMs: 60_000 });
    cache.set('a', 'value');
    cache.clear();
    expect(cache.getCacheStats().memoryUsageBytes).toBe(0);
    expect(cache.getCacheStats().size).toBe(0);
  });
});
