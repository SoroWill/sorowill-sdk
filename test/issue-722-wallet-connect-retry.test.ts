import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { withConnectionRetry } from '../src/wallet';

const CONNECTION = { publicKey: 'GABC', network: 'testnet', networkPassphrase: 'pp' };

describe('Issue #722: wallet connection retry with exponential backoff', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('retries up to 3 times after the first failure (4 attempts total)', async () => {
    const connect = vi.fn(async () => {
      throw new Error('temporary network issue');
    });

    const promise = withConnectionRetry(connect, { maxRetries: 3 });
    const assertion = expect(promise).rejects.toThrow('temporary network issue');
    await vi.runAllTimersAsync();
    await assertion;

    expect(connect).toHaveBeenCalledTimes(4);
  });

  it('waits 100ms, 200ms, then 400ms between attempts', async () => {
    const connect = vi.fn(async () => {
      throw new Error('fail');
    });
    const sleeps: number[] = [];
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      sleeps.push(ms ?? 0);
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);

    await expect(withConnectionRetry(connect, { maxRetries: 3 })).rejects.toThrow('fail');

    expect(sleeps).toEqual([100, 200, 400]);
  });

  it('reports the retry attempt number to the caller before each retry', async () => {
    const connect = vi
      .fn<() => Promise<typeof CONNECTION>>()
      .mockRejectedValueOnce(new Error('a'))
      .mockRejectedValueOnce(new Error('b'))
      .mockResolvedValueOnce(CONNECTION);
    const onRetry = vi.fn();

    const promise = withConnectionRetry(connect, { maxRetries: 3, onRetry });
    await vi.runAllTimersAsync();

    await expect(promise).resolves.toEqual(CONNECTION);
    expect(onRetry.mock.calls.map((call) => call[0].attempt)).toEqual([1, 2]);
  });

  it('returns the connection immediately without retrying when the first attempt succeeds', async () => {
    const connect = vi.fn(async () => CONNECTION);

    await expect(withConnectionRetry(connect, { maxRetries: 3 })).resolves.toEqual(CONNECTION);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('resets the retry count for each new connection attempt after a success', async () => {
    const connect = vi
      .fn<() => Promise<typeof CONNECTION>>()
      .mockRejectedValueOnce(new Error('x'))
      .mockResolvedValueOnce(CONNECTION)
      .mockRejectedValueOnce(new Error('y'))
      .mockResolvedValueOnce(CONNECTION);
    const onRetry = vi.fn();

    const first = withConnectionRetry(connect, { maxRetries: 3, onRetry });
    await vi.runAllTimersAsync();
    await first;

    const second = withConnectionRetry(connect, { maxRetries: 3, onRetry });
    await vi.runAllTimersAsync();
    await second;

    expect(onRetry.mock.calls.map((call) => call[0].attempt)).toEqual([1, 1]);
  });
});
