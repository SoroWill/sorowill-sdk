import { describe, expect, it, beforeEach } from 'vitest';
import { InFlightTracker } from '../src/inFlightTracker';

describe('InFlightTracker', () => {
  let tracker: InFlightTracker;

  beforeEach(() => {
    tracker = new InFlightTracker();
  });

  describe('track', () => {
    it('returns the result of the operation', async () => {
      const result = await tracker.track('will-1', 'checkIn', async () => 'success');
      expect(result).toBe('success');
    });

    it('deduplicates concurrent calls for the same willId and method', async () => {
      let callCount = 0;

      const operation = async (_signal: AbortSignal) => {
        callCount++;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return 'result';
      };

      const promise1 = tracker.track('will-1', 'checkIn', operation);
      const promise2 = tracker.track('will-1', 'checkIn', operation);

      const [result1, result2] = await Promise.all([promise1, promise2]);

      expect(callCount).toBe(1);
      expect(result1).toBe('result');
      expect(result2).toBe('result');
    });

    it('does not deduplicate calls for different willIds', async () => {
      let callCount = 0;

      const operation = async (_signal: AbortSignal) => {
        callCount++;
        return 'result';
      };

      await Promise.all([
        tracker.track('will-1', 'checkIn', operation),
        tracker.track('will-2', 'checkIn', operation),
      ]);

      expect(callCount).toBe(2);
    });

    it('does not deduplicate calls for different methods', async () => {
      let callCount = 0;

      const operation = async (_signal: AbortSignal) => {
        callCount++;
        return 'result';
      };

      await Promise.all([
        tracker.track('will-1', 'checkIn', operation),
        tracker.track('will-1', 'cancelWill', operation),
      ]);

      expect(callCount).toBe(2);
    });

    it('passes the abort signal to the operation', async () => {
      let receivedSignal: AbortSignal | null = null;

      const operation = async (signal: AbortSignal) => {
        receivedSignal = signal;
        return 'result';
      };

      await tracker.track('will-1', 'checkIn', operation);

      expect(receivedSignal).toBeDefined();
      expect(receivedSignal).toBeInstanceOf(AbortSignal);
    });

    it('operation can observe abort signal', async () => {
      let abortObserved = false;

      const operation = async (signal: AbortSignal) => {
        return new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => {
            abortObserved = true;
            resolve();
          });
        });
      };

      const promise = tracker.track('will-1', 'checkIn', operation);
      tracker.abort('will-1', 'checkIn');

      await promise;
      expect(abortObserved).toBe(true);
    });

    it('abort actually cancels in-flight fetch-like operations', async () => {
      let fetchExecuted = false;

      const operation = async (signal: AbortSignal) => {
        // Simulate a fetch-like operation that respects the abort signal
        return new Promise<string>((resolve, reject) => {
          if (signal.aborted) {
            reject(new Error('aborted'));
            return;
          }

          const timer = setTimeout(() => {
            fetchExecuted = true;
            resolve('success');
          }, 100);

          signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('aborted'));
          });
        });
      };

      const promise = tracker.track('will-1', 'checkIn', operation);
      await new Promise((resolve) => setTimeout(resolve, 10));
      tracker.abort('will-1', 'checkIn');

      await expect(promise).rejects.toThrow('aborted');
      expect(fetchExecuted).toBe(false);
    });
  });

  describe('isInFlight', () => {
    it('returns true while operation is in flight', async () => {
      expect(tracker.isInFlight('will-1', 'checkIn')).toBe(false);

      const operation = async (_signal: AbortSignal) => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return 'result';
      };

      const promise = tracker.track('will-1', 'checkIn', operation);
      expect(tracker.isInFlight('will-1', 'checkIn')).toBe(true);

      await promise;
      expect(tracker.isInFlight('will-1', 'checkIn')).toBe(false);
    });
  });

  describe('abort', () => {
    it('removes operation from in-flight map', async () => {
      let abortObserved = false;

      const operation = async (signal: AbortSignal) => {
        return new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => {
            abortObserved = true;
            resolve();
          });
        });
      };

      const promise = tracker.track('will-1', 'checkIn', operation);
      expect(tracker.isInFlight('will-1', 'checkIn')).toBe(true);

      tracker.abort('will-1', 'checkIn');
      expect(tracker.isInFlight('will-1', 'checkIn')).toBe(false);

      await promise;
      expect(abortObserved).toBe(true);
    });

    it('does nothing when operation is not in flight', () => {
      expect(() => tracker.abort('will-1', 'checkIn')).not.toThrow();
    });
  });

  describe('clear', () => {
    it('aborts all in-flight operations', async () => {
      const abortedOps: string[] = [];

      const createOp = (name: string) => async (signal: AbortSignal) => {
        return new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => {
            abortedOps.push(name);
            resolve();
          });
        });
      };

      const p1 = tracker.track('will-1', 'checkIn', createOp('op1'));
      const p2 = tracker.track('will-2', 'checkIn', createOp('op2'));
      const p3 = tracker.track('will-1', 'cancelWill', createOp('op3'));

      tracker.clear();

      await Promise.all([p1, p2, p3]);
      expect(abortedOps).toHaveLength(3);
    });

    it('clears the in-flight map', async () => {
      const operation = async (_signal: AbortSignal) => {
        return new Promise<void>((resolve) => {
          setTimeout(resolve, 50);
        });
      };

      tracker.track('will-1', 'checkIn', operation);
      tracker.track('will-2', 'checkIn', operation);

      expect(tracker.isInFlight('will-1', 'checkIn')).toBe(true);
      expect(tracker.isInFlight('will-2', 'checkIn')).toBe(true);

      tracker.clear();

      expect(tracker.isInFlight('will-1', 'checkIn')).toBe(false);
      expect(tracker.isInFlight('will-2', 'checkIn')).toBe(false);
    });
  });

  describe('getInFlightPromise', () => {
    it('returns the promise for a tracked operation', async () => {
      const operation = async (_signal: AbortSignal) => 'result';

      const promise1 = tracker.track('will-1', 'checkIn', operation);
      const promise2 = tracker.getInFlightPromise('will-1', 'checkIn');

      expect(promise2).toBe(promise1);
      expect(await promise2).toBe('result');
    });

    it('returns undefined when operation is not in flight', () => {
      const promise = tracker.getInFlightPromise('will-1', 'checkIn');
      expect(promise).toBeUndefined();
    });

    it('returns undefined after operation completes', async () => {
      const operation = async (_signal: AbortSignal) => 'result';

      const promise1 = tracker.track('will-1', 'checkIn', operation);
      await promise1;

      const promise2 = tracker.getInFlightPromise('will-1', 'checkIn');
      expect(promise2).toBeUndefined();
    });
  });

  describe('getKey', () => {
    it('generates consistent keys for string willIds', () => {
      const key1 = tracker.getKey('will-1', 'checkIn');
      const key2 = tracker.getKey('will-1', 'checkIn');

      expect(key1).toBe(key2);
      expect(key1).toBe('will-1:checkIn');
    });

    it('generates consistent keys for bigint willIds', () => {
      const key1 = tracker.getKey(123n, 'checkIn');
      const key2 = tracker.getKey(123n, 'checkIn');

      expect(key1).toBe(key2);
      expect(key1).toBe('123:checkIn');
    });
  });
});
