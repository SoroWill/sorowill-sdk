import { describe, expect, it } from 'vitest';
import {
  deserializeCacheValue,
  MemoryCachePersistenceAdapter,
  ReadCache,
} from '../src/cache';

describe('Issue #581 - deserializeCacheValue __type validation', () => {
  it('deserializes valid bigint and date __type values', () => {
    const raw = JSON.stringify({
      balance: { __type: 'bigint', value: '9876543210123456789' },
      lastCheckin: { __type: 'date', value: '2026-01-15T12:00:00.000Z' },
      owner: 'GOWNER',
    });

    const parsed = deserializeCacheValue<{
      balance: bigint;
      lastCheckin: Date;
      owner: string;
    }>(raw);

    expect(parsed.balance).toBe(9876543210123456789n);
    expect(parsed.lastCheckin).toBeInstanceOf(Date);
    expect(parsed.lastCheckin.toISOString()).toBe('2026-01-15T12:00:00.000Z');
    expect(parsed.owner).toBe('GOWNER');
  });

  it('throws an error when __type is an unknown string value', () => {
    const unknownTypeJson = JSON.stringify({
      __type: 'unknown',
      value: '123',
    });
    expect(() => deserializeCacheValue(unknownTypeJson)).toThrow(
      /Unknown cache value __type: "unknown"\. Expected one of: bigint, date/,
    );

    const numberTypeJson = JSON.stringify({
      nested: { __type: 'number', value: '42' },
    });
    expect(() => deserializeCacheValue(numberTypeJson)).toThrow(
      /Unknown cache value __type: "number"\. Expected one of: bigint, date/,
    );

    const emptyTypeJson = JSON.stringify({
      __type: '',
      value: '123',
    });
    expect(() => deserializeCacheValue(emptyTypeJson)).toThrow(
      /Unknown cache value __type: ""\. Expected one of: bigint, date/,
    );
  });

  it('throws an error when __type is not a string', () => {
    for (const invalidType of [123, null, true, {}, []]) {
      const payload = JSON.stringify({
        __type: invalidType,
        value: '123',
      });
      expect(() => deserializeCacheValue(payload)).toThrow(
        /Unknown cache value __type:.*Expected one of: bigint, date/,
      );
    }
  });

  it('rejects ReadCache hydration when a persisted entry contains an invalid __type', async () => {
    const adapter = new MemoryCachePersistenceAdapter();
    await adapter.write({
      key: 'will:corrupted',
      value: JSON.stringify({
        id: '1',
        malformed: { __type: 'map', value: '[]' },
      }),
      expiresAt: Date.now() + 60_000,
      willIds: ['1'],
    });

    const cache = new ReadCache({ persistence: adapter });
    await expect(cache.ready()).rejects.toThrow(
      /Unknown cache value __type: "map"\. Expected one of: bigint, date/,
    );
  });
});
