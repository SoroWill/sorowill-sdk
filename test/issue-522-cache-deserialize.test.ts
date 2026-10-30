import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { deserializeCacheValue, CacheDeserializationError } from '../src/cache';

describe('#522 deserializeCacheValue type validation', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('deserializes a known __type: "bigint" value correctly', () => {
    const json = JSON.stringify({ __type: 'bigint', value: '12345678901234567890' });
    const result = deserializeCacheValue<bigint>(json);
    expect(result).toBe(12345678901234567890n);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('deserializes a known __type: "date" value correctly', () => {
    const iso = '2024-01-15T10:30:00.000Z';
    const json = JSON.stringify({ __type: 'date', value: iso });
    const result = deserializeCacheValue<Date>(json);
    expect(result).toBeInstanceOf(Date);
    expect(result!.toISOString()).toBe(iso);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('throws for an unknown __type', () => {
    const json = JSON.stringify({ __type: 'unknown_type', value: 'some-value' });
    expect(() => deserializeCacheValue(json)).toThrow(CacheDeserializationError);
    expect(() => deserializeCacheValue(json)).toThrow(/unknown_type/);
  });

  it('logs a warning for a malformed __type object missing value', () => {
    const json = JSON.stringify({ __type: 'bigint' });
    const result = deserializeCacheValue(json);
    expect(result).toEqual({ __type: 'bigint' });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('passes through plain values without __type unchanged', () => {
    const json = JSON.stringify({ name: 'test', count: 42 });
    const result = deserializeCacheValue(json);
    expect(result).toEqual({ name: 'test', count: 42 });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('throws for nested objects with unknown __type', () => {
    const json = JSON.stringify({
      outer: { __type: 'bogus', value: 'x' },
      inner: { __type: 'bigint', value: '42' },
    });
    expect(() => deserializeCacheValue(json)).toThrow(CacheDeserializationError);
    expect(() => deserializeCacheValue(json)).toThrow(/bogus/);
  });
});