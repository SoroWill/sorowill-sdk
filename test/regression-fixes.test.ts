import { describe, expect, it, vi } from 'vitest';

import { RequestQueue } from '../src/requestQueue';
import { isRetryableRpcConnectionError, RpcEndpointPool } from '../src/rpc';
import { WillStatus } from '../src/types';
import { getNextActionableState } from '../src/utils';
import type { Will } from '../src/types';

// === Helpers

function makeWill(overrides: Partial<Will> = {}): Will {
  return {
    id: '1',
    owner: 'GOWNER',
    token: 'CABC',
    balance: '1000000000',
    beneficiaries: [{ address: 'GBEN', percentage: 100 }],
    checkinPeriodDays: 90,
    gracePeriodDays: 7,
    lastCheckin: new Date(),
    triggerTime: null,
    status: WillStatus.Active,
    guardians: [],
    guardianVotes: 0,
    ...overrides,
  };
}

// === Fix 1: RequestQueue.rejectAll

describe('RequestQueue.rejectAll', () => {
  it('rejects a queued-but-not-yet-started request', async () => {
    // maxConcurrent=0 is not allowed; instead saturate the queue so the
    // second request never starts.
    const queue = new RequestQueue({ maxConcurrent: 1, requestsPerSecond: 100 });

    // First request blocks indefinitely, occupying the single concurrency slot.
    let unblockFirst!: () => void;
    const firstStarted = new Promise<void>((res) => {
      queue.enqueue(
        () =>
          new Promise<void>((resolve) => {
            unblockFirst = resolve;
            res();
          }),
      ).catch(() => {
        // first request may also be rejected; we don't care about it here
      });
    });

    // Wait until the first request is actually running.
    await firstStarted;

    // Enqueue a second request that will never start because slot is taken.
    const secondResult = queue.enqueue(() => Promise.resolve('should not run'));

    // Destroy should reject the pending (queued) second request.
    const reason = new Error('SoroWillClient destroyed');
    queue.rejectAll(reason);

    await expect(secondResult).rejects.toThrow('SoroWillClient destroyed');

    // Clean up the first request.
    unblockFirst();
  });
});

// === Fix 2: isRetryableRpcConnectionError handles non-Error values

describe('isRetryableRpcConnectionError', () => {
  it('returns true for Error instances with a connection message', () => {
    expect(isRetryableRpcConnectionError(new Error('fetch failed'))).toBe(true);
    expect(isRetryableRpcConnectionError(new Error('ECONNREFUSED 127.0.0.1:8000'))).toBe(true);
    expect(isRetryableRpcConnectionError(new Error('Network Error'))).toBe(true);
  });

  it('returns false for Error instances with unrelated messages', () => {
    expect(isRetryableRpcConnectionError(new Error('invalid argument'))).toBe(false);
    expect(isRetryableRpcConnectionError(new Error('unauthorized'))).toBe(false);
  });

  it('returns true for plain strings with connection fragments', () => {
    expect(isRetryableRpcConnectionError('fetch failed')).toBe(true);
    expect(isRetryableRpcConnectionError('network error occurred')).toBe(true);
    expect(isRetryableRpcConnectionError('ETIMEDOUT')).toBe(true);
  });

  it('returns false for plain strings without connection fragments', () => {
    expect(isRetryableRpcConnectionError('bad request')).toBe(false);
    expect(isRetryableRpcConnectionError('')).toBe(false);
  });

  it('returns true for DOMException-like objects with matching message', () => {
    expect(
      isRetryableRpcConnectionError({ name: 'NetworkError', message: 'failed to fetch' }),
    ).toBe(true);
  });

  it('returns true for DOMException-like objects with matching name', () => {
    // Some runtimes surface network failures with a name but empty message.
    expect(
      isRetryableRpcConnectionError({ name: 'network error', message: '' }),
    ).toBe(true);
  });

  it('returns false for DOMException-like objects without matching text', () => {
    expect(
      isRetryableRpcConnectionError({ name: 'AbortError', message: 'user aborted' }),
    ).toBe(false);
  });

  it('returns false for null, undefined, and numbers', () => {
    expect(isRetryableRpcConnectionError(null)).toBe(false);
    expect(isRetryableRpcConnectionError(undefined)).toBe(false);
    expect(isRetryableRpcConnectionError(42)).toBe(false);
  });
});

