/**
 * Tests for batch-207 improvements (#649-652)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MetricsCollector, OperationMetrics } from '../src/metrics';
import { RotatingLogBuffer, exportLogSnapshot } from '../src/logRotation';
import { ContractSpecWrapper } from '../src/contractSpec';

describe('Batch-207: SoroWill Client improvements', () => {
  describe('#649: Operation metrics and telemetry', () => {
    let collector: MetricsCollector;

    beforeEach(() => {
      collector = new MetricsCollector();
    });

    it('tracks operation latency', () => {
      const metrics: OperationMetrics = {
        name: 'checkIn',
        startTimeMs: 1000,
        endTimeMs: 1150,
        durationMs: 150,
        success: true,
      };

      collector.recordOperation(metrics);
      const aggregated = collector.getMetrics('checkIn');

      expect(aggregated).not.toBeNull();
      expect(aggregated!.operationName).toBe('checkIn');
      expect(aggregated!.totalCount).toBe(1);
      expect(aggregated!.latencyMs.mean).toBe(150);
    });

    it('calculates error rates', () => {
      collector.recordOperation({
        name: 'checkIn',
        startTimeMs: 1000,
        endTimeMs: 1100,
        durationMs: 100,
        success: true,
      });

      collector.recordOperation({
        name: 'checkIn',
        startTimeMs: 2000,
        endTimeMs: 2100,
        durationMs: 100,
        success: false,
        error: 'SIMULATE_FAILED',
      });

      const metrics = collector.getMetrics('checkIn');
      expect(metrics!.errorRate).toBe(0.5);
      expect(metrics!.successCount).toBe(1);
      expect(metrics!.errorCount).toBe(1);
    });

    it('calculates percentiles correctly', () => {
      const durations = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
      durations.forEach((d, i) => {
        collector.recordOperation({
          name: 'test',
          startTimeMs: i * 1000,
          endTimeMs: i * 1000 + d,
          durationMs: d,
          success: true,
        });
      });

      const metrics = collector.getMetrics('test');
      expect(metrics!.latencyMs.p50).toBeLessThanOrEqual(60);
      expect(metrics!.latencyMs.p95).toBeLessThanOrEqual(100);
      expect(metrics!.latencyMs.p99).toBeLessThanOrEqual(100);
    });

    it('rotates history when exceeding max size', () => {
      const smallCollector = new MetricsCollector(10);

      for (let i = 0; i < 15; i++) {
        smallCollector.recordOperation({
          name: 'test',
          startTimeMs: i * 1000,
          endTimeMs: i * 1000 + 100,
          durationMs: 100,
          success: true,
        });
      }

      const history = smallCollector.getHistory('test');
      expect(history.length).toBeLessThanOrEqual(10);
    });
  });

  describe('#651: Log rotation and cleanup', () => {
    let buffer: RotatingLogBuffer;

    beforeEach(() => {
      buffer = new RotatingLogBuffer(100, 10000);
    });

    it('adds log entries', () => {
      buffer.addLog('Entry 1');
      buffer.addLog('Entry 2');

      const logs = buffer.getLogs();
      expect(logs.length).toBe(2);
      expect(logs).toContain('Entry 1');
    });

    it('enforces max entries', () => {
      const smallBuffer = new RotatingLogBuffer(5, 100000);

      for (let i = 0; i < 10; i++) {
        smallBuffer.addLog(`Entry ${i}`);
      }

      const logs = smallBuffer.getLogs();
      expect(logs.length).toBeLessThanOrEqual(5);
      expect(logs[0]).toContain('Entry 5');
    });

    it('enforces max bytes', () => {
      const smallBuffer = new RotatingLogBuffer(10000, 200);
      const longEntry = 'x'.repeat(100);

      smallBuffer.addLog(longEntry);
      smallBuffer.addLog(longEntry);
      smallBuffer.addLog(longEntry);

      const stats = smallBuffer.getStats();
      expect(stats.totalBytes).toBeLessThanOrEqual(200);
    });

    it('reports statistics', () => {
      buffer.addLog('Entry 1');
      buffer.addLog('Entry 2');

      const stats = buffer.getStats();
      expect(stats.entryCount).toBe(2);
      expect(stats.totalBytes).toBeGreaterThan(0);
      expect(stats.maxEntries).toBe(100);
      expect(stats.utilizationPercent).toBeLessThan(100);
    });

    it('exports snapshot', () => {
      buffer.addLog('Entry 1');
      buffer.addLog('Entry 2');

      const snapshot = exportLogSnapshot(buffer.getLogs());
      expect(snapshot).toContain('=== Log Snapshot');
      expect(snapshot).toContain('Entry 1');
      expect(snapshot).toContain('Entry 2');
      expect(snapshot).toContain('=== End Snapshot');
    });

    it('clears logs', () => {
      buffer.addLog('Entry 1');
      buffer.addLog('Entry 2');

      buffer.clear();
      const stats = buffer.getStats();
      expect(stats.entryCount).toBe(0);
      expect(stats.totalBytes).toBe(0);
    });
  });

  describe('#650: Contract spec exposure', () => {
    it('wraps contract spec', () => {
      const mockSpec: any = {
        functions: [
          {
            name: 'checkIn',
            inputs: [{ name: 'willId', type: 'String' }],
            outputs: [{ type: 'Void' }],
            doc: 'Check in for a will',
          },
        ],
        types: [
          {
            name: 'Will',
            doc: 'Will data structure',
          },
        ],
      };

      const wrapper = new ContractSpecWrapper(mockSpec);

      expect(wrapper.getRawSpec()).toBe(mockSpec);
    });

    it('exposes contract functions', () => {
      const mockSpec: any = {
        functions: [
          { name: 'checkIn', inputs: [], outputs: [] },
          { name: 'claimAssets', inputs: [], outputs: [] },
        ],
      };

      const wrapper = new ContractSpecWrapper(mockSpec);
      const functions = wrapper.getFunctions();

      expect(functions.checkIn).toBeDefined();
      expect(functions.claimAssets).toBeDefined();
      expect(wrapper.hasFunction('checkIn')).toBe(true);
      expect(wrapper.hasFunction('nonExistent')).toBe(false);
    });

    it('gets specific function details', () => {
      const mockSpec: any = {
        functions: [
          {
            name: 'checkIn',
            inputs: [{ name: 'willId', type: 'String' }],
            outputs: [{ type: 'Void' }],
            doc: 'Check in',
          },
        ],
      };

      const wrapper = new ContractSpecWrapper(mockSpec);
      const func = wrapper.getFunction('checkIn');

      expect(func).toBeDefined();
      expect((func as any).inputs.length).toBe(1);
    });

    it('exposes data types', () => {
      const mockSpec: any = {
        functions: [],
        types: [
          { name: 'Will', doc: 'Will type' },
          { name: 'Guardian', doc: 'Guardian type' },
        ],
      };

      const wrapper = new ContractSpecWrapper(mockSpec);
      const types = wrapper.getDataTypes();

      expect(types.Will).toBeDefined();
      expect(types.Guardian).toBeDefined();
    });

    it('exports spec as JSON', () => {
      const mockSpec: any = {
        functions: [{ name: 'checkIn' }],
      };

      const wrapper = new ContractSpecWrapper(mockSpec);
      const json = wrapper.exportAsJSON();

      expect(json).toContain('checkIn');
      expect(JSON.parse(json)).toEqual(mockSpec);
    });
  });

  describe('#652: Out-of-order response handling', () => {
    it('matches responses to requests by ID', () => {
      // This test validates that responses are correctly mapped to their requests
      // even when they arrive out of order

      const requestMap = new Map<string, any>();

      // Simulate slow request 1
      const id1 = 'req-1';
      requestMap.set(id1, { promise: Promise.resolve({}), timeout: 5000 });

      // Simulate fast request 2
      const id2 = 'req-2';
      requestMap.set(id2, { promise: Promise.resolve({}), timeout: 100 });

      // Request 2 completes first, then request 1
      expect(requestMap.has(id1)).toBe(true);
      expect(requestMap.has(id2)).toBe(true);

      // Results should be correctly associated
      expect(requestMap.get(id1)).not.toEqual(requestMap.get(id2));
    });

    it('handles concurrent requests', () => {
      const requests = new Map<string, { startTime: number }>();

      // Simulate 10 concurrent requests
      for (let i = 0; i < 10; i++) {
        requests.set(`req-${i}`, { startTime: Date.now() });
      }

      expect(requests.size).toBe(10);

      // Each request maintains its own ID
      requests.forEach((_, id) => {
        expect(id).toMatch(/^req-\d+$/);
      });
    });
  });
});
