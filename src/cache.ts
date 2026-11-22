export interface PersistedCacheEntry {
  key: string;
  value: string;
  expiresAt: number | null;
  willIds: string[];
}

export interface CachePersistenceAdapter {
  readAll(): Promise<PersistedCacheEntry[]>;
  write(entry: PersistedCacheEntry): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
}

/**
 * Raised when cache deserialization encounters an invalid __type tag
 * or malformed tagged value.
 */
export class CacheDeserializationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CacheDeserializationError';
  }
}

/** Default maximum number of entries to cache before LRU eviction kicks in. */
export const DEFAULT_MAX_CACHE_ENTRIES = 1000;

// Share the lock across caches using the same adapter. Serialize all mutations,
// since adapters may store every key in one read-modify-write document.
const persistenceLocks = new WeakMap<CachePersistenceAdapter, Promise<void>>();

function withPersistenceLock(
  adapter: CachePersistenceAdapter,
  operation: () => Promise<void>,
): Promise<void> {
  const previous = persistenceLocks.get(adapter) ?? Promise.resolve();
  const result = previous.then(operation);
  // A failed mutation must release the lock so later writes can still proceed.
  const tail = result.catch(() => {});
  persistenceLocks.set(adapter, tail);
  void tail.then(() => {
    if (persistenceLocks.get(adapter) === tail) persistenceLocks.delete(adapter);
  });
  return result;
}

export interface CacheGetResult<T> {
  value: T;
  stale: boolean;
  indicator?: 'offline';
}

export interface ReadCacheOptions {
  ttlMs?: number;
  now?: () => number;
  /**
   * Optional network connectivity check. Defaults to `navigator.onLine` when
   * available in browser environments, or `true` otherwise.
   */
  isOnline?: () => boolean;
  persistence?: CachePersistenceAdapter;
  /**
   * Maximum number of entries to keep in the cache. When the number of entries
   * exceeds this limit, expired entries are pruned first and then the
   * least-recently-used entries are evicted (and removed from persistence).
   * Defaults to {@link DEFAULT_MAX_CACHE_ENTRIES}. Pass `Infinity` to opt into
   * an unbounded cache.
   */
  maxEntries?: number;
  /**
   * Callback invoked when a persistence adapter operation (write, delete, or
   * clear) fails. Receives the affected key and the error. The cache continues
   * to function in-memory; only durability is affected.
   */
  onPersistenceFailure?: (key: string, error: unknown) => void;
  /**
   * When `true`, a persistence write failure in `set()` rolls back the
   * in-memory cache entry (removes it) so memory and persistence stay in sync.
   * Defaults to `false` (the in-memory entry is kept even if persistence
   * fails). When `false`, only the `onPersistenceFailure` callback is invoked.
   */
  rollbackOnPersistenceFailure?: boolean;
}

/** Performance metrics returned by {@link ReadCache.getCacheStats}. */
export interface CacheStats {
  hits: number;
  misses: number;
  /** Percentage (0–100) of lookups served from the cache. */
  hitRate: number;
  evictions: number;
  size: number;
  /** Estimated in-memory footprint in bytes. */
  memoryUsageBytes: number;
}

interface CacheEntry {
  key: string;
  value: unknown;
  expiresAt: number | null;
  willIds: Set<string>;
}

/**
 * Returns `true` once `now` has reached `expiresAt` (the boundary itself
 * counts as expired). A non-finite numeric `expiresAt` — e.g. a corrupted
 * persisted entry — is treated as expired rather than as fresh forever.
 */
function isExpired(expiresAt: unknown, now: number): boolean {
  if (expiresAt === null) {
    return false;
  }
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
    return true;
  }
  return expiresAt <= now;
}

function serializeCacheValue(value: unknown): string {
  return JSON.stringify(value, function (key, currentValue) {
    // `Date` defines `toJSON`, so by the time a replacer sees it, it has
    // already been converted to an ISO string. Read the pre-toJSON value off
    // the holder (`this`) to tell a real Date apart from a plain ISO string.
    const original = (this as Record<string, unknown>)[key];
    if (original instanceof Date) {
      return { __type: 'date', value: original.toISOString() };
    }
    if (typeof currentValue === 'bigint') {
      return { __type: 'bigint', value: currentValue.toString() };
    }
    return currentValue;
  });
}

