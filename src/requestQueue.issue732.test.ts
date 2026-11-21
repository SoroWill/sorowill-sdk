/**
 * Tests for issue #732: request tracing for debugging.
 *
 * Verifies that every enqueued request gets a unique ID and that its queued,
 * sent and response timings and operation type are recorded and readable
 * through RequestQueue.getTraces() / getTrace().
 */
import { describe, it, expect } from 'vitest';
import { RequestQueue, MAX_REQUEST_TRACES, RequestPriority } from './requestQueue';

describe('#732 RequestQueue request tracing', () => {
  it('generates a distinct ID for each request', async () => {
    const queue = new RequestQueue();
    await Promise.all([
      queue.enqueue(async () => 1),
      queue.enqueue(async () => 2),
      queue.enqueue(async () => 3),
    ]);

    const ids = queue.getTraces().map((trace) => trace.id);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) {
      expect(id).toMatch(/^req-/);
    }
  });

  it('records the operation type passed to enqueue', async () => {
    const queue = new RequestQueue();
    await queue.enqueue(async () => 'ok', undefined, undefined, RequestPriority.Normal, 'getWill');

    const [trace] = queue.getTraces();
    expect(trace?.method).toBe('getWill');
  });

  it('records queued, sent and response timings in order', async () => {
    const queue = new RequestQueue();
    await queue.enqueue(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return 'done';
    });

    const [trace] = queue.getTraces();
    expect(trace).toBeDefined();
    expect(trace!.enqueuedAt).toBeLessThanOrEqual(trace!.sentAt);
    expect(trace!.sentAt).toBeLessThanOrEqual(trace!.respondedAt);
    expect(trace!.queuedMs).toBe(trace!.sentAt - trace!.enqueuedAt);
    expect(trace!.roundTripMs).toBe(trace!.respondedAt - trace!.sentAt);
    expect(trace!.roundTripMs).toBeGreaterThanOrEqual(15);
  });

  it('marks requests that reject as errors while still recording them', async () => {
    const queue = new RequestQueue();
    await expect(
      queue.enqueue(async () => {
        throw new Error('boom');
      }, undefined, undefined, RequestPriority.Normal, 'submitTx'),
    ).rejects.toThrow('boom');

    const [trace] = queue.getTraces();
    expect(trace?.status).toBe('error');
    expect(trace?.method).toBe('submitTx');
  });

  it('marks successful requests with success status and their priority', async () => {
    const queue = new RequestQueue();
    await queue.enqueue(async () => 1, undefined, undefined, RequestPriority.High, 'read');

    const [trace] = queue.getTraces();
    expect(trace?.status).toBe('success');
    expect(trace?.priority).toBe(RequestPriority.High);
  });

  it('looks up a single trace by its request ID', async () => {
    const queue = new RequestQueue();
    await queue.enqueue(async () => 'a', undefined, undefined, RequestPriority.Normal, 'first');
    await queue.enqueue(async () => 'b', undefined, undefined, RequestPriority.Normal, 'second');

    const [, second] = queue.getTraces();
    expect(second).toBeDefined();
    expect(queue.getTrace(second!.id)?.method).toBe('second');
    expect(queue.getTrace('req-does-not-exist')).toBeUndefined();
  });

  it('returns copies so callers cannot mutate recorded traces', async () => {
    const queue = new RequestQueue();
    await queue.enqueue(async () => 1, undefined, undefined, RequestPriority.Normal, 'read');

    const [trace] = queue.getTraces();
    trace!.status = 'error';
    expect(queue.getTraces()[0]?.status).toBe('success');
  });

  it(`keeps only the most recent ${MAX_REQUEST_TRACES} traces`, async () => {
    const queue = new RequestQueue({ maxConcurrent: 10, requestsPerSecond: 10_000 });
    const total = MAX_REQUEST_TRACES + 5;
    const ops = Array.from({ length: total }, (_, index) =>
      queue.enqueue(async () => index, undefined, undefined, RequestPriority.Normal, `op-${index}`),
    );
    await Promise.all(ops);

    const traces = queue.getTraces();
    expect(traces).toHaveLength(MAX_REQUEST_TRACES);
    // The oldest five were dropped, so the first remaining operation is op-5.
    expect(traces[0]?.method).toBe('op-5');
    expect(traces[traces.length - 1]?.method).toBe(`op-${total - 1}`);
  });
});