describe('RpcEndpointPool.withFailover retries on non-Error connectivity failure', () => {
  it('falls over to the second endpoint when the first rejects with a plain-string network error', async () => {
    const secondServer = {
      getContractWasmByContractId: vi.fn(),
      simulateTransaction: vi.fn(),
      getAccount: vi.fn(),
      prepareTransaction: vi.fn(),
      sendTransaction: vi.fn(),
      pollTransaction: vi.fn(),
    };

    const pool = new RpcEndpointPool(
      ['https://rpc1.example.com', 'https://rpc2.example.com'],
      /* no serverOverride — we'll use the operation callback directly */
    );

    let callCount = 0;
    const result = await pool.withFailover((_server, rpcUrl) => {
      callCount += 1;
      if (rpcUrl === 'https://rpc1.example.com') {
        // Reject with a plain string, not an Error instance
        return Promise.reject('fetch failed');
      }
      // Second endpoint succeeds
      void secondServer;
      return Promise.resolve('ok from rpc2');
    });

    expect(result).toBe('ok from rpc2');
    expect(callCount).toBe(2);
  });

  it('falls over to the second endpoint when the first rejects with a DOMException-like object', async () => {
    const pool = new RpcEndpointPool([
      'https://rpc1.example.com',
      'https://rpc2.example.com',
    ]);

    let callCount = 0;
    const result = await pool.withFailover((_server, rpcUrl) => {
      callCount += 1;
      if (rpcUrl === 'https://rpc1.example.com') {
        return Promise.reject({ name: 'NetworkError', message: 'network error' });
      }
      return Promise.resolve('ok');
    });

    expect(result).toBe('ok');
    expect(callCount).toBe(2);
  });
});

// === Fix 4: WillStatus — PendingConfirmation and Settled in getNextActionableState

describe('getNextActionableState — new WillStatus variants', () => {
  const ALL_FALSE = {
    canCheckIn: false,
    canTrigger: false,
    canEmergencyCheckIn: false,
    canRelease: false,
    canCancel: false,
    canGuardianVote: false,
  };

  it('returns all-false for PendingConfirmation regardless of caller role', () => {
    const will = makeWill({ status: WillStatus.PendingConfirmation });
    expect(getNextActionableState(will, 'GOWNER')).toEqual(ALL_FALSE);
    expect(getNextActionableState(will, 'GSTRANGER')).toEqual(ALL_FALSE);
  });

  it('returns all-false for Settled regardless of caller role', () => {
    const will = makeWill({ status: WillStatus.Settled });
    expect(getNextActionableState(will, 'GOWNER')).toEqual(ALL_FALSE);
    expect(getNextActionableState(will, 'GSTRANGER')).toEqual(ALL_FALSE);
  });

  it('still returns correct actions for Active status after the enum addition', () => {
    const will = makeWill({ status: WillStatus.Active });
    const state = getNextActionableState(will, 'GOWNER');
    expect(state.canCheckIn).toBe(true);
    expect(state.canCancel).toBe(true);
    expect(state.canTrigger).toBe(false); // checkin not overdue
  });
});

// === Fix 4: WillStatus enum values match contract

describe('WillStatus enum values', () => {
  it('contains all six contract variants', () => {
    expect(WillStatus.PendingConfirmation).toBe('PendingConfirmation');
    expect(WillStatus.Active).toBe('Active');
    expect(WillStatus.Triggered).toBe('Triggered');
    expect(WillStatus.Released).toBe('Released');
    expect(WillStatus.Cancelled).toBe('Cancelled');
    expect(WillStatus.Settled).toBe('Settled');
  });
});