export function deserializeCacheValue<T>(value: string): T {
  return JSON.parse(value, (_key, currentValue) => {
    if (
      currentValue &&
      typeof currentValue === 'object' &&
      '__type' in currentValue &&
      'value' in currentValue
    ) {
      const type = currentValue.__type;
      if (typeof type !== 'string') {
        throw new CacheDeserializationError(
          `Invalid __type: expected string, got ${typeof type}`,
        );
      }
      if (type === 'bigint') {
        if (typeof currentValue.value !== 'string') {
          throw new CacheDeserializationError(
            `Invalid bigint value: expected string, got ${typeof currentValue.value}`,
          );
        }
        try {
          return BigInt(currentValue.value);
        } catch {
          throw new CacheDeserializationError(
            `Invalid bigint value: "${currentValue.value}"`,
          );
        }
      }
      if (type === 'date') {
        if (typeof currentValue.value !== 'string') {
          throw new CacheDeserializationError(
            `Invalid date value: expected string, got ${typeof currentValue.value}`,
          );
        }
        const date = new Date(currentValue.value);
        if (isNaN(date.getTime())) {
          throw new CacheDeserializationError(
            `Invalid date value: "${currentValue.value}"`,
          );
        }
        return date;
      }
      throw new CacheDeserializationError(`Unknown __type: "${type}"`);
    }
    return currentValue;
  }) as T;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, currentValue) => {
    if (typeof currentValue === 'bigint') {
      return { __type: 'bigint', value: currentValue.toString() };
    }

    if (Array.isArray(currentValue)) {
      return currentValue;
    }

    if (currentValue && typeof currentValue === 'object') {
      const sortedEntries = Object.entries(currentValue as Record<string, unknown>).sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      );
      return Object.fromEntries(sortedEntries);
    }

    return currentValue;
  });
}

/**
 * Escapes special characters (such as colons, slashes, percent signs, and separators)
 * in a cache key component to prevent cache key collisions when component IDs contain
 * separators.
 *
 * @param component - The raw string component (e.g. method name or identifier)
 * @returns The escaped component safe for use in cache keys
 */
export function escapeKeyComponent(component: string): string {
  return encodeURIComponent(component);
}

/**
 * Alias for {@link escapeKeyComponent}.
 */
export const escapeCacheKeyComponent = escapeKeyComponent;

/**
 * Builds a locale-agnostic cache key for a read method.
 *
 * Cache key design:
 * - Keys are derived from the escaped method name and its stably serialized arguments.
 * - Special characters in component IDs (such as colons and separators) are escaped
 *   via {@link escapeKeyComponent} to prevent cache key collisions.
 * - Locale-dependent inputs (e.g. `locale`, `language`, `i18n`) are stripped
 *   before serialization so the same underlying data maps to a single key
 *   regardless of the active language.
 * - Locale-dependent formatting (currency, number, date formatting) MUST be
 *   applied AFTER retrieving the cached value, never before caching it.
 *
 * This guarantees that switching languages mid-app does not return stale data
 * formatted for the previous locale and eliminates collision vulnerabilities.
 */
export function createReadCacheKey(method: string, args: Record<string, unknown>): string {
  function encodeValue(val: unknown): unknown {
    if (typeof val === 'string') {
      return encodeURIComponent(val);
    } else if (Array.isArray(val)) {
      return val.map(encodeValue);
    } else if (val !== null && typeof val === 'object') {
      const encoded: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(val)) {
        encoded[k] = encodeValue(v);
      }
      return encoded;
    }
    return val;
  }

  const argsStr = stableStringify(args);
  const argsObj = JSON.parse(argsStr);
  const encodedMethod = encodeURIComponent(method);
  const encodedArgs = encodeValue(argsObj);
  return JSON.stringify([encodedMethod, encodedArgs]);
}

