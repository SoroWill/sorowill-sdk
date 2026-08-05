import { describe, it, expect, vi } from 'vitest';
import { InFlightTracker } from '../src/inFlightTracker';

describe('InFlightTracker - Issue #52: Idempotency safeguards', () => {
  it('should track in-flight operations by will id and method', async () => {
    const tracker = new InFlightTracker();
    const willId = '123';
    const method = 'check_in';

    const operation = () => Promise.resolve({ result: 'success' });
    const promise1 = tracker.track(willId, method, operation);

    expect(tracker.isInFlight(willId, method)).toBe(true);
    expect(tracker.getInFlightPromise(willId, method)).toBe(promise1);

    await promise1;
    expect(tracker.isInFlight(willId, method)).toBe(false);
  });

  it('should return the original in-flight promise when called again before resolving', async () => {
    const tracker = new InFlightTracker();
    const willId = '123';
    const method = 'check_in';
    const spy = vi.fn();

    const operation = async () => {
      spy();
      return { result: 'success' };
    };

    const promise1 = tracker.track(willId, method, operation);
    const promise2 = tracker.track(willId, method, operation);

    expect(promise1).toBe(promise2);
    expect(spy).toHaveBeenCalledTimes(1);

    await promise1;
  });

  it('should allow different methods for the same will id', async () => {
    const tracker = new InFlightTracker();
    const willId = '123';

    const op1 = () => Promise.resolve('check_in');
    const op2 = () => Promise.resolve('trigger_will');

    const promise1 = tracker.track(willId, 'check_in', op1);
    const promise2 = tracker.track(willId, 'trigger_will', op2);

    expect(promise1).not.toBe(promise2);
    expect(tracker.isInFlight(willId, 'check_in')).toBe(true);
    expect(tracker.isInFlight(willId, 'trigger_will')).toBe(true);

    await Promise.all([promise1, promise2]);

    expect(tracker.isInFlight(willId, 'check_in')).toBe(false);
    expect(tracker.isInFlight(willId, 'trigger_will')).toBe(false);
  });

  it('should allow same method for different will ids', async () => {
    const tracker = new InFlightTracker();
    const method = 'check_in';

    const op1 = () => Promise.resolve('will1');
    const op2 = () => Promise.resolve('will2');

    const promise1 = tracker.track('123', method, op1);
    const promise2 = tracker.track('456', method, op2);

    expect(promise1).not.toBe(promise2);
    expect(tracker.isInFlight('123', method)).toBe(true);
    expect(tracker.isInFlight('456', method)).toBe(true);

    await Promise.all([promise1, promise2]);

    expect(tracker.isInFlight('123', method)).toBe(false);
    expect(tracker.isInFlight('456', method)).toBe(false);
  });

  it('should support bigint will ids', async () => {
    const tracker = new InFlightTracker();
    const willId = BigInt('123');
    const method = 'check_in';

    const operation = () => Promise.resolve('success');
    const promise = tracker.track(willId, method, operation);

    expect(tracker.isInFlight(willId, method)).toBe(true);
    expect(tracker.getInFlightPromise(willId, method)).toBe(promise);

    await promise;
    expect(tracker.isInFlight(willId, method)).toBe(false);
  });

  it('should handle operation failures', async () => {
    const tracker = new InFlightTracker();
    const willId = '123';
    const method = 'check_in';

    const error = new Error('Simulation failed');
    const operation = () => Promise.reject(error);

    const promise = tracker.track(willId, method, operation);

    expect(tracker.isInFlight(willId, method)).toBe(true);

    await expect(promise).rejects.toThrow('Simulation failed');
    expect(tracker.isInFlight(willId, method)).toBe(false);
  });

  it('should clear all in-flight operations', async () => {
    const tracker = new InFlightTracker();

    tracker.track('123', 'check_in', () => new Promise(() => {}));
    tracker.track('456', 'trigger_will', () => new Promise(() => {}));

    expect(tracker.isInFlight('123', 'check_in')).toBe(true);
    expect(tracker.isInFlight('456', 'trigger_will')).toBe(true);

    tracker.clear();

    expect(tracker.isInFlight('123', 'check_in')).toBe(false);
    expect(tracker.isInFlight('456', 'trigger_will')).toBe(false);
  });

  it('should abort specific in-flight operation', async () => {
    const tracker = new InFlightTracker();

    tracker.track('123', 'check_in', () => new Promise(() => {}));

    expect(tracker.isInFlight('123', 'check_in')).toBe(true);

    tracker.abort('123', 'check_in');

    expect(tracker.isInFlight('123', 'check_in')).toBe(false);
  });
});
