import { describe, it, expect } from 'vitest';
import { RequestQueue, RequestDependencyError } from '../src/requestQueue';

describe('Issue #733: request queue preserves order for interdependent calls', () => {
  it('runs a dependent request only after its dependency resolves', async () => {
    const queue = new RequestQueue({ maxConcurrent: 4, requestsPerSecond: 1000 });
    const order: string[] = [];

    const create = queue.enqueue(async () => {
      await new Promise((r) => setTimeout(r, 30));
      order.push('create');
      return 'will-1';
    });

    const fund = queue.enqueueAfter([create], async () => {
      order.push('fund');
      return 'funded';
    });

    await expect(fund).resolves.toBe('funded');
    expect(order).toEqual(['create', 'fund']);
  });

  it('waits for every dependency before executing', async () => {
    const queue = new RequestQueue({ maxConcurrent: 4, requestsPerSecond: 1000 });
    let started = false;
    const slow = new Promise((r) => setTimeout(() => r('a'), 20));
    const fast = Promise.resolve('b');

    const result = queue.enqueueAfter([slow, fast], async () => {
      started = true;
      return 'done';
    });

    expect(started).toBe(false);
    await expect(result).resolves.toBe('done');
    expect(started).toBe(true);
  });

  it('rejects the dependent request with the failing dependency index and never runs it', async () => {
    const queue = new RequestQueue({ maxConcurrent: 4, requestsPerSecond: 1000 });
    const cause = new Error('create failed');
    let ran = false;

    const failing = Promise.reject(cause);
    failing.catch(() => undefined);

    const dependent = queue.enqueueAfter([Promise.resolve(1), failing], async () => {
      ran = true;
      return 'should not happen';
    });

    const error = await dependent.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RequestDependencyError);
    expect((error as RequestDependencyError).dependencyIndex).toBe(1);
    expect((error as RequestDependencyError).cause).toBe(cause);
    expect(ran).toBe(false);
  });

  it('runs immediately (through the queue) when there are no dependencies', async () => {
    const queue = new RequestQueue({ maxConcurrent: 4, requestsPerSecond: 1000 });
    await expect(queue.enqueueAfter([], async () => 42)).resolves.toBe(42);
  });
});
