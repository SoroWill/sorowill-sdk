/**
 * Tests for issue #731: RPC endpoint health monitoring and automatic switching.
 *
 * Covers the startup health check, periodic re-checks (which also retry
 * unhealthy endpoints), failover from an unhealthy primary to a healthy
 * secondary, and stopping the monitor.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  RpcEndpointPool,
  DEFAULT_RPC_HEALTH_CHECK_INTERVAL_MS,
} from './rpc';
import type { SoroWillRpcServer } from './SoroWillClient';

const PRIMARY = 'https://primary.example.org';
const SECONDARY = 'https://secondary.example.org';

interface FakeServerState {
  status: 'healthy' | 'unhealthy' | 'throw' | 'missing';
  calls: number;
}

/** Builds a fake RPC server whose getHealth() behaviour is controlled by `state`. */
function fakeServer(state: FakeServerState): SoroWillRpcServer {
  const server: Partial<SoroWillRpcServer> = {
    getHealth: async () => {
      state.calls += 1;
      if (state.status === 'throw') throw new Error('connect ECONNREFUSED');
      return { status: state.status === 'healthy' ? 'healthy' : 'unhealthy' } as never;
    },
  };
  if (state.status === 'missing') {
    delete server.getHealth;
  }
  return server as SoroWillRpcServer;
}

/** Creates a two-endpoint pool and swaps in fake servers so health is controllable. */
function createPool(primary: FakeServerState, secondary: FakeServerState): {
  pool: RpcEndpointPool;
  primaryState: FakeServerState;
  secondaryState: FakeServerState;
} {
  const pool = new RpcEndpointPool([PRIMARY, SECONDARY]);
  (pool as unknown as { servers: SoroWillRpcServer[] }).servers = [
    fakeServer(primary),
    fakeServer(secondary),
  ];
  return { pool, primaryState: primary, secondaryState: secondary };
}

describe('#731 RpcEndpointPool health monitoring', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('checkEndpointHealth', () => {
    it('reports an endpoint healthy when getHealth reports healthy', async () => {
      const { pool } = createPool(
        { status: 'healthy', calls: 0 },
        { status: 'healthy', calls: 0 },
      );
      await expect(pool.checkEndpointHealth(0)).resolves.toBe(true);
      expect(pool.getEndpointHealth(0)).toBe(true);
    });

    it('reports an endpoint unhealthy when getHealth reports a non-healthy status', async () => {
      const { pool } = createPool(
        { status: 'unhealthy', calls: 0 },
        { status: 'healthy', calls: 0 },
      );
      await expect(pool.checkEndpointHealth(0)).resolves.toBe(false);
    });

    it('reports an endpoint unhealthy when getHealth throws', async () => {
      const { pool } = createPool(
        { status: 'throw', calls: 0 },
        { status: 'healthy', calls: 0 },
      );
      await expect(pool.checkEndpointHealth(0)).resolves.toBe(false);
      expect(pool.getEndpointHealth(0)).toBe(false);
    });

    it('treats a server without getHealth as unhealthy', async () => {
      const { pool } = createPool(
        { status: 'missing', calls: 0 },
        { status: 'healthy', calls: 0 },
      );
      await expect(pool.checkEndpointHealth(0)).resolves.toBe(false);
    });

    it('has no health result until an endpoint has been checked', () => {
      const pool = new RpcEndpointPool([PRIMARY]);
      expect(pool.getEndpointHealth(0)).toBeUndefined();
    });
  });

  describe('automatic switching', () => {
    it('switches the active endpoint to the healthy secondary when the primary is down', async () => {
      const { pool } = createPool(
        { status: 'throw', calls: 0 },
        { status: 'healthy', calls: 0 },
      );
      expect(pool.getActiveRpcUrl()).toBe(PRIMARY);

      await pool.runHealthChecks();

      expect(pool.getActiveRpcUrl()).toBe(SECONDARY);
    });

    it('keeps the primary active while it is healthy', async () => {
      const { pool } = createPool(
        { status: 'healthy', calls: 0 },
        { status: 'healthy', calls: 0 },
      );
      await pool.runHealthChecks();
      expect(pool.getActiveRpcUrl()).toBe(PRIMARY);
    });

    it('routes requests away from an unhealthy primary without first failing on it', async () => {
      const primary = { status: 'throw', calls: 0 } as FakeServerState;
      const { pool } = createPool(primary, { status: 'healthy', calls: 0 });
      await pool.runHealthChecks();

      const operation = vi.fn(async (_server: SoroWillRpcServer, rpcUrl: string) => rpcUrl);
      const result = await pool.withFailover(operation);

      expect(result).toBe(SECONDARY);
      expect(operation).toHaveBeenCalledTimes(1);
    });
  });

  describe('startHealthMonitoring', () => {
    it('runs a health check on startup', async () => {
      const primary: FakeServerState = { status: 'healthy', calls: 0 };
      const secondary: FakeServerState = { status: 'healthy', calls: 0 };
      const { pool } = createPool(primary, secondary);

      await pool.startHealthMonitoring();

      expect(primary.calls).toBe(1);
      expect(secondary.calls).toBe(1);
      expect(pool.getEndpointHealth(0)).toBe(true);
      expect(pool.getEndpointHealth(1)).toBe(true);
      pool.stopHealthMonitoring();
    });

    it('re-checks every 30 seconds', async () => {
      const primary: FakeServerState = { status: 'healthy', calls: 0 };
      const { pool } = createPool(primary, { status: 'healthy', calls: 0 });

      await pool.startHealthMonitoring();
      expect(primary.calls).toBe(1);

      await vi.advanceTimersByTimeAsync(DEFAULT_RPC_HEALTH_CHECK_INTERVAL_MS);
      expect(primary.calls).toBe(2);
      pool.stopHealthMonitoring();
    });

    it('retries an unhealthy endpoint on each interval and marks it healthy on recovery', async () => {
      const primary: FakeServerState = { status: 'throw', calls: 0 };
      const { pool } = createPool(primary, { status: 'healthy', calls: 0 });

      await pool.startHealthMonitoring();
      expect(pool.getEndpointHealth(0)).toBe(false);

      primary.status = 'healthy';
      await vi.advanceTimersByTimeAsync(DEFAULT_RPC_HEALTH_CHECK_INTERVAL_MS);

      expect(pool.getEndpointHealth(0)).toBe(true);
      pool.stopHealthMonitoring();
    });

    it('stops checking once stopHealthMonitoring is called', async () => {
      const primary: FakeServerState = { status: 'healthy', calls: 0 };
      const { pool } = createPool(primary, { status: 'healthy', calls: 0 });

      await pool.startHealthMonitoring();
      pool.stopHealthMonitoring();
      const callsAtStop = primary.calls;

      await vi.advanceTimersByTimeAsync(DEFAULT_RPC_HEALTH_CHECK_INTERVAL_MS * 3);
      expect(primary.calls).toBe(callsAtStop);
    });

    it('rejects a non-positive interval', () => {
      const pool = new RpcEndpointPool([PRIMARY]);
      expect(() => pool.startHealthMonitoring(0)).toThrow(RangeError);
    });
  });
});
