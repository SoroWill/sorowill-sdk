# Test cache behavior with network offline scenario

_Tracks [GitHub #739](https://github.com/SoroWill/sorowill-sdk/issues/739)._

## Description

`ReadCache` already implements offline-aware behavior: when `navigator.onLine`
is `false` (or the injected `isOnline` callback returns `false`), expired
entries are retained and returned with `stale: true` and `indicator: 'offline'`
instead of being evicted. The TTL clock is also paused during the offline period
and advanced when connectivity is restored, so entries don't expire unfairly
while the client is offline.

This behavior is implemented in `src/cache.ts` (`ReadCache.getWithStatus`,
`checkOnline`, `restoreOnlineTtl`, `evictIfNeeded`) and is intended to allow
the UI to continue showing last-known data rather than an empty state during
brief connectivity interruptions.

However, the test coverage for these offline-specific code paths is thin. The
`src/cache.issue729.test.ts` file covers `getCacheStats()` but does not cover
the offline scenarios. The main `src/cache.test.ts.skip` file is skipped. No
test file verifies the full offline → stale-serve → online → TTL-restore
lifecycle.

## Evidence

- `ReadCache.getWithStatus()` returns `{ value, stale: true, indicator: 'offline' }`
  for expired entries when offline, but no test asserts this shape.
- `ReadCache.restoreOnlineTtl()` extends every entry's `expiresAt` by the
  offline duration, but no test verifies that entries that would have expired
  while offline are still live after coming back online.
- `ReadCache.evictIfNeeded()` skips expired-entry eviction while offline, but
  no test covers an LRU eviction under offline conditions.
- `ReadCache` registers `window.addEventListener('offline', ...)` and
  `window.addEventListener('online', ...)` listeners when in a browser
  environment. No test fires these events and observes the resulting state
  change.
- The `isOnline` constructor option exists specifically to allow test injection
  of the connectivity state, but no existing test file uses it.

## Suggested acceptance criteria

- [ ] Add a test file `test/issue-739-cache-offline-behavior.test.ts` covering:
  1. **Stale serving while offline**: an entry that expires while the cache
     is in offline mode is returned by `getWithStatus()` with
     `{ stale: true, indicator: 'offline' }` rather than evicted.
  2. **Normal eviction while online**: the same expired entry is evicted
     and `get()` returns `undefined` when the cache is online.
  3. **TTL extension on reconnect**: an entry set just before going offline,
     which would have expired during the offline window, remains live after
     `isOnline` returns `true` again (because `restoreOnlineTtl` extends it
     by the offline duration).
  4. **Offline LRU eviction skips expired entries**: with a small `maxEntries`
     cap and the cache offline, adding a new entry evicts LRU entries rather
     than evicting the expired one, since `evictIfNeeded` does not prune
     expired entries while offline.
  5. **`isOffline` getter**: `cache.isOffline` returns `true` when the
     injected `isOnline()` returns `false`, and `false` otherwise.
  6. **`window` event integration** (browser-environment test, using a mock
     `window` with `addEventListener`/`removeEventListener`): firing the
     `'offline'` event marks the cache offline; firing `'online'` calls
     `restoreOnlineTtl` and re-extends the TTLs.

- [ ] All tests must use the injected `isOnline` callback (and a controlled
      `now` clock) rather than patching `navigator` globals, so they run
      safely in Node.

## Implementation notes

Use the `isOnline` and `now` constructor options to drive every scenario
deterministically:

```ts
import { ReadCache } from '../src/cache';

let online = true;
let now = 1_000;

const cache = new ReadCache({
  ttlMs: 500,
  now: () => now,
  isOnline: () => online,
});

// Set an entry.
cache.set('will-1', { id: '1', status: 'active' });

// Advance past its TTL and go offline simultaneously.
online = false;
now += 600; // entry is expired

// The entry is stale but still served.
const result = cache.getWithStatus<{ id: string }>('will-1');
expect(result).not.toBeUndefined();
expect(result?.stale).toBe(true);
expect(result?.indicator).toBe('offline');

// Come back online — TTL is extended by offlineDuration (600ms).
online = true;
cache.get('will-1'); // triggers restoreOnlineTtl via checkOnline

// Now the entry should still be live (expiresAt was extended by 600).
expect(cache.get('will-1')).toBeDefined();
```

For the `window` event test, provide a minimal `window` mock and verify
`onOfflineHandler` / `onOnlineHandler` are registered via `addEventListener`.
Avoid monkey-patching the real global; run this sub-scenario in a `describe`
that sets up and tears down the mock before and after all tests in the block.

After writing the tests, verify they pass with:

```
npx vitest run test/issue-739-cache-offline-behavior.test.ts
```
