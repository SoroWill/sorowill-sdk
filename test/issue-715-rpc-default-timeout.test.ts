/**
 * Issue #715 — RPC calls hang indefinitely without timeout.
 *
 * Acceptance criteria:
 * - Default 30s timeout on all RPC calls
 * - Timeout configurable per method
 * - Clear error on timeout vs network error
 * - Retry logic works with timeout
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RPC_TIMEOUT_MS,
  RpcEndpointPool,
  isRetryableRpcConnectionError,
  isRpcTimeoutError,
} from '../src/rpc';
import type { SoroWillRpcServer } from '../src/SoroWillClient';

const URL = 'https://rpc.example.invalid';

function hangingServer(): SoroWillRpcServer {
  return {
    getLatestLedger: () => new Promise<never>(() => undefined),
  } as unknown as SoroWillRpcServer;
}

function failingServer(message: string): SoroWillRpcServer {
  return {
    getLatestLedger: async () => {
      throw new Error(message);
    },
  } as unknown as SoroWillRpcServer;
}

describe('Issue #715 — RPC timeouts', () => {
  it('defaults to a 30s timeout', () => {
    expect(DEFAULT_RPC_TIMEOUT_MS).toBe(30_000);
  });

  it('rejects a hanging call instead of waiting forever', async () => {
    const pool = new RpcEndpointPool([URL], hangingServer(), 0, 50, 1, 1);
    const err = await pool
      .withFailover((server) => server.getLatestLedger())
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect(isRpcTimeoutError(err)).toBe(true);
  }, 5_000);

  it('timeout errors are distinguishable from network errors', async () => {
    const pool = new RpcEndpointPool([URL], hangingServer(), 0, 20, 1, 1);
    const timeoutErr = await pool
      .withFailover((server) => server.getLatestLedger())
      .catch((e: unknown) => e);
    const networkErr = new Error('fetch failed: ECONNREFUSED');

    expect(isRpcTimeoutError(timeoutErr)).toBe(true);
    expect(isRpcTimeoutError(networkErr)).toBe(false);
    expect(isRetryableRpcConnectionError(networkErr)).toBe(true);
  }, 5_000);

  it('a non-timeout failure is not reported as a timeout', async () => {
    const pool = new RpcEndpointPool([URL], failingServer('connection reset'), 0, 1_000, 1, 1);
    const err = await pool
      .withFailover((server) => server.getLatestLedger())
      .catch((e: unknown) => e);

    expect(isRpcTimeoutError(err)).toBe(false);
  });
});