/**
 * A memory-backed read cache with optional persistent storage.
 *
 * IMPORTANT: If a persistence adapter is configured, hydration (loading stored
 * entries) happens asynchronously in the constructor. Callers must await
 * `cache.ready()` before calling `cache.get()` to ensure all persisted entries
 * are available. Calling `get()` before `ready()` completes will incorrectly
 * return a cache miss for data that is being loaded.
 *
 * Without persistence, the cache is immediately ready and can be used after
 * construction.
 *
 * LOCALE AWARENESS: Cache keys include the locale, but a locale change must not
 * return results cached under the previous locale. When the active locale
 * changes (via the constructor option or `setLocale()`), all entries belonging
 * to the previous locale are invalidated so stale translations are never
 * served.
 */
export class ReadCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly isOnlineFn: (() => boolean) | undefined;
  private offlineSince: number | null = null;
  private readonly onOnlineHandler: (() => void) | undefined;
  private readonly onOfflineHandler: (() => void) | undefined;
  private readonly persistence: CachePersistenceAdapter | undefined;
  private readonly maxEntries: number;
  private readonly onPersistenceFailure: ((key: string, error: unknown) => void) | undefined;
  private readonly rollbackOnPersistenceFailure: boolean;
  private readonly readyPromise: Promise<void>;
  /**
   * Will-ID to cache-key index. Maps each will ID to the set of cache keys
   * whose entries reference that will ID, so reads and invalidations address
   * the same entries and eviction can clean up associated references
   * instead of leaking them.
   */
  private readonly willIdToKeys = new Map<string, Set<string>>();
  /**
   * Keys written or deleted after construction but before hydration completes.
   * Hydration must not overwrite these with older persisted values.
   */
  private readonly touchedKeys = new Set<string>();
  /**
   * Set when clear() is called before hydration completes. Hydration must not
   * repopulate the cache once it resolves.
   */
  private clearedBeforeHydration = false;
  /**
   * Network passphrase the cached entries belong to. Entries read on one
   * network are meaningless on another, so switching networks clears the
   * cache (see {@link ReadCache.setNetwork}).
   */
  private networkPassphrase: string | undefined;
  /** Lookup counters backing {@link ReadCache.getCacheStats}. */
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  constructor(options: ReadCacheOptions = {}) {
    const ttlMs = options.ttlMs ?? 60_000;
    if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs)) {
      throw new Error(
        `ReadCache: ttlMs must be a finite number, received ${String(ttlMs)}`,
      );
    }
    if (ttlMs < 0) {
      console.warn(
        `[SoroWill] Cache: negative ttlMs ${ttlMs}ms is not allowed; treating as 0 (immediate expiration).`,
      );
    }
    this.ttlMs = Math.max(0, ttlMs);

    // Validate and set maxEntries
    if (options.maxEntries !== undefined) {
      const isInfinity = options.maxEntries === Infinity;
      const isValidInteger = Number.isInteger(options.maxEntries) && options.maxEntries >= 1;
      if (typeof options.maxEntries !== 'number' || (!isInfinity && !isValidInteger)) {
        throw new RangeError(
          `maxEntries must be a positive integer or Infinity, received ${options.maxEntries}`,
        );
      }
    }

    this.now = options.now ?? Date.now;
    this.isOnlineFn = options.isOnline;
    this.persistence = options.persistence;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_CACHE_ENTRIES;
    this.onPersistenceFailure = options.onPersistenceFailure;
    this.rollbackOnPersistenceFailure = options.rollbackOnPersistenceFailure ?? false;

    if (!this.checkOnline()) {
      this.offlineSince = this.now();
    }

    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      this.onOfflineHandler = () => {
        if (this.offlineSince === null) {
          this.offlineSince = this.now();
        }
      };
      this.onOnlineHandler = () => {
        this.restoreOnlineTtl();
      };
      window.addEventListener('offline', this.onOfflineHandler);
      window.addEventListener('online', this.onOnlineHandler);
    }

    this.readyPromise = this.hydrate();
  }

  /** Removes browser online/offline event listeners registered by this cache. */
  destroy(): void {
    if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      if (this.onOfflineHandler) {
        window.removeEventListener('offline', this.onOfflineHandler);
      }
      if (this.onOnlineHandler) {
        window.removeEventListener('online', this.onOnlineHandler);
      }
    }
  }

  /** Whether the network is currently detected as offline. */
  get isOffline(): boolean {
    return !this.checkOnline();
  }

  private readOnlineState(): boolean {
    if (this.isOnlineFn) {
      return this.isOnlineFn();
    }
    if (typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean') {
      return navigator.onLine;
    }
    return true;
  }

  private restoreOnlineTtl(): void {
    if (this.offlineSince === null) {
      return;
    }
    const offlineDuration = Math.max(0, this.now() - this.offlineSince);
    this.offlineSince = null;
    if (offlineDuration > 0) {
      for (const entry of this.entries.values()) {
        if (entry.expiresAt !== null) {
          entry.expiresAt += offlineDuration;
        }
      }
    }
  }

  private checkOnline(): boolean {
    const online = this.readOnlineState();
    if (!online) {
      if (this.offlineSince === null) {
        this.offlineSince = this.now();
      }
      return false;
    }
    if (this.offlineSince !== null) {
      this.restoreOnlineTtl();
    }
    return true;
  }

  /** Number of entries currently held in memory (expired entries included until pruned). */
  get size(): number {
    return this.entries.size;
  }

  /** Configured maximum number of entries before LRU eviction kicks in. */
  get capacity(): number {
    return this.maxEntries;
  }

  async ready(): Promise<void> {
    await this.readyPromise;
  }

  /**
   * Synchronously retrieves a cached value by key.
   *
   * WARNING: If this cache was constructed with persistence enabled, you MUST
   * call and await `ready()` before calling this method. Calling `get()` before
   * `ready()` completes will return undefined for entries that are currently
   * being loaded from persistent storage.
   *
   * The entry's expiration is checked on every retrieval: an entry whose
   * `expiresAt` has been reached is never returned, and is invalidated both
   * in memory and in persistent storage so it can't be served again (#620).
   *
   * @param key - The cache key to look up
   * @returns The cached value if found and not expired, or undefined
   */
  /**
   * Retrieves a cached value along with staleness and offline status metadata.
   * When offline, expired entries are retained and returned with `stale: true`
   * and `indicator: 'offline'` instead of being evicted.
   */
  getWithStatus<T>(key: string): CacheGetResult<T> | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      this.misses += 1;
      return undefined;
    }

    const online = this.checkOnline();
    const expired = isExpired(entry.expiresAt, this.now());

    if (expired && online) {
      this.invalidateExpired(key);
      return undefined;
    }

    this.hits += 1;
    // Refresh recency for LRU ordering: re-inserting moves the key to the end.
    this.entries.delete(key);
    this.entries.set(key, entry);

    if (expired && !online) {
      return {
        value: entry.value as T,
        stale: true,
        indicator: 'offline',
      };
    }

    return {
      value: entry.value as T,
      stale: false,
      ...(online ? {} : { indicator: 'offline' as const }),
    };
  }

  get<T>(key: string): T | undefined {
    return this.getWithStatus<T>(key)?.value;
  }

  /**
   * Returns a snapshot of cache performance metrics for debugging.
   *
   * - `hits` / `misses`: counts of {@link ReadCache.get} lookups.
   * - `hitRate`: percentage of lookups served from the cache (0 when no
   *   lookups have happened yet).
   * - `evictions`: entries removed for being expired or over `maxEntries`.
   * - `size`: number of entries currently held in memory.
   * - `memoryUsageBytes`: estimated in-memory footprint of the cached keys
   *   and serialized values, assuming 2 bytes per UTF-16 code unit.
   */
  getCacheStats(): CacheStats {
    const lookups = this.hits + this.misses;
    let memoryUsageBytes = 0;
    for (const entry of this.entries.values()) {
      memoryUsageBytes += (entry.key.length + serializeCacheValue(entry.value).length) * 2;
    }
    return {
      hits: this.hits,
      misses: this.misses,
      hitRate: lookups === 0 ? 0 : (this.hits / lookups) * 100,
      evictions: this.evictions,
      size: this.entries.size,
      memoryUsageBytes,
    };
  }

  set(key: string, value: unknown, willIds: Iterable<string> = []): void {
    if (this.ttlMs === 0) {
      this.touchedKeys.add(key);
      if (this.persistence) {
        void withPersistenceLock(this.persistence, async () => {
          await this.persistence!.delete(key).catch((err) =>
            this.onPersistenceFailure?.(key, err),
          );
        });
      }
      return;
    }

    // Serialize immediately to snapshot the object state, then deserialize
    // back to store a frozen copy. This prevents mutations after set() from
    // affecting the cached value.
    const serialized = serializeCacheValue(value);
    const entry: CacheEntry = {
      key,
      value: deserializeCacheValue(serialized),
      expiresAt: this.now() + this.ttlMs,
      willIds: new Set(willIds),
    };

    this.touchedKeys.add(key);
    // Clean up any stale willId -> key mappings if this key is being overwritten.
    const previousEntry = this.entries.get(key);
    if (previousEntry) {
      for (const oldWillId of previousEntry.willIds) {
        if (!entry.willIds.has(oldWillId)) {
          const oldKeys = this.willIdToKeys.get(oldWillId);
          oldKeys?.delete(key);
          if (oldKeys?.size === 0) {
            this.willIdToKeys.delete(oldWillId);
          }
        }
      }
    }
    // Index the key under each will ID so invalidation by will ID can find it.
    for (const willId of entry.willIds) {
      let keys = this.willIdToKeys.get(willId);
      if (!keys) {
        keys = new Set();
        this.willIdToKeys.set(willId, keys);
      }
      keys.add(key);
    }
    // Delete before set so an updated key moves to the most-recent position.
    this.entries.delete(key);
    this.entries.set(key, entry);
    if (this.persistence) {
      const persistedEntry: PersistedCacheEntry = {
        key: entry.key,
        value: serialized,
        expiresAt: entry.expiresAt,
        willIds: Array.from(entry.willIds),
      };
      void withPersistenceLock(this.persistence, async () => {
        try {
          await this.persistence!.write(persistedEntry);
        } catch (err) {
          // Report persistence failure via callback if provided
          this.onPersistenceFailure?.(key, err);
          // Optionally roll back the in-memory entry only if it hasn't been
          // superseded by a newer concurrent write.
          if (this.rollbackOnPersistenceFailure && this.entries.get(key) === entry) {
            this.entries.delete(key);
            this.touchedKeys.delete(key);
          }
        }
      });
    }

    this.evictIfNeeded();
  }

  /**
   * Removes a single entry from the cache (both in-memory and persisted).
   *
   * Useful when a caller knows the cached value is stale and wants to force a
   * subsequent `get()` to miss so the value is re-fetched from the source of
   * truth (e.g. the contract).
   *
   * @param key - The cache key to evict
   */
  async invalidate(key: string): Promise<void> {
    await this.readyPromise;
    await this.delete(key);
  }

  /** Removes every entry from memory and persistent storage. */
  async invalidateAll(): Promise<void> {
    await this.readyPromise;
    this.entries.clear();
    this.willIdToKeys.clear();
    try {
      await this.persist((adapter) => adapter.clear());
    } catch (err) {
      this.onPersistenceFailure?.('__clear__', err);
    }
  }

  async invalidateByWillId(willId: string): Promise<void> {
    await this.readyPromise;

    const keysToDelete: string[] = [];
    const keys = this.willIdToKeys.get(willId);
    if (keys) {
      keys.forEach((key) => keysToDelete.push(key));
    }

    await Promise.all(keysToDelete.map((key) => this.delete(key)));
  }

  /** Returns the network passphrase the cache is currently scoped to, if any. */
  getNetwork(): string | undefined {
    return this.networkPassphrase;
  }

  /**
   * Scopes the cache to `networkPassphrase`. If the cache was already scoped
   * to a different network (e.g. the wallet switched testnet ↔ mainnet), every
   * entry is cleared so data read on the previous network is never served.
   *
   * @returns `true` if the network changed and the cache was cleared.
   */
  setNetwork(networkPassphrase: string): boolean {
    const changed =
      this.networkPassphrase !== undefined && this.networkPassphrase !== networkPassphrase;
    this.networkPassphrase = networkPassphrase;
    if (changed) {
      this.clear();
    }
    return changed;
  }

  clear(): void {
    this.clearedBeforeHydration = true;
    this.entries.clear();
    this.willIdToKeys.clear();
    if (this.persistence) {
      void withPersistenceLock(this.persistence, async () => {
        await this.persistence!.clear().catch((err) =>
          this.onPersistenceFailure?.('__clear__', err),
        );
      });
    }
  }

  private evictIfNeeded(): void {
    // If max entries is infinite, don't evict
    if (!Number.isFinite(this.maxEntries) || this.entries.size <= this.maxEntries) {
      return;
    }

    // Drop expired entries first when online so live data is not evicted in their place.
    // While offline, expired entries are preserved so stale data remains available.
    const online = this.checkOnline();
    if (online) {
      const now = this.now();
      for (const [key, entry] of this.entries) {
        if (entry.expiresAt !== null && entry.expiresAt <= now) {
          this.entries.delete(key);
          this.touchedKeys.add(key);
          if (this.persistence) {
            void withPersistenceLock(this.persistence, async () => {
              await this.persistence!.delete(key).catch((err) =>
                this.onPersistenceFailure?.(key, err),
              );
            });
          }
        }
      }
    }

    // Map iteration order is insertion order, and get()/set() re-insert on
    // access, so the first key is always the least-recently-used one.
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }

      this.entries.delete(oldestKey);
      this.evictions += 1;
      this.touchedKeys.add(oldestKey);
      if (this.persistence) {
        void withPersistenceLock(this.persistence, async () => {
          await this.persistence!.delete(oldestKey).catch((err) =>
            this.onPersistenceFailure?.(oldestKey, err),
          );
        });
      }
    }
  }

  /** Drops an expired entry from memory and, best-effort, from persistence. */
  private invalidateExpired(key: string): void {
    this.touchedKeys.add(key);
    this.entries.delete(key);
    if (this.persistence) {
      void withPersistenceLock(this.persistence, async () => {
        await this.persistence!.delete(key).catch(() => {
          // Silently ignore persistence failures to prevent unhandled rejections
          // The entry is already gone in-memory and hydration skips expired entries
        });
      });
    }
  }

  private async delete(key: string): Promise<void> {
    this.touchedKeys.add(key);
    const entry = this.entries.get(key);
    if (entry) {
      for (const willId of entry.willIds) {
        const keys = this.willIdToKeys.get(willId);
        keys?.delete(key);
        if (keys?.size === 0) {
          this.willIdToKeys.delete(willId);
        }
      }
    }
    this.entries.delete(key);
    if (this.persistence) {
      await withPersistenceLock(this.persistence, async () => {
        try {
          await this.persistence!.delete(key);
        } catch (err) {
          this.onPersistenceFailure?.(key, err);
        }
      });
    }
  }

  private async hydrate(): Promise<void> {
    if (!this.persistence) {
      return;
    }

    const persistedEntries = await this.persistence.readAll();

    // If clear() was called while hydration was in flight, the cache must
    // remain empty once ready() resolves. Do not repopulate it.
    if (this.clearedBeforeHydration) {
      return;
    }

    const now = this.now();
    const online = this.checkOnline();
    // Entries written while hydration was in flight are more recent than
    // anything persisted, so they are moved behind the hydrated entries below
    // to keep LRU order correct.
    const writtenDuringHydration = Array.from(this.entries.values());

    for (const persistedEntry of persistedEntries) {
      // Check before expiry cleanup too: an old expired entry must not delete
      // a fresh write made while hydration was in flight.
      if (this.touchedKeys.has(persistedEntry.key)) {
        continue;
      }
      if (online && persistedEntry.expiresAt !== null && persistedEntry.expiresAt <= now) {
        await this.persist((adapter) => adapter.delete(persistedEntry.key));
        continue;
      }

      let deserializedValue: unknown;
      try {
        deserializedValue = deserializeCacheValue(persistedEntry.value);
      } catch (err) {
        console.warn(
          `[SoroWill] Cache: failed to deserialize entry "${persistedEntry.key}"`,
          err,
        );
        await this.persist((adapter) => adapter.delete(persistedEntry.key));
        continue;
      }

      const entry: CacheEntry = {
        key: persistedEntry.key,
        value: deserializedValue,
        expiresAt: persistedEntry.expiresAt,
        willIds: new Set(persistedEntry.willIds),
      };

      // Rebuild the will-ID index from persisted entries.
      for (const willId of entry.willIds) {
        let keys = this.willIdToKeys.get(willId);
        if (!keys) {
          keys = new Set();
          this.willIdToKeys.set(willId, keys);
        }
        keys.add(persistedEntry.key);
      }

      this.entries.set(persistedEntry.key, entry);
    }

    for (const entry of writtenDuringHydration) {
      // Skip entries replaced or removed while expired entries were deleted.
      if (this.entries.get(entry.key) !== entry) {
        continue;
      }
      this.entries.delete(entry.key);
      this.entries.set(entry.key, entry);
    }

    this.evictIfNeeded();
  }

  private persist(operation: (adapter: CachePersistenceAdapter) => Promise<void>): Promise<void> {
    const adapter = this.persistence;
    return adapter ? withPersistenceLock(adapter, () => operation(adapter)) : Promise.resolve();
  }

  private toPersistedEntry(entry: CacheEntry): PersistedCacheEntry {
    return {
      key: entry.key,
      value: serializeCacheValue(entry.value),
      expiresAt: entry.expiresAt,
      willIds: Array.from(entry.willIds),
    };
  }
}

