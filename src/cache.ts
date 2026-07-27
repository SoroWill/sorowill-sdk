export interface ReadCacheOptions {
  /** Time-to-live for cache entries in milliseconds. Must be a positive number. */
  ttlMs: number;
  /** Optional override for the current time (useful for testing). */
  now?: () => number;
}

interface CacheEntry<T> {
  expiresAt: number;
  value: T;
}

/** Simple in-memory TTL cache for read-only contract call results. */
export class ReadCache {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, CacheEntry<unknown>>();

  constructor(options: ReadCacheOptions) {
    if (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0) {
      throw new Error('Read cache ttlMs must be a positive number');
    }

    this.ttlMs = options.ttlMs;
    this.now = options.now ?? Date.now;
  }

  /** Returns the cached value if it exists and hasn't expired. */
  get<T>(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }

    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }

    return entry.value as T;
  }

  /** Stores a value in the cache with the configured TTL. */
  set<T>(key: string, value: T): void {
    this.entries.set(key, {
      value,
      expiresAt: this.now() + this.ttlMs,
    });
  }

  /** Removes all entries from the cache. */
  clear(): void {
    this.entries.clear();
  }

  /** Invalidates any cache entries associated with a specific will ID. */
  invalidateByWillId(_willId: string): void {
    // Simple TTL cache doesn't track will IDs — entries expire naturally.
    // Subclasses or future versions may add will-ID-aware eviction.
  }
}
