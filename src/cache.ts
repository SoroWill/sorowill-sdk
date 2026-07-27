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

export interface ReadCacheOptions {
  namespace?: string;
  ttlMs?: number;
  persistence?: CachePersistenceAdapter;
}

interface CacheEntry {
  key: string;
  value: unknown;
  expiresAt: number | null;
  willIds: Set<string>;
}

const DEFAULT_CACHE_NAMESPACE = 'sorowill:read-cache';
const DEFAULT_TTL_MS = 60_000;

export function serializeCacheValue(value: unknown): string {
  return JSON.stringify(value, (_key, currentValue) => {
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
      currentValue.__type === 'bigint' &&
      'value' in currentValue &&
      typeof currentValue.value === 'string'
    ) {
      return BigInt(currentValue.value);
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
        a.localeCompare(b),
      );
      return Object.fromEntries(sortedEntries);
    }

    return currentValue;
  });
}

export function createReadCacheKey(method: string, args: Record<string, unknown>): string {
  return `${method}:${stableStringify(args)}`;
}

export class ReadCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly ttlMs: number;
  private readonly persistence: CachePersistenceAdapter | undefined;
  private readonly readyPromise: Promise<void>;

  constructor(options: ReadCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.persistence = options.persistence;
    this.readyPromise = this.hydrate();
  }

  async ready(): Promise<void> {
    await this.readyPromise;
  }

  async get<T>(key: string): Promise<T | undefined> {
    await this.ready();

    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }

    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      await this.delete(key);
      return undefined;
    }

    return entry.value as T;
  }

  async set(key: string, value: unknown, willIds: Iterable<string> = []): Promise<void> {
    await this.ready();

    const entry: CacheEntry = {
      key,
      value,
      expiresAt: this.ttlMs > 0 ? Date.now() + this.ttlMs : null,
      willIds: new Set(willIds),
    };

    this.entries.set(key, entry);
    await this.persistence?.write(this.toPersistedEntry(entry));
  }

  async invalidateByWillId(willId: string): Promise<void> {
    await this.ready();

    const keysToDelete: string[] = [];
    for (const [key, entry] of this.entries) {
      if (entry.willIds.has(willId)) {
        keysToDelete.push(key);
      }
    }

    await Promise.all(keysToDelete.map((key) => this.delete(key)));
  }

  async clear(): Promise<void> {
    await this.ready();
    this.entries.clear();
    await this.persistence?.clear();
  }

  private async delete(key: string): Promise<void> {
    this.entries.delete(key);
    await this.persistence?.delete(key);
  }

  private async hydrate(): Promise<void> {
    if (!this.persistence) {
      return;
    }

    const persistedEntries = await this.persistence.readAll();
    const now = Date.now();

    for (const persistedEntry of persistedEntries) {
      if (persistedEntry.expiresAt !== null && persistedEntry.expiresAt <= now) {
        await this.persistence.delete(persistedEntry.key);
        continue;
      }

      this.entries.set(persistedEntry.key, {
        key: persistedEntry.key,
        value: deserializeCacheValue(persistedEntry.value),
        expiresAt: persistedEntry.expiresAt,
        willIds: new Set(persistedEntry.willIds),
      });
    }
  }

  private toPersistedEntry(entry: CacheEntry): PersistedCacheEntry {
    return {
      key: entry.key,
      value: serializeCacheValue(entry.value),
      expiresAt: entry.expiresAt,
      willIds: [...entry.willIds],
    };
  }
}

export class MemoryCachePersistenceAdapter implements CachePersistenceAdapter {
  private readonly entries = new Map<string, PersistedCacheEntry>();

  async readAll(): Promise<PersistedCacheEntry[]> {
    return [...this.entries.values()];
  }

  async write(entry: PersistedCacheEntry): Promise<void> {
    this.entries.set(entry.key, entry);
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }

  async clear(): Promise<void> {
    this.entries.clear();
  }
}

export class LocalStorageCachePersistenceAdapter implements CachePersistenceAdapter {
  private readonly storage: Storage;
  private readonly storageKey: string;

  constructor(storage: Storage, options: { key?: string } = {}) {
    this.storage = storage;
    this.storageKey = options.key ?? DEFAULT_CACHE_NAMESPACE;
  }

  async readAll(): Promise<PersistedCacheEntry[]> {
    const raw = this.storage.getItem(this.storageKey);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw) as PersistedCacheEntry[];
    return Array.isArray(parsed) ? parsed : [];
  }

  async write(entry: PersistedCacheEntry): Promise<void> {
    const entries = await this.readAll();
    const nextEntries = [...entries.filter((currentEntry) => currentEntry.key !== entry.key), entry];
    this.storage.setItem(this.storageKey, JSON.stringify(nextEntries));
  }

  async delete(key: string): Promise<void> {
    const entries = await this.readAll();
    this.storage.setItem(
      this.storageKey,
      JSON.stringify(entries.filter((entry) => entry.key !== key)),
    );
  }

  async clear(): Promise<void> {
    this.storage.removeItem(this.storageKey);
  }
}

export class IndexedDbCachePersistenceAdapter implements CachePersistenceAdapter {
  private readonly dbName: string;
  private readonly storeName: string;
  private readonly dbPromise: Promise<IDBDatabase>;

  constructor(options: { dbName?: string; storeName?: string } = {}) {
    this.dbName = options.dbName ?? 'sorowill-sdk';
    this.storeName = options.storeName ?? 'read-cache';
    this.dbPromise = this.open();
  }

  async readAll(): Promise<PersistedCacheEntry[]> {
    const store = await this.getStore('readonly');
    return await this.request<PersistedCacheEntry[]>(store.getAll());
  }

  async write(entry: PersistedCacheEntry): Promise<void> {
    const store = await this.getStore('readwrite');
    await this.request(store.put(entry));
  }

  async delete(key: string): Promise<void> {
    const store = await this.getStore('readwrite');
    await this.request(store.delete(key));
  }

  async clear(): Promise<void> {
    const store = await this.getStore('readwrite');
    await this.request(store.clear());
  }

  private async open(): Promise<IDBDatabase> {
    const request = indexedDB.open(this.dbName, 1);

    return await new Promise<IDBDatabase>((resolve, reject) => {
      request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName, { keyPath: 'key' });
        }
      };
      request.onsuccess = () => resolve(request.result);
    });
  }

  private async getStore(mode: IDBTransactionMode): Promise<IDBObjectStore> {
    const db = await this.dbPromise;
    const transaction = db.transaction(this.storeName, mode);
    return transaction.objectStore(this.storeName);
  }

  private async request<T>(request: IDBRequest<T>): Promise<T> {
    return await new Promise<T>((resolve, reject) => {
      request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
      request.onsuccess = () => resolve(request.result);
    });
  }
}
