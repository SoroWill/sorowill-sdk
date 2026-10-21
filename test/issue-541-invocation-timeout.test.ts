import { afterEach, describe, expect, it, vi } from 'vitest';
import { SoroWillClient } from '../src/SoroWillClient';

describe('Issue #541 — invocation RPC timeouts', () => {
  const clients: SoroWillClient[] = [];

  afterEach(() => {
    for (const client of clients.splice(0)) client.destroy();
    vi.restoreAllMocks();
  });

  it('uses the 30-second default and honors a per-call timeout override', async () => {
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
    });
    clients.push(client);

    const internals = client as unknown as {
      queue: { enqueue: ReturnType<typeof vi.fn> };
      rpc<T>(request: () => Promise<T>, options?: { timeoutMs?: number }): Promise<T>;
    };
    vi.spyOn(internals.queue, 'enqueue').mockImplementation((run: () => Promise<unknown>) => run());

    await internals.rpc(async () => 'default');
    await internals.rpc(async () => 'override', { timeoutMs: 2_500 });

    expect(internals.queue.enqueue.mock.calls.map((call: unknown[]) => call[1])).toEqual([
      30_000,
      2_500,
    ]);
  });
});