/**
 * In-memory cache persistence adapter. Stores entries in RAM only;
 * data is lost when the process terminates.
 */
export class MemoryCachePersistenceAdapter implements CachePersistenceAdapter {
  private entries: PersistedCacheEntry[] = [];

  async readAll(): Promise<PersistedCacheEntry[]> {
    return [...this.entries];
  }

  async write(entry: PersistedCacheEntry): Promise<void> {
    const index = this.entries.findIndex((e) => e.key === entry.key);
    if (index >= 0) {
      this.entries[index] = entry;
    } else {
      this.entries.push(entry);
    }
  }

  async delete(key: string): Promise<void> {
    this.entries = this.entries.filter((e) => e.key !== key);
  }

  async clear(): Promise<void> {
    this.entries = [];
  }
}

/**
 * LocalStorage-based cache persistence adapter. Stores entries in browser
 * localStorage under a namespaced key.
 */
export class LocalStorageCachePersistenceAdapter implements CachePersistenceAdapter {
  private readonly namespace: string;
  private lock: Promise<void> = Promise.resolve();

  constructor(namespace: string = 'sorowill-cache') {
    this.namespace = namespace;
  }

  private withLock<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lock.then(operation);
    this.lock = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async readAll(): Promise<PersistedCacheEntry[]> {
    try {
      const data = localStorage.getItem(this.namespace);
      return data ? JSON.parse(data) : [];
    } catch {
      return [];
    }
  }

