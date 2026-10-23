import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DebugLogger } from '../src/debugLogger';

describe('DebugLogger', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
  });

  it('does not log when disabled', () => {
    const logger = new DebugLogger(false);
    logger.logOperationBuild('create_will', '1');
    expect(consoleLogSpy).not.toHaveBeenCalled();
  });

  it('logs structured simulation entries when enabled', () => {
    const logger = new DebugLogger(true);
    logger.logSimulation('check_in', '7', '1500', { attempt: 1 });

    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    expect(consoleLogSpy.mock.calls[0]?.[0]).toContain('"level":"simulation"');
    expect(consoleLogSpy.mock.calls[0]?.[0]).toContain('"method":"check_in"');
    expect(consoleLogSpy.mock.calls[0]?.[0]).toContain('"willId":"7"');
  });

  it('logs submission entries with tx hashes', () => {
    const logger = new DebugLogger(true);
    logger.logSubmission('trigger_will', '9', 'abc123');

    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    expect(consoleLogSpy.mock.calls[0]?.[0]).toContain('"level":"submission"');
    expect(consoleLogSpy.mock.calls[0]?.[0]).toContain('"txHash":"abc123"');
  });

  it('includes a correlationId in every log entry', () => {
    const logger = new DebugLogger(true, 'corr-123');
    logger.logOperationBuild('create_will', '1');
    logger.logSimulation('check_in', '7', '1500', { attempt: 1 });
    logger.logSubmission('trigger_will', '9', 'abc123');

    expect(consoleLogSpy).toHaveBeenCalledTimes(3);
    for (const call of consoleLogSpy.mock.calls) {
      const entry = JSON.parse(call[0] as string);
      expect(entry.correlationId).toBe('corr-123');
    }
  });

  it('propagates a generated correlationId when none is provided', () => {
    const logger = new DebugLogger(true);
    const id = logger.correlationId;
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);

    logger.logOperationBuild('create_will', '1');
    logger.logSubmission('trigger_will', '9', 'abc123');

    for (const call of consoleLogSpy.mock.calls) {
      const entry = JSON.parse(call[0] as string);
      expect(entry.correlationId).toBe(id);
    }
  });

  it('generates distinct correlationIds for separate logger instances', () => {
    const a = new DebugLogger(true);
    const b = new DebugLogger(true);
    expect(a.correlationId).not.toBe(b.correlationId);
  });
});
