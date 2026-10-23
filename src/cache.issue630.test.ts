/**
 * Tests for issue #630: Cache key generation with special characters in parameters.
 *
 * Verifies that parameters containing colons, commas, and other separator
 * characters are properly encoded so that different queries never produce the
 * same cache key.
 */
import { describe, it, expect } from 'vitest';
import { createReadCacheKey } from './cache';

describe('#630 createReadCacheKey — special character handling', () => {
  it('encodes colons in string parameter values', () => {
    const key = createReadCacheKey('getWill', { id: 'a:b' });
    expect(key).toContain('a%3Ab');
    expect(key).not.toContain('"a:b"');
  });

  it('encodes commas in string parameter values', () => {
    const key = createReadCacheKey('getWill', { id: 'a,b' });
    expect(key).toContain('a%2Cb');
    expect(key).not.toContain('"a,b"');
  });

  it('does not collide when colon appears in value vs method separator', () => {
    // method="getWill", args={id: ":extra"} must differ from
    // method="getWill:", args={id: "extra"}
    const key1 = createReadCacheKey('getWill', { id: ':extra' });
    const key2 = createReadCacheKey('getWill:', { id: 'extra' });
    expect(key1).not.toBe(key2);
  });

  it('does not collide when value contains the separator sequence', () => {
    // Params {a: "x:y"} vs {a: "x", b: "y"} must produce different keys.
    const key1 = createReadCacheKey('read', { a: 'x:y' });
    const key2 = createReadCacheKey('read', { a: 'x', b: 'y' });
    expect(key1).not.toBe(key2);
  });

  it('different values with colons produce different keys', () => {
    const key1 = createReadCacheKey('read', { token: 'native:xlm' });
    const key2 = createReadCacheKey('read', { token: 'usdc:issuer' });
    expect(key1).not.toBe(key2);
  });

  it('two calls with the same args (including special chars) produce the same key', () => {
    const args = { id: 'a:b', owner: 'G:address,with,commas' };
    const key1 = createReadCacheKey('getWill', args);
    const key2 = createReadCacheKey('getWill', { ...args });
    expect(key1).toBe(key2);
  });

  it('key order is stable regardless of object key insertion order', () => {
    const key1 = createReadCacheKey('method', { z: 'val:1', a: 'val,2' });
    const key2 = createReadCacheKey('method', { a: 'val,2', z: 'val:1' });
    expect(key1).toBe(key2);
  });

  it('encodes method names with special characters', () => {
    const key = createReadCacheKey('method:with:colons', { a: 1 });
    // encodeURIComponent turns colons to %3A
    expect(key.startsWith('method%3Awith%3Acolons:')).toBe(true);
  });

  it('encodes percent signs in parameter values to prevent double-decode collisions', () => {
    // "a%3Ab" raw vs "a:b" encoded to "a%3Ab" must not collide.
    const keyLiteral = createReadCacheKey('read', { id: 'a%3Ab' });
    const keyEncoded = createReadCacheKey('read', { id: 'a:b' });
    expect(keyLiteral).not.toBe(keyEncoded);
  });

  it('handles nested objects with special characters', () => {
    const key1 = createReadCacheKey('read', { filter: { token: 'xlm:native' } });
    const key2 = createReadCacheKey('read', { filter: { token: 'xlm:native' } });
    expect(key1).toBe(key2);
  });

  it('handles array values with special characters', () => {
    const key1 = createReadCacheKey('read', { ids: ['a:1', 'b,2'] });
    const key2 = createReadCacheKey('read', { ids: ['a:1', 'b,2'] });
    expect(key1).toBe(key2);

    const key3 = createReadCacheKey('read', { ids: ['a:1', 'b:2'] });
    expect(key1).not.toBe(key3);
  });
});