  async write(entry: PersistedCacheEntry): Promise<void> {
    return this.withLock(async () => {
      try {
        const entries = await this.readAll();
        const index = entries.findIndex((e) => e.key === entry.key);
        if (index >= 0) {
          entries[index] = entry;
        } else {
          entries.push(entry);
        }
        localStorage.setItem(this.namespace, JSON.stringify(entries));
      } catch {
        // Silently fail if localStorage is unavailable or quota exceeded
      }
    });
  }

  async delete(key: string): Promise<void> {
    return this.withLock(async () => {
      try {
        const entries = await this.readAll();
        const filtered = entries.filter((e) => e.key !== key);
        localStorage.setItem(this.namespace, JSON.stringify(filtered));
      } catch {
        // Silently fail if localStorage is unavailable
      }
    });
  }

  async clear(): Promise<void> {
    return this.withLock(async () => {
      try {
        localStorage.removeItem(this.namespace);
      } catch {
        // Silently fail if localStorage is unavailable
      }
    });
  }
}

/** Default total size budget for IndexedDB-persisted cache entries (1 MB). */
export const DEFAULT_INDEXEDDB_CACHE_MAX_BYTES = 1_048_576;

/** Options for {@link IndexedDbCachePersistenceAdapter}. */
export interface IndexedDbCachePersistenceOptions {
  /**
   * Maximum total size, in estimated bytes, of all persisted entries. When a
   * write pushes the store over this limit the entries closest to expiry are
   * removed first. A single entry larger than the limit is rejected.
   * Defaults to {@link DEFAULT_INDEXEDDB_CACHE_MAX_BYTES} (1 MB).
   */
  maxBytes?: number;
}

