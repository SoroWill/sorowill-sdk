/**
 * Tests for issue #632: DebugLogger circular reference protection.
 *
 * Verifies that logging objects with circular references does not cause a
 * stack overflow and instead safely substitutes "[Circular]".
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { DebugLogger } from './debugLogger';

// Force debug mode on in tests by temporarily clearing NODE_ENV guard
function makeActiveLogger(): DebugLogger {
  // DebugLogger is disabled in production; override env so tests can exercise the paths
  const orig = process.env['NODE_ENV'];
  process.env['NODE_ENV'] = 'test';
  const logger = new DebugLogger(true);
  process.env['NODE_ENV'] = orig;
  return logger;
}

describe('#632 DebugLogger — circular reference protection', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not throw when details contain a circular reference', () => {
    const logger = makeActiveLogger();
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // Build a circular object
    const circular: Record<string, unknown> = { a: 1 };
    circular['self'] = circular;

    expect(() => {
      logger.logOperationBuild('create_will', undefined, { circular });
    }).not.toThrow();

    consoleSpy.mockRestore();
  });

  it('outputs "[Circular]" in place of the circular reference', () => {
    const logger = makeActiveLogger();
    let captured = '';
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation((msg: string) => {
      captured = msg;
    });

    const circular: Record<string, unknown> = { x: 'hello' };
    circular['loop'] = circular;

    logger.logOperationBuild('test_method', undefined, { data: circular });

    consoleSpy.mockRestore();

    expect(captured).toContain('[Circular]');
  });

  it('still logs non-circular objects normally', () => {
    const logger = makeActiveLogger();
    let captured = '';
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation((msg: string) => {
      captured = msg;
    });

    logger.logOperationBuild('create_will', '42', { amount: '1000', token: 'native' });

    consoleSpy.mockRestore();

    const parsed = JSON.parse(captured);
    expect(parsed.method).toBe('create_will');
    expect(parsed.willId).toBe('42');
    expect(parsed.details.amount).toBe('1000');
  });

  it('handles deeply nested circular references without stack overflow', () => {
    const logger = makeActiveLogger();
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // Multi-level indirect cycle: a → b → c → a
    const a: Record<string, unknown> = { name: 'a' };
    const b: Record<string, unknown> = { name: 'b', ref: a };
    const c: Record<string, unknown> = { name: 'c', ref: b };
    a['ref'] = c; // completes the cycle

    expect(() => {
      logger.logError('test_method', '1', new Error('test'));
      logger.logOperationBuild('method', undefined, { node: a });
    }).not.toThrow();

    consoleSpy.mockRestore();
  });

  it('handles circular arrays without throwing', () => {
    const logger = makeActiveLogger();
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const arr: any[] = [1, 2, 3];
    arr.push(arr); // circular array

    expect(() => {
      logger.logOperationBuild('method', undefined, { items: arr });
    }).not.toThrow();

    consoleSpy.mockRestore();
  });

  it('logs all normal log levels without error', () => {
    const logger = makeActiveLogger();
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(() => {
      logger.logSimulation('method', '1', '100');
      logger.logSubmission('method', '1', 'txhash');
      logger.logPoll('method', '1', 1, 30);
      logger.logSuccess('method', '1', 'txhash', 500);
      logger.logError('method', '1', new Error('oops'));
    }).not.toThrow();

    consoleSpy.mockRestore();
  });
});
