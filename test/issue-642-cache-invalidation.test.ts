import { describe, expect, it } from 'vitest';

import { MemoryCachePersistenceAdapter, ReadCache } from '../src/cache';

describe('ReadCache explicit invalidation (#642)', () => {
  it('invalidates one key in memory and persistence', async () => {
    const persistence = new MemoryCachePersistenceAdapter();
    const cache = new ReadCache({ persistence });
    await cache.ready();
    cache.set('first', 'stale', ['will-1']);
    cache.set('second', 'fresh', ['will-2']);

    await cache.invalidate('first');

    expect(cache.get('first')).toBeUndefined();
    expect(cache.get('second')).toBe('fresh');
    expect((await persistence.readAll()).map((entry) => entry.key)).toEqual(['second']);
  });

  it('invalidates all keys in memory and persistence', async () => {
    const persistence = new MemoryCachePersistenceAdapter();
    const cache = new ReadCache({ persistence });
    await cache.ready();
    cache.set('first', 'one', ['will-1']);
    cache.set('second', 'two', ['will-2']);

    await cache.invalidateAll();

    expect(cache.size).toBe(0);
    expect(cache.get('first')).toBeUndefined();
    expect(cache.get('second')).toBeUndefined();
    expect(await persistence.readAll()).toEqual([]);
  });
});