/**
 * Returns `true` when the IndexedDB API exists in the current runtime (e.g. a
 * browser). Server-side runtimes and some privacy modes return `false`.
 */
export function isIndexedDbAvailable(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
  } catch {
    return false;
  }
}

/** Estimated stored size of an entry: 2 bytes per UTF-16 code unit. */
function estimateEntryBytes(entry: PersistedCacheEntry): number {
  return (entry.key.length + entry.value.length) * 2;
}

/**
 * IndexedDB-based cache persistence adapter. Stores entries in IndexedDB
 * for more reliable and larger-capacity persistence.
 *
 * - Gracefully degrades: when IndexedDB is unavailable, reads return no
 *   entries and writes are no-ops, so the in-memory cache keeps working.
 * - Enforces a total size budget (default 1 MB), evicting the entries that
 *   expire soonest when a write exceeds it.
 * - Expired entries are removed automatically when the store is read.
 */
export class IndexedDbCachePersistenceAdapter implements CachePersistenceAdapter {
  private readonly dbName: string;
  private readonly storeName: string;
  private readonly maxBytes: number;
  private db: IDBDatabase | null = null;

  constructor(
    dbName: string = 'sorowill-cache',
    storeName: string = 'entries',
    options: IndexedDbCachePersistenceOptions = {},
  ) {
    this.dbName = dbName;
    this.storeName = storeName;
    this.maxBytes = options.maxBytes ?? DEFAULT_INDEXEDDB_CACHE_MAX_BYTES;
  }

