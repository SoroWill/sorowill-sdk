/**
 * Tests for issue #618: the EventSubscription filter doesn't validate event
 * type enum values, so invalid types produce a subscription that silently
 * matches nothing.
 *
 * Fix: `eventTypes` is validated against SOROBAN_EVENT_TYPES and rejected
 * with InvalidEventTypeFilterError; valid types are forwarded to the RPC
 * filter and enforced client-side.
 */

import { describe, it, expect, vi } from 'vitest';
import { SoroWillClient } from '../src/SoroWillClient';
import { InvalidEventTypeFilterError } from '../src/errors';
import { validateEventTypeFilter } from '../src/events';
import { SOROBAN_EVENT_TYPES } from '../src/types';

const CONTRACT_ID = 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE';

function makePollingClient(events: Array<{ id: string; type: string }>) {
  const bodies: Array<{ params: { filters: Array<{ type?: string; contractIds: string[] }> } }> = [];
  const fetchImpl = vi.fn(async (_url: string, init: { body: string }) => {
    bodies.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({ result: { events, nextCursor: 'c1' } }) };
  });
  const client = new SoroWillClient({ network: 'testnet', contractId: CONTRACT_ID, fetch: fetchImpl as any });
  return { client, fetchImpl, bodies };
}

describe('issue #618 — validateEventTypeFilter', () => {
  it('returns undefined when no filter is given', () => {
    expect(validateEventTypeFilter(undefined)).toBeUndefined();
  });

  it('accepts every supported event type and de-duplicates', () => {
    expect(validateEventTypeFilter([...SOROBAN_EVENT_TYPES, 'contract'])).toEqual([
      'contract',
      'system',
      'diagnostic',
    ]);
  });

  it.each([
    ['an unknown string', ['contracts']],
    ['a wrong-case string', ['Contract']],
    ['a non-string entry', [42]],
    ['a mix of valid and invalid entries', ['contract', 'bogus']],
    ['an empty array', []],
    ['a non-array value', 'contract'],
  ])('rejects %s', (_label, filter) => {
    expect(() => validateEventTypeFilter(filter)).toThrow(InvalidEventTypeFilterError);
  });

  it('reports only the invalid entries and the supported types', () => {
    try {
      validateEventTypeFilter(['contract', 'bogus', 7]);
      expect.unreachable();
    } catch (err) {
      const e = err as InvalidEventTypeFilterError;
      expect(e).toBeInstanceOf(InvalidEventTypeFilterError);
      expect(e.invalidTypes).toEqual(['bogus', 7]);
      expect(e.supportedTypes).toEqual(SOROBAN_EVENT_TYPES);
      expect(e.message).toContain('"bogus"');
      expect(e.message).toContain('contract, system, diagnostic');
    }
  });
});

describe('issue #618 — subscribeToEvents eventTypes filter', () => {
  it('rejects an invalid event type before making any request', async () => {
    const { client, fetchImpl } = makePollingClient([]);
    await expect(
      client.subscribeToEvents(() => {}, { transport: 'polling', eventTypes: ['bogus' as any] }),
    ).rejects.toBeInstanceOf(InvalidEventTypeFilterError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('sends one RPC filter per type and only delivers matching events', async () => {
    const { client, bodies } = makePollingClient([
      { id: 'e1', type: 'contract' },
      { id: 'e2', type: 'diagnostic' },
      { id: 'e3', type: 'system' },
    ]);
    const delivered: string[] = [];
    const subscription = await client.subscribeToEvents((event) => delivered.push(event.id), {
      transport: 'polling',
      pollIntervalMs: 60_000,
      eventTypes: ['contract', 'system'],
    });
    subscription.close();

    expect(bodies[0]!.params.filters).toEqual([
      { type: 'contract', contractIds: [CONTRACT_ID] },
      { type: 'system', contractIds: [CONTRACT_ID] },
    ]);
    expect(delivered).toEqual(['e1', 'e3']);
  });

  it('keeps the unfiltered behaviour when eventTypes is omitted', async () => {
    const { client, bodies } = makePollingClient([{ id: 'e1', type: 'diagnostic' }]);
    const delivered: string[] = [];
    const subscription = await client.subscribeToEvents((event) => delivered.push(event.id), {
      transport: 'polling',
      pollIntervalMs: 60_000,
    });
    subscription.close();

    expect(bodies[0]!.params.filters).toEqual([{ contractIds: [CONTRACT_ID] }]);
    expect(delivered).toEqual(['e1']);
  });
});
