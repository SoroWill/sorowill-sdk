import { describe, expect, it } from 'vitest';
import { isRetryableRpcConnectionError } from '../src/rpc';

describe('isRetryableRpcConnectionError', () => {
  it('classifies low-level connection failures as retryable', () => {
    expect(isRetryableRpcConnectionError(new Error('ECONNREFUSED'))).toBe(true);
    expect(isRetryableRpcConnectionError(new Error('fetch failed'))).toBe(true);
  });

  it('classifies rate-limit responses as retryable', () => {
    expect(isRetryableRpcConnectionError(new Error('Request failed with status code 429'))).toBe(true);
    expect(isRetryableRpcConnectionError(new Error('Too Many Requests'))).toBe(true);
    expect(isRetryableRpcConnectionError(new Error('rate limit exceeded'))).toBe(true);
  });

  it('classifies server-overload responses as retryable', () => {
    expect(isRetryableRpcConnectionError(new Error('502 Bad Gateway'))).toBe(true);
    expect(isRetryableRpcConnectionError(new Error('503 Service Unavailable'))).toBe(true);
    expect(isRetryableRpcConnectionError(new Error('504 Gateway Timeout'))).toBe(true);
  });

  it('does not classify unrelated errors as retryable', () => {
    expect(isRetryableRpcConnectionError(new Error('invalid contract id'))).toBe(false);
    expect(isRetryableRpcConnectionError('not an Error instance')).toBe(false);
  });
});
