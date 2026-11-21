/**
 * Issue #713 — Cache key collision for different networks.
 *
 * Acceptance criteria:
 * - Cache keys include network ID
 * - Testnet and mainnet never collide
 * - Network switch clears relevant cache
 * - Tests verify no collision
 */
import { describe, expect, it } from 'vitest';
import { ReadCache, createReadCacheKey } from '../src/cache';

const TESTNET = 'Test SDF Network ; September 2015';
const MAINNET = 'Public Global Stellar Network ; September 2015';

describe('Issue #713 — cache keys are scoped by network', () => {
  it('a value cached on testnet is not returned after switching to mainnet', () => {
    const cache = new ReadCache();
    cache.setNetwork(TESTNET);
    const key = createReadCacheKey('get_will', { willId: '1' });
    cache.set(key, { network: 'testnet' });

    expect(cache.setNetwork(MAINNET)).toBe(true);
    expect(cache.get(key)).toBeUndefined();
  });

  it('testnet and mainnet entries never collide when stored side by side', () => {
    const cache = new ReadCache();
    cache.setNetwork(TESTNET);
    const key = createReadCacheKey('get_will', { willId: '1' });
    cache.set(key, { network: 'testnet' });

    cache.setNetwork(MAINNET);
    cache.set(key, { network: 'mainnet' });
    expect(cache.get<{ network: string }>(key)).toEqual({ network: 'mainnet' });

    cache.setNetwork(TESTNET);
    expect(cache.get(key)).toBeUndefined();
  });

  it('network switch clears the cache; re-selecting the same network does not', () => {
    const cache = new ReadCache();
    cache.setNetwork(TESTNET);
    const key = createReadCacheKey('get_wills_by_owner', { owner: 'GA' });
    cache.set(key, ['x']);

    expect(cache.setNetwork(TESTNET)).toBe(false);
    expect(cache.get(key)).toEqual(['x']);
  });
});
