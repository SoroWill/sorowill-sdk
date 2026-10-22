import { afterEach, describe, expect, it, vi } from 'vitest';
import { SoroWillClient } from '../src/SoroWillClient';

/**
 * Issue #629 — SoroWillClient doesn't expose operation timeout configuration
 *
 * Acceptance criteria:
 * - Timeout configurable per operation via RequestOptions.timeoutMs
 * - Reasonable defaults (30 000 ms) when no timeout is specified
 * - Test validates that per-call timeout overrides the client-level default
 */
describe('Issue #629 — per-operation timeout configuration', () => {
  const clients: SoroWillClient[] = [];

  afterEach(() => {
    for (const client of clients.splice(0)) client.destroy();
    vi.restoreAllMocks();
  });

  it('uses the 30-second default timeout when no override is provided', async () => {
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
    });
    clients.push(client);

    const internals = client as unknown as {
      timeoutMs: number;
      rpc<T>(request: () => Promise<T>, options?: { timeoutMs?: number }): Promise<T>;
      queue: { enqueue: ReturnType<typeof vi.fn> };
    };

    // Default timeout should be 30 000 ms
    expect(internals.timeoutMs).toBe(30_000);
  });

  it('respects a custom client-level timeoutMs', () => {
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
      timeoutMs: 10_000,
    });
    clients.push(client);

    const internals = client as unknown as { timeoutMs: number };
    expect(internals.timeoutMs).toBe(10_000);
  });

  it('passes per-call timeoutMs to the request queue, overriding the client default', async () => {
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
      timeoutMs: 30_000,
    });
    clients.push(client);

    const internals = client as unknown as {
      rpc<T>(request: () => Promise<T>, options?: { timeoutMs?: number }, method?: string): Promise<T>;
      queue: { enqueue: ReturnType<typeof vi.fn> };
    };

    vi.spyOn(internals.queue, 'enqueue').mockImplementation((run: () => Promise<unknown>) => run());

    // call rpc without per-call override → should use client default (30 000)
    await internals.rpc(async () => 'default');
    // call rpc with per-call override → should use 5 000
    await internals.rpc(async () => 'custom', { timeoutMs: 5_000 });

    const enqueuedTimeouts = internals.queue.enqueue.mock.calls.map(
      (call: unknown[]) => call[1],
    );
    expect(enqueuedTimeouts).toEqual([30_000, 5_000]);
  });

  it('rejects a non-positive timeoutMs at construction time', () => {
    expect(() => {
      new SoroWillClient({
        network: 'testnet',
        contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
        timeoutMs: 0,
      });
    }).toThrow(RangeError);

    expect(() => {
      new SoroWillClient({
        network: 'testnet',
        contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
        timeoutMs: -1,
      });
    }).toThrow(RangeError);
  });

  it('rejects a zero or negative per-call timeoutMs via the queue', async () => {
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
    });
    clients.push(client);

    const internals = client as unknown as {
      rpc<T>(request: () => Promise<T>, options?: { timeoutMs?: number }): Promise<T>;
    };

    await expect(
      internals.rpc(async () => 'value', { timeoutMs: 0 }),
    ).rejects.toThrow(RangeError);
  });
});
