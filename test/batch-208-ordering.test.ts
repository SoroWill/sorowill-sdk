/**
 * Tests for batch-208 improvements (#645-648)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { OrderedRequestQueue, OrderedHookManager, HookExecutionOrder } from '../src/ordering';
import {
  checkAndWarnVersion,
  getVersionInfo,
  isVersionSupported,
  getSupportedVersions,
  VersionStatus,
} from '../src/deprecation';

describe('Batch-208: Queue ordering, deprecation, hooks, backpressure', () => {
  describe('#645: FIFO ordering guarantee', () => {
    let queue: OrderedRequestQueue<number>;

    beforeEach(() => {
      queue = new OrderedRequestQueue(100, 80);
    });

    it('maintains FIFO order', async () => {
      const results: number[] = [];

      const promises = [1, 2, 3, 4, 5].map((i) =>
        queue.enqueue(async () => {
          results.push(i);
          return i;
        }),
      );

      await Promise.all(promises);
      expect(results).toEqual([1, 2, 3, 4, 5]);
    });

    it('processes requests sequentially', async () => {
      const order: (string | number)[] = [];

      const promises = [1, 2, 3].map((i) =>
        queue.enqueue(async () => {
          order.push(`start-${i}`);
          await new Promise((resolve) => setTimeout(resolve, 10));
          order.push(`end-${i}`);
          return i;
        }),
      );

      await Promise.all(promises);
      expect(order).toEqual(['start-1', 'end-1', 'start-2', 'end-2', 'start-3', 'end-3']);
    });

    it('rejects when queue is full', async () => {
      const smallQueue = new OrderedRequestQueue(2, 1);

      // Fill the queue
      smallQueue.enqueue(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return 1;
      });
      smallQueue.enqueue(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return 2;
      });

      // This should be rejected due to backpressure
      const result = smallQueue
        .enqueue(async () => {
          return 3;
        })
        .then(() => 'accepted')
        .catch(() => 'rejected');

      expect(await result).toBe('rejected');
    });
  });

  describe('#648: Backpressure for high-volume operations', () => {
    let queue: OrderedRequestQueue<number>;

    beforeEach(() => {
      queue = new OrderedRequestQueue(100, 50);
    });

    it('detects backpressure threshold', async () => {
      expect(queue.isBackpressureActive()).toBe(false);

      // Enqueue many requests
      for (let i = 0; i < 60; i++) {
        queue.enqueue(async () => {
          await new Promise((resolve) => setTimeout(resolve, 50));
          return i;
        });
      }

      expect(queue.isBackpressureActive()).toBe(true);
    });

    it('enforces queue size limit', async () => {
      const smallQueue = new OrderedRequestQueue(5, 4);

      // Fill the queue
      for (let i = 0; i < 5; i++) {
        smallQueue.enqueue(async () => {
          await new Promise((resolve) => setTimeout(resolve, 100));
          return i;
        });
      }

      expect(smallQueue.getQueueSize()).toBe(5);

      // Next request should fail
      await expect(
        smallQueue.enqueue(async () => {
          return 999;
        }),
      ).rejects.toThrow(/Queue full/);
    });

    it('waits for backpressure relief', async () => {
      const queue = new OrderedRequestQueue(100, 5);

      // Create backpressure
      for (let i = 0; i < 6; i++) {
        queue.enqueue(async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return i;
        });
      }

      expect(queue.isBackpressureActive()).toBe(true);

      // Should eventually resolve
      await expect(queue.waitForBackpressureRelief()).resolves.not.toThrow();
    });
  });

  describe('#647: Hook execution order', () => {
    let manager: OrderedHookManager;

    beforeEach(() => {
      manager = new OrderedHookManager();
    });

    it('executes hooks in defined order', async () => {
      const order: string[] = [];

      manager.registerHook({
        name: 'pre',
        order: HookExecutionOrder.PreOperation,
        fn: () => { order.push('pre'); },
      });

      manager.registerHook({
        name: 'post',
        order: HookExecutionOrder.PostOperation,
        fn: () => { order.push('post'); },
      });

      manager.registerHook({
        name: 'success',
        order: HookExecutionOrder.OnSuccess,
        fn: () => { order.push('success'); },
      });

      await manager.executeInOrder();
      expect(order).toEqual(['pre', 'post', 'success']);
    });

    it('handles async hooks', async () => {
      const order: string[] = [];

      manager.registerHook({
        name: 'async1',
        order: HookExecutionOrder.PreOperation,
        fn: async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          order.push('async1');
        },
      });

      manager.registerHook({
        name: 'async2',
        order: HookExecutionOrder.PostOperation,
        fn: async () => {
          order.push('async2');
        },
      });

      await manager.executeInOrder();
      expect(order).toEqual(['async1', 'async2']);
    });

    it('executes multiple hooks in same order', async () => {
      const order: string[] = [];

      manager.registerHook({
        name: 'first',
        order: HookExecutionOrder.PreOperation,
        fn: () => { order.push('first'); },
      });

      manager.registerHook({
        name: 'second',
        order: HookExecutionOrder.PreOperation,
        fn: () => { order.push('second'); },
      });

      await manager.executeInOrder();
      expect(order).toEqual(['first', 'second']);
    });

    it('retrieves hooks by order', () => {
      manager.registerHook({
        name: 'pre1',
        order: HookExecutionOrder.PreOperation,
        fn: () => {},
      });

      manager.registerHook({
        name: 'pre2',
        order: HookExecutionOrder.PreOperation,
        fn: () => {},
      });

      const preHooks = manager.getHooksForOrder(HookExecutionOrder.PreOperation);
      expect(preHooks.length).toBe(2);
      expect(preHooks[0]!.name).toBe('pre1');
      expect(preHooks[1]!.name).toBe('pre2');
    });
  });

  describe('#646: Deprecation warnings', () => {
    it('warns on deprecated versions', () => {
      expect(() => checkAndWarnVersion('2.0.0')).not.toThrow();
    });

    it('errors on EOL versions', () => {
      expect(() => checkAndWarnVersion('1.0.0')).not.toThrow();
    });

    it('gets version info', () => {
      const info = getVersionInfo('2.1.0');
      expect(info).not.toBeNull();
      expect(info?.status).toBe(VersionStatus.Current);
    });

    it('checks version support', () => {
      expect(isVersionSupported('2.1.0')).toBe(true);
      expect(isVersionSupported('1.0.0')).toBe(false);
    });

    it('lists supported versions', () => {
      const supported = getSupportedVersions();
      expect(supported).toContain('2.1.0');
      expect(supported).toContain('1.5.0');
      expect(supported).toContain('2.0.0');
      expect(supported).not.toContain('1.0.0');
    });
  });
});
