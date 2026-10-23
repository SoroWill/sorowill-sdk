/**
 * Tests for #504: RPC request deduplication / queuing.
 *
 * Multiple concurrent identical read calls (same method + args) must be
 * collapsed into a single in-flight RPC simulation. Only one network call
 * must be made regardless of how many concurrent callers are waiting.
 *
 * Also verifies that:
 *   - Different methods or args are NOT deduplicated (they produce separate calls).
 *   - The `InFlightTracker.trackByKey` API used under the hood works correctly.
 *   - High-concurrency reads do not exhaust the connection pool.
 */
import { describe, expect, it } from 'vitest';
import { InFlightTracker } from '../src/inFlightTracker';

describe('InFlightTracker.trackByKey — read deduplication (#504)', () => {
  it('deduplicates concurrent calls with the same key', async () => {
    const tracker = new InFlightTracker();
    let callCount = 0;

    const slowOp = async (_signal: AbortSignal) => {
      callCount++;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return 'result';
    };

    // Fire 10 concurrent calls with the same key.
    const promises = Array.from({ length: 10 }, () =>
      tracker.trackByKey('get_will::1', slowOp),
    );

    const results = await Promise.all(promises);

    // Only one RPC simulation should have been made.
    expect(callCount).toBe(1);
    // All callers receive the same result.
    expect(results).toHaveLength(10);
    for (const r of results) {
      expect(r).toBe('result');
    }
  });

  it('does NOT deduplicate calls with different keys', async () => {
    const tracker = new InFlightTracker();
    let callCount = 0;

    const op = async (_signal: AbortSignal) => {
      callCount++;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return 'result';
    };

    await Promise.all([
      tracker.trackByKey('get_will::1', op),
      tracker.trackByKey('get_will::2', op),
      tracker.trackByKey('get_wills_by_owner::GOWNER', op),
    ]);

    // Three distinct keys → three separate calls.
    expect(callCount).toBe(3);
  });

  it('allows a new call once the previous one has settled', async () => {
    const tracker = new InFlightTracker();
    const calls: number[] = [];

    const op = async (_signal: AbortSignal) => {
      const n = calls.length + 1;
      calls.push(n);
      await new Promise((resolve) => setTimeout(resolve, 10));
      return n;
    };

    const first = await tracker.trackByKey('key', op);
    // First call has settled — the entry should be gone from inFlight.
    const second = await tracker.trackByKey('key', op);

    expect(first).toBe(1);
    expect(second).toBe(2);
    expect(calls).toEqual([1, 2]);
  });

  it('propagates errors to all concurrent waiters', async () => {
    const tracker = new InFlightTracker();
    const boom = new Error('RPC failure');

    const failingOp = async (_signal: AbortSignal) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      throw boom;
    };

    const promises = Array.from({ length: 5 }, () =>
      tracker.trackByKey('failing::op', failingOp),
    );

    const results = await Promise.allSettled(promises);

    // Every waiter should have received the same rejection.
    for (const r of results) {
      expect(r.status).toBe('rejected');
      expect((r as PromiseRejectedResult).reason).toBe(boom);
    }
  });

  it('handles very high concurrency on the same key without multiple executions', async () => {
    const tracker = new InFlightTracker();
    let callCount = 0;

    const op = async (_signal: AbortSignal) => {
      callCount++;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return 'done';
    };

    // 50 concurrent calls all using the same key — only one RPC should fire.
    const promises = Array.from({ length: 50 }, () =>
      tracker.trackByKey('get_will::42', op),
    );

    const results = await Promise.all(promises);

    expect(callCount).toBe(1);
    expect(results).toHaveLength(50);
    expect(results.every((r) => r === 'done')).toBe(true);
  });

  it('coexists with the existing track() API without interference', async () => {
    const tracker = new InFlightTracker();
    let trackCalls = 0;
    let trackKeyCalls = 0;

    const trackOp = async (_signal: AbortSignal) => { trackCalls++; return 'track'; };
    const trackKeyOp = async (_signal: AbortSignal) => { trackKeyCalls++; return 'trackByKey'; };

    await Promise.all([
      tracker.track('will-1', 'checkIn', trackOp),
      tracker.trackByKey('read::get_will::1', trackKeyOp),
      // Second concurrent call — should deduplicate.
      tracker.track('will-1', 'checkIn', trackOp),
      tracker.trackByKey('read::get_will::1', trackKeyOp),
    ]);

    expect(trackCalls).toBe(1);
    expect(trackKeyCalls).toBe(1);
  });
});

describe('InFlightTracker.trackByKey — abort signal', () => {
  it('passes an AbortSignal to the operation', async () => {
    const tracker = new InFlightTracker();
    let receivedSignal: AbortSignal | null = null;

    await tracker.trackByKey('key', async (signal) => {
      receivedSignal = signal;
      return 'ok';
    });

    expect(receivedSignal).toBeInstanceOf(AbortSignal);
  });
});
