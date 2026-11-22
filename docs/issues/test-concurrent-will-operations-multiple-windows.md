# Test concurrent will operations from multiple windows

_Tracks [GitHub #740](https://github.com/SoroWill/sorowill-sdk/issues/740)._

## Description

A user may have the same SoroWill-powered dApp open in two browser tabs at
once, or two `SoroWillClient` instances may be created in the same process
(e.g. a background service worker alongside the main page). Operations such as
`checkIn`, `createWill`, and `cancelWill` involve a request queue
(`RequestQueue`), an in-flight tracker (`InFlightTracker`), and a read cache
(`ReadCache`). None of these are shared across separate `SoroWillClient`
instances by default, so the following race conditions are currently invisible
to the test suite:

1. **Double check-in**: two tabs each call `client.checkIn(willId)` at nearly
   the same time. Each client has its own `InFlightTracker`, so neither sees
   the other's in-flight call. Both may submit separate `check_in` transactions,
   wasting fees or triggering duplicate-sequence errors on-chain.

2. **Cache staleness across instances**: tab A calls `createWill` and receives
   a fresh will back. Tab B has a live cache entry for the same owner's will
   list. Tab B's cache does not know about tab A's new will, so queries from
   tab B return stale data.

3. **`enqueueAfter` ordering with a shared queue**: when a `create` operation
   from one context and a dependent `fund` from another context share the same
   `RequestQueue` (e.g. via the `account`-keyed shared-queue feature), the
   ordering contract from issue #733 must still hold even when the dependency
   promise crosses the queue boundary.

The SDK already provides mechanisms to address these:
- `InFlightTracker` can be constructed once and passed to multiple
  `SoroWillClient` instances via `SoroWillClientOptions.inFlightTracker` to
  share deduplication across instances.
- `RequestQueue` already supports an `account`-keyed shared-queue mode, so
  operations for the same account serialize across instances.
- `ReadCache` has `invalidateAll()` and `invalidateByWillId()` for
  cross-instance cache coherence.

What is missing is a test that exercises these cross-instance scenarios and
documents the correct behavior.

## Evidence

- `SoroWillClientOptions.inFlightTracker` JSDoc (in `SoroWillClient.ts`, the
  `inFlightTracker` option) explicitly describes the cross-instance
  deduplication use case and shows example code, but no test file exercises it.
- `RequestQueue`'s account-keyed shared-queue mode is used only in unit tests
  for the queue itself (`src/requestQueue.issue732.test.ts`), not in a
  cross-client scenario.
- `InFlightTracker.test.ts` covers single-instance deduplication but not
  shared-tracker deduplication between two `SoroWillClient` instances.

## Suggested acceptance criteria

- [ ] Add a test file `test/issue-740-concurrent-multi-window-operations.test.ts`
      covering:

  1. **Shared `InFlightTracker` deduplicates `checkIn` across two clients**:
     two `SoroWillClient` instances constructed with the same `InFlightTracker`
     both call `checkIn(willId)` concurrently. Only one RPC invocation is made;
     the second call receives the same result as the first (or a
     `DuplicateOperationError` if that is the intended contract for exclusive
     ops — verify against `EXCLUSIVE_INVOKE_METHODS` in `SoroWillClient.ts`).

  2. **Without a shared tracker, two independent clients each submit**:
     the same scenario with separate (default) `InFlightTracker` instances
     results in two independent RPC invocations.

  3. **Shared account-keyed `RequestQueue` serializes operations**:
     two clients sharing the same `account` key submit operations in a known
     order and the shared queue preserves that order even under concurrency.

  4. **Cache invalidation propagates across instances sharing a cache**:
     two clients constructed with the same `ReadCache` instance; after client A
     performs a write that invalidates a will ID, client B's subsequent read
     for that will ID gets a cache miss (and triggers a fresh RPC call) rather
     than serving the stale cached value.

- [ ] All tests must use a stub `rpcServer` (no real RPC calls) and a stub
      `wallet` adapter.
- [ ] Tests must not use `setTimeout`-based timing beyond minimal scheduling
      yields (`await Promise.resolve()`); use controlled concurrency instead.

## Implementation notes

### Shared `InFlightTracker` pattern

```ts
import { InFlightTracker } from '../src/inFlightTracker';
import { SoroWillClient } from '../src/SoroWillClient';

const sharedTracker = new InFlightTracker(CONTRACT_ID);
const clientA = new SoroWillClient({ ..., inFlightTracker: sharedTracker });
const clientB = new SoroWillClient({ ..., inFlightTracker: sharedTracker });

let rpcCallCount = 0;
const stubServer = makeStubServer(() => {
  rpcCallCount++;
  return { /* minimal response */ };
});

// Fire both concurrently.
const [a, b] = await Promise.allSettled([
  clientA.checkIn(WILL_ID),
  clientB.checkIn(WILL_ID),
]);
// With a shared tracker, only one RPC call should have been made.
expect(rpcCallCount).toBe(1);
```

### Shared cache invalidation pattern

```ts
import { ReadCache } from '../src/cache';

const sharedCache = new ReadCache({ ttlMs: 60_000 });
const clientA = new SoroWillClient({ ..., readCache: { /* pass sharedCache */ } });
const clientB = new SoroWillClient({ ..., readCache: { /* pass sharedCache */ } });

// Pre-populate the cache via client B.
await clientB.getWill(WILL_ID); // populates cache

// Client A writes (triggers invalidateByWillId internally).
await clientA.cancelWill(WILL_ID);

// Client B's next read should miss the cache.
let cacheHit = false;
// Hook into the stub server to detect whether a fresh RPC call was made.
await clientB.getWill(WILL_ID);
expect(freshRpcCallMade).toBe(true);
```

Note: passing a `ReadCache` instance directly to `SoroWillClientOptions` may
require exposing the existing internal cache as an injectable option if it is
not already. Check `SoroWillClientOptions.readCache` — if it only accepts
`ReadCacheOptions | false`, this scenario may need an additional option such as
`readCacheInstance?: ReadCache` or a factory approach. If the option is not
available, add it and document the shared-cache caveat (concurrent mutation from
two writers is not safe without external serialization).

After writing the tests, verify they pass with:

```
npx vitest run test/issue-740-concurrent-multi-window-operations.test.ts
```
