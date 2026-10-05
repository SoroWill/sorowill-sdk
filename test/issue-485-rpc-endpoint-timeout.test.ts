import { describe, expect, it, vi } from 'vitest';
import { RpcEndpointPool } from '../src/rpc';
import type { SoroWillRpcServer } from '../src/SoroWillClient';

/**
 * Issue #485 — RpcEndpointPool does not fall back to secondary endpoints if
 * the primary endpoint hangs, blocking forever.
 *
 * Per-endpoint timeouts must be enforced. A slow/unresponsive endpoint should
 * be rotated to the back of the pool so that secondary endpoints are tried.
 */
describe('Issue #485 — RpcEndpointPool per-endpoint timeout and failover', () => {
  // Note: Most tests use real timers, but some require fake timers for reliable
  // endpoint state tracking during timeout/failover sequences.

  // Unused helper - commented out with its callers
  // function makeMockServer(behaviour: 'hang' | 'fast' | 'error'): SoroWillRpcServer {
  //   return {
  //     getHealth: vi.fn(async () => {
  //       if (behaviour === 'hang') {
  //         // Never resolves — simulates an unresponsive primary endpoint
  //         return new Promise<never>(() => undefined);
  //       }
  //       if (behaviour === 'error') {
  //         throw new Error('fetch failed');
  //       }
  //       return { status: 'healthy' };
  //     }),
  //     simulateTransaction: vi.fn(),
  //     getAccount: vi.fn(),
  //     prepareTransaction: vi.fn(),
  //     sendTransaction: vi.fn(),
  //     pollTransaction: vi.fn(),
  //     getContractWasmByContractId: vi.fn(),
  //   } as unknown as SoroWillRpcServer;
  // }

  it('falls back to the secondary endpoint when the primary hangs beyond endpointTimeoutMs', async () => {
    // Alternate servers: index 0 → primary (hangs), index 1 → secondary (fast).
    let callIndex = 0;
    const serverOverride = {
      getHealth: vi.fn(async () => {
        const idx = callIndex++;
        if (idx === 0) {
          // Simulate primary hanging indefinitely
          return new Promise<never>(() => undefined);
        }
        return { status: 'healthy' };
      }),
    } as unknown as SoroWillRpcServer;

    // Use a very short timeout (50 ms) so the test runs quickly with real timers.
    const pool = new RpcEndpointPool(
      ['https://primary.example', 'https://secondary.example'],
      serverOverride,
      60_000, // failoverCooldownMs
      50,     // endpointTimeoutMs
    );

    // With real timers, the operation will timeout naturally after 50ms
    const result = await pool.withFailover((server) => (server as any).getHealth());
    expect(result).toEqual({ status: 'healthy' });
    // The hanging call was attempted once, then the secondary was called.
    expect(callIndex).toBe(2);
  });

  it('rotates the slow endpoint to the back of the pool after a timeout', async () => {
    let callIndex = 0;
    const serverOverride = {
      getHealth: vi.fn(async () => {
        const idx = callIndex++;
        if (idx === 0) {
          // Primary hangs on first call
          return new Promise<never>(() => undefined);
        }
        return { status: 'ok' };
      }),
    } as unknown as SoroWillRpcServer;

    const pool = new RpcEndpointPool(
      ['https://primary.example', 'https://secondary.example'],
      serverOverride,
      60_000,
      50,
      1, // Only 1 attempt per endpoint to avoid retries with real timers
    );

    const result = await pool.withFailover((server) => (server as any).getHealth()).catch(() => null);

    // Should have succeeded with the secondary endpoint
    expect(result).toEqual({ status: 'ok' });

    // After the failover the active URL should be the secondary.
    expect(pool.getActiveRpcUrl()).toBe('https://secondary.example');
  });

  it('surfaces the error when all endpoints time out', async () => {
    const serverOverride = {
      getHealth: vi.fn(async () => {
        return new Promise<never>(() => undefined);
      }),
    } as unknown as SoroWillRpcServer;

    const pool = new RpcEndpointPool(
      ['https://primary.example', 'https://secondary.example'],
      serverOverride,
      60_000,
      50,
      1, // Only 1 attempt per endpoint
    );

    // Both endpoints will timeout
    await expect(pool.withFailover((server) => (server as any).getHealth())).rejects.toThrow(/timed out/i);
  });

  it('does not apply per-endpoint timeout when endpointTimeoutMs is 0 (disabled)', async () => {
    let resolved = false;
    let resolveFn: (() => void) | undefined;

    const serverOverride = {
      getHealth: vi.fn(async () => {
        return new Promise<string>((resolve) => {
          resolveFn = () => {
            resolved = true;
            resolve('ok');
          };
        });
      }),
    } as unknown as SoroWillRpcServer;

    // Disable timeout by passing 0
    const pool = new RpcEndpointPool(
      ['https://primary.example'],
      serverOverride,
      60_000,
      0, // timeout disabled
    );

    const p = pool.withFailover((server) => (server as any).getHealth());

    // Wait a short time - the operation should still be pending since no timeout
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(resolved).toBe(false);

    // Resolve the pending operation manually.
    resolveFn?.();
    const result = await p;
    expect(result).toBe('ok');
  });

  it('promotes the primary endpoint again after the failover cooldown', async () => {
    let callIndex = 0;
    // Note: This test cannot use fake timers reliably; cooldown is tested with actual timing
    // const serverOverride = {
    //   getHealth: vi.fn(async () => {
    //     callIndex++;
    //     return { status: 'ok' };
    //   }),
    // } as unknown as SoroWillRpcServer;

    const pool = new RpcEndpointPool(
      ['https://primary.example', 'https://secondary.example'],
      {
        getHealth: vi.fn(async () => {
          const idx = callIndex++;
          if (idx === 0) return new Promise<never>(() => undefined);
          return { status: 'ok' };
        }),
      } as unknown as SoroWillRpcServer,
      100, // short failoverCooldownMs so we can test repromotion quickly
      50,
      1,  // Only 1 attempt per endpoint
    );

    // First call — primary hangs, secondary takes over.
    await pool.withFailover((server) => (server as any).getHealth());
    expect(pool.getActiveRpcUrl()).toBe('https://secondary.example');

    // Wait past the failover cooldown (100ms).
    await new Promise(resolve => setTimeout(resolve, 150));

    // After cooldown, the next call should re-promote the primary.
    await pool.withFailover((server) => (server as any).getHealth());
    expect(pool.getActiveRpcUrl()).toBe('https://primary.example');
  });
});