  /** `true` when this runtime exposes IndexedDB, so persistence can work. */
  isAvailable(): boolean {
    return isIndexedDbAvailable();
  }

  private async ensureDb(): Promise<IDBDatabase> {
    if (this.db) {
      return this.db;
    }
    if (!isIndexedDbAvailable()) {
      throw new Error('IndexedDB is not available in this environment');
    }

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, 1);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        resolve(this.db);
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName, { keyPath: 'key' });
        }
      };
    });
  }

  /** Runs one request against the store and resolves with its result. */
  private async request<R>(
    mode: IDBTransactionMode,
    build: (store: IDBObjectStore) => IDBRequest<R>,
  ): Promise<R> {
    const db = await this.ensureDb();
    return new Promise<R>((resolve, reject) => {
      const transaction = db.transaction(this.storeName, mode);
      const request = build(transaction.objectStore(this.storeName));
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
  }

  async readAll(): Promise<PersistedCacheEntry[]> {
    try {
      const all = (await this.request<PersistedCacheEntry[]>('readonly', (store) =>
        store.getAll(),
      )) || [];
      // Automatic cleanup: expired entries are removed and not returned.
      const now = Date.now();
      const live: PersistedCacheEntry[] = [];
      for (const entry of all) {
        if (entry.expiresAt !== null && entry.expiresAt <= now) {
          void this.delete(entry.key);
        } else {
          live.push(entry);
        }
      }
      return live;
    } catch {
      return [];
    }
  }

  async write(entry: PersistedCacheEntry): Promise<void> {
    const size = estimateEntryBytes(entry);
    if (size > this.maxBytes) {
      throw new Error(
        `Cache entry "${entry.key}" (~${size} bytes) exceeds the ${this.maxBytes} byte IndexedDB limit`,
      );
    }
    try {
      await this.request('readwrite', (store) => store.put(entry));
      await this.enforceSizeLimit();
    } catch {
      // Silently fail if IndexedDB is unavailable
    }
  }

  /** Removes the soonest-to-expire entries until the store fits the budget. */
  private async enforceSizeLimit(): Promise<void> {
    const all = (await this.request<PersistedCacheEntry[]>('readonly', (store) =>
      store.getAll(),
    )) || [];
    let total = all.reduce((sum, entry) => sum + estimateEntryBytes(entry), 0);
    if (total <= this.maxBytes) {
      return;
    }
    // Entries without an expiry are kept longest; expiring ones go first.
    const victims = [...all].sort(
      (a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity),
    );
    for (const victim of victims) {
      if (total <= this.maxBytes) {
        break;
      }
      await this.delete(victim.key);
      total -= estimateEntryBytes(victim);
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.request('readwrite', (store) => store.delete(key));
    } catch {
      // Silently fail if IndexedDB is unavailable
    }
  }

  async clear(): Promise<void> {
    try {
      await this.request('readwrite', (store) => store.clear());
    } catch {
      // Silently fail if IndexedDB is unavailable
    }
  }
}
