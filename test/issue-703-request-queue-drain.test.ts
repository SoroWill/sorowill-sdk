import { describe, expect, it, vi } from 'vitest';
import { RequestQueue } from '../src/requestQueue';
import { RequestTimeoutError } from '../src/errors';

describe('RequestQueue drain, batching, monitoring, and stuck timeout (#703)', () => {
  it('drains 60+ queued requests completely without hanging', async () => {
    const queue = new RequestQueue({
      maxConcurrent: 4,
      requestsPerSecond: 100,
      batchSize: 10,
      backupThreshold: 50,
    });

    const total = 65;
    const results = await Promise.all(
      Array.from({ length: total }, (_, i) =>
        queue.enqueue(async () => i * 2),
      ),
    );

    expect(results).toHaveLength(total);
    expect(results[0]).toBe(0);
    expect(results[64]).toBe(128);
    expect(queue.getDepth()).toBe(0);
    expect(queue.getActiveCount()).toBe(0);
  });

  it('invokes onQueueDepthWarning and reports isBackedUp when depth reaches 50+', async () => {
    const onQueueDepthWarning = vi.fn();
    const queue = new RequestQueue({
      maxConcurrent: 1,
      requestsPerSecond: 100,
      backupThreshold: 50,
      onQueueDepthWarning,
    });

    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const p0 = queue.enqueue(() => firstGate);
    const rest = Array.from({ length: 55 }, (_, i) =>
      queue.enqueue(async () => i),
    );

    const metrics = queue.getMetrics();
    expect(metrics.depth).toBeGreaterThanOrEqual(50);
    expect(metrics.isBackedUp).toBe(true);
    expect(onQueueDepthWarning).toHaveBeenCalled();

    releaseFirst();
    await Promise.all([p0, ...rest]);
    expect(queue.getMetrics().isBackedUp).toBe(false);
    expect(queue.getDepth()).toBe(0);
  });

  it('times out stuck requests via defaultTimeoutMs so subsequent requests still drain', async () => {
    const queue = new RequestQueue({
      maxConcurrent: 1,
      requestsPerSecond: 10,
      defaultTimeoutMs: 50,
    });

    const stuckPromise = queue.enqueue(
      () => new Promise(() => {
        // Never resolves
      }),
    );
    const nextPromise = queue.enqueue(async () => 'recovered');

    await expect(stuckPromise).rejects.toThrow(RequestTimeoutError);
    await expect(nextPromise).resolves.toBe('recovered');
  });
});
