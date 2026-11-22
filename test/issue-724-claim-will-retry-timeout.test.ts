import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SoroWillClient } from '../src/SoroWillClient';

const CONTRACT_ID = 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE';

function networkError(): Error {
  return new Error('network request failed');
}

describe('Issue #724: claimWill max retries and timeout handling', () => {
  let client: SoroWillClient;
  let invoke: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    client = new SoroWillClient({ network: 'testnet', contractId: CONTRACT_ID });
    invoke = vi.fn();
    vi.spyOn(client as unknown as { invoke: unknown }, 'invoke' as never).mockImplementation(
      invoke as never,
    );
  });

  afterEach(() => {
    client.destroy();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('retries a failed claim up to 3 times by default (4 attempts total)', async () => {
    invoke.mockRejectedValue(networkError());

    const promise = client.claimWill(1n);
    const assertion = expect(promise).rejects.toThrow('network request failed');
    await vi.runAllTimersAsync();
    await assertion;

    expect(invoke).toHaveBeenCalledTimes(4);
  });

  it('honors a configurable maxRetries override', async () => {
    invoke.mockRejectedValue(networkError());

    const promise = client.claimWill(1n, { maxRetries: 1 });
    const assertion = expect(promise).rejects.toThrow();
    await vi.runAllTimersAsync();
    await assertion;

    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('applies exponential backoff between retries', async () => {
    invoke.mockRejectedValue(networkError());
    const sleeps: number[] = [];
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      if (ms !== undefined && ms >= 100) sleeps.push(ms);
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);

    await expect(client.claimWill(1n)).rejects.toThrow();

    expect(sleeps.slice(0, 3)).toEqual([1_000, 2_000, 4_000]);
  });

  it('times out an individual attempt after 30 seconds and treats it as retryable', async () => {
    invoke.mockImplementation(() => new Promise(() => {}));

    const promise = client.claimWill(1n, { maxRetries: 0 });
    const assertion = expect(promise).rejects.toThrow(/timed out after 30000ms/i);
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;

    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('surfaces a distinct error message per failure type', async () => {
    invoke.mockRejectedValueOnce(new Error('insufficient balance'));

    await expect(client.claimWill(1n, { maxRetries: 0 })).rejects.toThrow(/insufficient balance/i);
  });
});
