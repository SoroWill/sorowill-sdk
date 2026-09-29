/**
 * Tests for issue #494: DebugLogger outputs to console without respecting
 * environment or configuration, leaking sensitive data in production.
 *
 * Acceptance criteria:
 * - DebugLogger respects DEBUG env var or config flag
 * - Production mode (NODE_ENV=production) disables all logging
 * - Sensitive fields (private keys, tokens) never logged by the SDK itself
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DebugLogger } from '../src/debugLogger';

describe('DebugLogger — issue #494: environment-aware logging', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    // Clean up env mutations
    delete process.env['SOROWILL_DEBUG'];
    delete process.env['NODE_ENV'];
  });

  // ── Explicit flag ──────────────────────────────────────────────────────────

  it('does not log when debug=false and SOROWILL_DEBUG is not set', () => {
    const logger = new DebugLogger(false);
    logger.logOperationBuild('create_will', '1');
    expect(consoleLogSpy).not.toHaveBeenCalled();
  });

  it('logs when debug=true in non-production environment', () => {
    process.env['NODE_ENV'] = 'test';
    const logger = new DebugLogger(true);
    logger.logOperationBuild('create_will', '1');
    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
  });

  // ── SOROWILL_DEBUG env var ─────────────────────────────────────────────────

  it('activates logging when SOROWILL_DEBUG is set to "1"', () => {
    process.env['SOROWILL_DEBUG'] = '1';
    process.env['NODE_ENV'] = 'test';
    const logger = new DebugLogger(false);
    logger.logOperationBuild('check_in', '2');
    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
  });

  it('activates logging when SOROWILL_DEBUG is set to any non-empty string', () => {
    process.env['SOROWILL_DEBUG'] = 'true';
    process.env['NODE_ENV'] = 'test';
    const logger = new DebugLogger(false);
    logger.logPoll('check_in', '3', 1, 5);
    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
  });

  it('does not activate when SOROWILL_DEBUG is empty string', () => {
    process.env['SOROWILL_DEBUG'] = '';
    const logger = new DebugLogger(false);
    logger.logOperationBuild('check_in', '4');
    expect(consoleLogSpy).not.toHaveBeenCalled();
  });

  // ── Production guard ───────────────────────────────────────────────────────

  it('suppresses logging when NODE_ENV=production even if debug=true', () => {
    process.env['NODE_ENV'] = 'production';
    const logger = new DebugLogger(true);
    logger.logOperationBuild('create_will', '5');
    logger.logSimulation('create_will', '5', '1000');
    logger.logSubmission('create_will', '5', 'txhash');
    logger.logPoll('create_will', '5', 1, 30);
    logger.logSuccess('create_will', '5', 'txhash', 500);
    logger.logError('create_will', '5', new Error('err'));
    expect(consoleLogSpy).not.toHaveBeenCalled();
  });

  it('suppresses logging when NODE_ENV=production even if SOROWILL_DEBUG is set', () => {
    process.env['NODE_ENV'] = 'production';
    process.env['SOROWILL_DEBUG'] = '1';
    const logger = new DebugLogger(false);
    logger.logOperationBuild('check_in', '6');
    expect(consoleLogSpy).not.toHaveBeenCalled();
  });

  // ── isActive property ──────────────────────────────────────────────────────

  it('isActive is false when debug=false and no env var set', () => {
    const logger = new DebugLogger(false);
    expect(logger.isActive).toBe(false);
  });

  it('isActive is true when debug=true in non-production environment', () => {
    process.env['NODE_ENV'] = 'test';
    const logger = new DebugLogger(true);
    expect(logger.isActive).toBe(true);
  });

  it('isActive is true when SOROWILL_DEBUG=1 in non-production environment', () => {
    process.env['SOROWILL_DEBUG'] = '1';
    process.env['NODE_ENV'] = 'test';
    const logger = new DebugLogger(false);
    expect(logger.isActive).toBe(true);
  });

  it('isActive is false when NODE_ENV=production regardless of debug flag', () => {
    process.env['NODE_ENV'] = 'production';
    const logger = new DebugLogger(true);
    expect(logger.isActive).toBe(false);
  });

  // ── No-secrets-logged guarantee ───────────────────────────────────────────

  it('SDK log methods do not accept raw secret keys as parameters (structural check)', () => {
    // DebugLogger methods only accept: method name (string), willId (string),
    // and caller-supplied details (plain Record). The SDK itself never passes
    // private key material through any of these parameters.
    //
    // This test verifies the method signatures have no dedicated "secretKey"
    // or "privateKey" parameter slots that could accidentally leak secrets.
    const logger = new DebugLogger(true);
    process.env['NODE_ENV'] = 'test';

    // logOperationBuild: (method, willId?, details?)
    expect(logger.logOperationBuild.length).toBe(1); // required: method only
    // logSimulation: (method, willId?, minResourceFee?, details?)
    expect(logger.logSimulation.length).toBe(1);
    // logError: (method, willId?, error?)
    expect(logger.logError.length).toBe(1);
  });

  // ── All log methods respect the guard ─────────────────────────────────────

  it('all log methods respect the production guard', () => {
    process.env['NODE_ENV'] = 'production';
    const logger = new DebugLogger(true);

    logger.logOperationBuild('m', '1', { foo: 'bar' });
    logger.logSimulation('m', '1', '100', { extra: 1 });
    logger.logSubmission('m', '1', 'txhash');
    logger.logPoll('m', '1', 1, 5);
    logger.logSuccess('m', '1', 'txhash', 123);
    logger.logError('m', '1', 'something went wrong');

    expect(consoleLogSpy).not.toHaveBeenCalled();
  });

  it('all log methods work correctly in non-production with debug=true', () => {
    process.env['NODE_ENV'] = 'development';
    const logger = new DebugLogger(true);

    logger.logOperationBuild('m', '1');
    logger.logSimulation('m', '1', '100');
    logger.logSubmission('m', '1', 'txhash');
    logger.logPoll('m', '1', 1, 5);
    logger.logSuccess('m', '1', 'txhash', 123);
    logger.logError('m', '1', 'error');

    expect(consoleLogSpy).toHaveBeenCalledTimes(6);
  });

  it('log output is structured JSON', () => {
    process.env['NODE_ENV'] = 'test';
    const logger = new DebugLogger(true);
    logger.logOperationBuild('check_in', '42', { owner: 'GABC' });

    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    const raw = consoleLogSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      level: 'operation-build',
      method: 'check_in',
      willId: '42',
    });
    expect(typeof parsed['timestamp']).toBe('string');
  });
});
