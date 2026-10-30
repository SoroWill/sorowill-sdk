/**
 * FIFO ordering guarantee and backpressure for RequestQueue (#645, #648)
 */

/**
 * FIFO queue with ordering guarantee and backpressure
 */
export class OrderedRequestQueue<T> {
  private queue: Array<{ id: string; fn: () => Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void }> = [];
  private inflight = 0;
  private maxQueueSize: number;
  private backpressureThreshold: number;

  constructor(maxQueueSize: number = 1000, backpressureThreshold: number = 800) {
    this.maxQueueSize = maxQueueSize;
    this.backpressureThreshold = backpressureThreshold;
  }

  /**
   * Enqueue a request (FIFO order maintained)
   * Rejects with error if queue is full (backpressure)
   */
  async enqueue(fn: () => Promise<T>): Promise<T> {
    const pending = this.queue.length + this.inflight;
    if (pending >= this.maxQueueSize) {
      throw new Error(`Queue full: ${pending}/${this.maxQueueSize}. Apply backpressure.`);
    }

    return new Promise<T>((resolve, reject) => {
      const id = `req-${Date.now()}-${Math.random()}`;
      this.queue.push({ id, fn, resolve, reject });
      void this.processQueue();
    });
  }

  /**
   * Check if backpressure should be applied
   */
  isBackpressureActive(): boolean {
    const pending = this.queue.length + this.inflight;
    return pending >= this.backpressureThreshold;
  }

  /**
   * Get current queue size
   */
  getQueueSize(): number {
    return this.queue.length + this.inflight;
  }

  /**
   * Wait until queue drains below threshold
   */
  async waitForBackpressureRelief(): Promise<void> {
    while (this.isBackpressureActive()) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /**
   * Process queue in FIFO order
   */
  private async processQueue(): Promise<void> {
    if (this.inflight > 0 || this.queue.length === 0) {
      return;
    }

    while (this.queue.length > 0) {
      const { fn, resolve, reject } = this.queue.shift()!;
      this.inflight++;
      try {
        const result = await fn();
        resolve(result);
      } catch (err) {
        reject(err);
      } finally {
        this.inflight--;
      }
    }
  }
}

/**
 * Hook execution order enforcement (#647)
 */
export enum HookExecutionOrder {
  PreOperation = 0,
  PostOperation = 1,
  OnSuccess = 2,
  OnError = 3,
  Cleanup = 4,
}

/**
 * Hook with defined execution order
 */
export interface OrderedHook {
  name: string;
  order: HookExecutionOrder;
  fn: () => Promise<void> | void;
}

/**
 * Hook manager enforcing execution order
 */
export class OrderedHookManager {
  private hooks: Map<HookExecutionOrder, OrderedHook[]> = new Map();

  constructor() {
    for (const order of Object.values(HookExecutionOrder).filter((v) => typeof v === 'number')) {
      this.hooks.set(order as HookExecutionOrder, []);
    }
  }

  /**
   * Register a hook with specific execution order
   */
  registerHook(hook: OrderedHook): void {
    const hooks = this.hooks.get(hook.order) || [];
    hooks.push(hook);
    this.hooks.set(hook.order, hooks);
  }

  /**
   * Execute all hooks in order
   */
  async executeInOrder(): Promise<void> {
    const orders = Array.from(this.hooks.keys()).sort((a, b) => a - b);

    for (const order of orders) {
      const hooksAtOrder = this.hooks.get(order) || [];
      for (const hook of hooksAtOrder) {
        await Promise.resolve(hook.fn());
      }
    }
  }

  /**
   * Get hooks for a specific order
   */
  getHooksForOrder(order: HookExecutionOrder): OrderedHook[] {
    return [...(this.hooks.get(order) || [])];
  }
}
