import { describe, expect, it } from 'vitest';

import { RequestQueue } from '../src/requestQueue';
import { RequestTimeoutError } from '../src/errors';

describe('RequestQueue', () => {
  describe('enqueue', () => {
    it('executes requests in FIFO order', async () => {
      const queue = new RequestQueue({ maxConcurrent: 1 });
      const executed: number[] = [];

      const p1 = queue.enqueue(() => {
        executed.push(1);
        return Promise.resolve('result1');
      });

      const p2 = queue.enqueue(() => {
        executed.push(2);
        return Promise.resolve('result2');
      });

      await Promise.all([p1, p2]);
      expect(executed).toEqual([1, 2]);
    });

    it('respects maxConcurrent limit', async () => {
      const queue = new RequestQueue({ maxConcurrent: 2 });
      let maxActive = 0;
      let currentActive = 0;

      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          queue.enqueue(async () => {
            currentActive += 1;
            maxActive = Math.max(maxActive, currentActive);
            await new Promise((resolve) => setTimeout(resolve, 10));
            currentActive -= 1;
            return i;
          }),
        ),
      );

      expect(maxActive).toBeLessThanOrEqual(2);
      expect(results).toEqual(Array.from({ length: 10 }, (_, i) => i));
    });

    it('respects requestsPerSecond rate limit', async () => {
      const queue = new RequestQueue({ maxConcurrent: 100, requestsPerSecond: 3 });
      const starts: number[] = [];

      await Promise.all(
        Array.from({ length: 6 }, () =>
          queue.enqueue(() => {
            starts.push(Date.now());
            return Promise.resolve();
          }),
        ),
      );

      expect(starts.length).toBe(6);
      const firstStart = starts[0]!;
      const firstSecondStarts = starts.filter((t) => t <= firstStart + 1000);

      // First second should have at most requestsPerSecond starts
      expect(firstSecondStarts.length).toBeLessThanOrEqual(3);
      // Not all 6 should start in the first second with requestsPerSecond=3
      expect(firstSecondStarts.length).toBeLessThan(6);
    });

    it('rejects with RangeError for invalid timeoutMs', async () => {
      const queue = new RequestQueue();

      await expect(queue.enqueue(() => Promise.resolve('test'), -1)).rejects.toThrow(RangeError);
      await expect(queue.enqueue(() => Promise.resolve('test'), 0)).rejects.toThrow(RangeError);
      await expect(queue.enqueue(() => Promise.resolve('test'), Infinity)).rejects.toThrow(RangeError);
    });

    it('enforces per-request timeout', async () => {
      const queue = new RequestQueue();

      const promise = queue.enqueue(
        () =>
          new Promise(() => {
            // Never resolves
          }),
        100,
      );

      await expect(promise).rejects.toThrow(RequestTimeoutError);
    });

    it('timeout error includes the timeout value', async () => {
      const queue = new RequestQueue();
      const timeoutMs = 50;

      try {
        await queue.enqueue(
          () =>
            new Promise(() => {
              // Never resolves
            }),
          timeoutMs,
        );
        expect.fail('Should have thrown RequestTimeoutError');
      } catch (error) {
        expect(error).toBeInstanceOf(RequestTimeoutError);
        if (error instanceof RequestTimeoutError) {
          expect(error.message).toContain(String(timeoutMs));
        }
      }
    });

    it('clears timeout when request completes before timeout', async () => {
      const queue = new RequestQueue();

      const result = await queue.enqueue(() => Promise.resolve('success'), 1000);
      expect(result).toBe('success');
    });

    it('continues processing queue after timeout', async () => {
      const queue = new RequestQueue({ maxConcurrent: 2 });
      const results: string[] = [];

      const p1 = queue.enqueue(
        () =>
          new Promise(() => {
            // Never resolves
          }),
        50,
      ).catch(() => {
        results.push('timeout');
      });

      const p2 = queue.enqueue(() => {
        results.push('success');
        return Promise.resolve();
      });

      await Promise.all([p1, p2]);

      expect(results).toContain('success');
      expect(results).toContain('timeout');
    });

    it('handles multiple timeouts in sequence', async () => {
      const queue = new RequestQueue({ maxConcurrent: 1 });
      let timeoutCount = 0;

      const requests = Array.from({ length: 3 }, () =>
        queue
          .enqueue(
            () =>
              new Promise(() => {
                // Never resolves
              }),
            50,
          )
          .catch((error) => {
            if (error instanceof RequestTimeoutError) {
              timeoutCount += 1;
            }
            throw error;
          }),
      );

      await Promise.allSettled(requests);
      expect(timeoutCount).toBe(3);
    });

    it('distinguishes timeout errors from other errors', async () => {
      const queue = new RequestQueue();

      const timeoutPromise = queue
        .enqueue(
          () =>
            new Promise(() => {
              // Never resolves
            }),
          50,
        )
        .catch((error) => {
          expect(error).toBeInstanceOf(RequestTimeoutError);
          throw error;
        });

      const errorPromise = queue.enqueue(() => Promise.reject(new Error('Regular error'))).catch((error) => {
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(RequestTimeoutError);
        throw error;
      });

      await expect(Promise.all([timeoutPromise, errorPromise])).rejects.toThrow();
    });

    it('executes all queued requests eventually', async () => {
      const queue = new RequestQueue({ maxConcurrent: 2, requestsPerSecond: 5 });
      const executed: number[] = [];

      const requests = Array.from({ length: 10 }, (_, i) =>
        queue.enqueue(() => {
          executed.push(i);
          return Promise.resolve(i);
        }),
      );

      await Promise.all(requests);

      expect(executed.length).toBe(10);
      expect(new Set(executed).size).toBe(10);
    });

    it('works without timeout parameter', async () => {
      const queue = new RequestQueue();

      const result = await queue.enqueue(() => Promise.resolve('no timeout'));

      expect(result).toBe('no timeout');
    });

    it('handles request errors', async () => {
      const queue = new RequestQueue();
      const error = new Error('Request failed');

      const promise = queue.enqueue(() => Promise.reject(error));

      await expect(promise).rejects.toBe(error);
    });

    it('continues processing after request error', async () => {
      const queue = new RequestQueue({ maxConcurrent: 2 });
      const results: string[] = [];

      const p1 = queue.enqueue(() => Promise.reject(new Error('fail'))).catch(() => {
        results.push('error');
      });

      const p2 = queue.enqueue(() => {
        results.push('success');
        return Promise.resolve();
      });

      await Promise.all([p1, p2]);

      expect(results).toContain('error');
      expect(results).toContain('success');
    });
  });

  describe('constructor', () => {
    it('rejects invalid maxConcurrent', () => {
      expect(() => new RequestQueue({ maxConcurrent: 0 })).toThrow(RangeError);
      expect(() => new RequestQueue({ maxConcurrent: -1 })).toThrow(RangeError);
      expect(() => new RequestQueue({ maxConcurrent: 1.5 })).toThrow(RangeError);
    });

    it('rejects invalid requestsPerSecond', () => {
      expect(() => new RequestQueue({ requestsPerSecond: 0 })).toThrow(RangeError);
      expect(() => new RequestQueue({ requestsPerSecond: -1 })).toThrow(RangeError);
      expect(() => new RequestQueue({ requestsPerSecond: 2.5 })).toThrow(RangeError);
    });

    it('accepts valid options', () => {
      const queue1 = new RequestQueue();
      expect(queue1).toBeDefined();

      const queue2 = new RequestQueue({ maxConcurrent: 1 });
      expect(queue2).toBeDefined();

      const queue3 = new RequestQueue({ requestsPerSecond: 1 });
      expect(queue3).toBeDefined();

      const queue4 = new RequestQueue({ maxConcurrent: 10, requestsPerSecond: 20 });
      expect(queue4).toBeDefined();
    });
  });
});
