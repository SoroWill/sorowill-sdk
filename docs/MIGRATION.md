# Migration Guide: v0.0.x → v0.1.x

This guide covers upgrading from the original `@sorowill/sdk` API (the v0.0.x line, which includes the first `0.1.0`/`0.1.1` publishes that shipped the same initial client) to the current **v0.1.x** API.

The method names and signatures of the core will lifecycle haven't changed. Most upgrades need **no code changes**. Read the breaking changes below anyway, because several runtime behaviors have changed: caching, rate limiting, timeouts, and error types.

## Upgrade path

1. **Update the package**

   ```bash
   npm install @sorowill/sdk@^0.1
   ```

2. **Check your runtime.** Node.js **18 or newer** is required (`engines.node >= 18`).

3. **Work through the [breaking changes](#breaking-changes)** below. In order of how likely they are to affect you:
   - [Error handling](#1-contract-errors-are-now-typed): if you match on error message strings.
   - [Read caching](#2-reads-are-cached-by-default): if you poll `getWill` right after an action made elsewhere.
   - [Request timeouts and rate limits](#3-rpc-requests-are-queued-rate-limited-and-time-out): if you run large parallel jobs or very slow endpoints.
   - [Custom wallets](#4-wallets-are-pluggable): if you wrapped or mocked the Freighter helpers.

4. **Run your test suite against testnet** before you deploy to mainnet.

5. **Optionally adopt the new features**: [batching](./BEST_PRACTICES.md#batch-operations), RPC failover, persistent caching, `fromEnv()`, other wallet adapters, and the React hooks.

## Breaking changes

### 1. Contract errors are now typed

**Before:** every failure was a plain `Error`, and the contract error code was buried in the message:

```ts
// v0.0.x
try {
  await client.triggerWill(willId);
} catch (error) {
  if ((error as Error).message.includes('Error(Contract, #10)')) {
    showMessage('Too early to trigger');
  }
}
```

**After:** contract failures are thrown as subclasses of `WillContractError`, each with a numeric `code`. The original RPC error is kept on `error.cause`.

```ts
// v0.1.x
import { CheckinNotDueError, WillContractError } from '@sorowill/sdk';

try {
  await client.triggerWill(willId);
} catch (error) {
  if (error instanceof CheckinNotDueError) {
    showMessage('Too early to trigger');
  } else if (error instanceof WillContractError) {
    showMessage(`Contract error ${error.code}`);
  } else {
    throw error;
  }
}
```

Other message changes:

| v0.0.x | v0.1.x |
|---|---|
| Raw RPC error text when a transient call failed | `SoroWill RPC call <label> failed after N attempts: ...` (after automatic retries) |
| Hung forever on an unresponsive endpoint | `RequestTimeoutError` after `timeoutMs` |
| `Error` | `SoroWillError` (still `instanceof Error`) for SDK-level failures |

**Migration:** replace `message.includes(...)` checks with `instanceof` checks. The full list of error classes is in [TROUBLESHOOTING.md](./TROUBLESHOOTING.md#contract-errors).

### 2. Reads are cached by default

**Before:** every `getWill`, `getWillsByOwner`, and `getWillsByBeneficiary` call went to the RPC.

**After:** results are cached in memory for **60 seconds**. The SDK clears the cache for a will automatically after *your* writes to it. Changes made by other accounts (for example a beneficiary triggering the will) can take up to the TTL to appear, unless you configure an `eventSource`.

**Migration:** if your code depends on always-fresh reads, choose one of these:

```ts
// Turn caching off completely (matches v0.0.x behavior)
const client = new SoroWillClient({ network, contractId, readCache: false });

// ...or keep caching but with a shorter TTL
const client = new SoroWillClient({ network, contractId, readCache: { ttlMs: 5_000 } });
```

### 3. RPC requests are queued, rate-limited, and time out

**Before:** calls went straight to the RPC with no concurrency limit and no timeout.

**After:** all RPC traffic from a client goes through a shared FIFO queue:

| Setting | Default |
|---|---|
| `maxConcurrentRequests` | 4 |
| `requestsPerSecond` | 10 |
| `timeoutMs` | 30,000 ms per request |
| `retry.maxAttempts` | 3 (exponential backoff from 250 ms to 2 s) |

Effects you may notice:

- Bulk scripts that start hundreds of reads at once now take longer, because they're throttled instead of being rejected by the endpoint with HTTP 429.
- Calls to a slow endpoint can now reject with `RequestTimeoutError`.

**Migration:** tune the limits for your provider:

```ts
const client = new SoroWillClient({
  network: 'mainnet',
  contractId,
  maxConcurrentRequests: 16, // private RPC with a high quota
  requestsPerSecond: 50,
  timeoutMs: 60_000,
});

// or for a single call:
await client.getWill(id, { timeoutMs: 120_000 });
```

### 4. Wallets are pluggable

**Before:** the client always called the Freighter helpers directly.

**After:** the client signs through a `WalletAdapter`. If you don't pass `wallet`, it uses Freighter, so **browser apps that use Freighter keep working unchanged**.

If you mocked the module-level `getPublicKey` / `signTransaction` helpers in tests, or wrapped them to support another wallet, pass an adapter instead:

```ts
// v0.1.x: inject an adapter instead of mocking the Freighter helpers
import { SoroWillClient, type WalletAdapter } from '@sorowill/sdk';

const testWallet: WalletAdapter = {
  getPublicKey: async () => 'GTEST...',
  signTransaction: async (xdr) => signLocally(xdr),
};

const client = new SoroWillClient({ network: 'testnet', contractId, wallet: testWallet });
```

Bundled adapters: `freighterAdapter` / `FreighterWalletAdapter`, `createAlbedoAdapter`, `LobstrWalletAdapter`, `LedgerWalletAdapter`, `HanaWalletAdapter`, `HotWalletAdapter`, and `WalletConnectAdapter`.

### 5. Prepared transactions are verified before signing

**After:** before asking the wallet to sign, the SDK checks that the transaction returned by the RPC's `prepareTransaction` contains exactly the operations it built. If they don't match, it throws `Prepared transaction for <method> did not match the intended operation...`.

**Migration:** none for normal use. If you inject a custom `rpcServer` (for example in tests), its `prepareTransaction` must return the same operations it was given.

### 6. List methods accept pagination options

`getWillsByOwner` and `getWillsByBeneficiary` now accept an optional second argument. With no options they still return `Will[]`. With any pagination option (`{ pageSize }`, `{ limit }`, `{ offset }`, or `{ cursor }`) they return `{ wills, nextCursor, prevCursor, offset, limit, total, hasMore }`. Both offset/limit and cursor-based pagination are supported; `cursor` takes precedence over `offset`.

**Migration:** none unless you pass a second argument. TypeScript users who wrap these methods may need to narrow the union return type.

## New features (non-breaking)

| Feature | Example |
|---|---|
| Per-call options | `client.checkIn(id, { timeoutMs: 10_000 })` |
| Atomic batches with one signature | `client.batch([{ method: 'check_in', args: { will_id: 1n, owner } }, ...])` |
| RPC failover | `rpcUrls: ['https://a.example', 'https://b.example']` |
| Environment config | `SoroWillClient.fromEnv()` reads `SOROWILL_NETWORK`, `SOROWILL_CONTRACT_ID`, `SOROWILL_RPC_URL`, ... |
| Persistent cache | `readCache: { persistence: new IndexedDbCachePersistenceAdapter() }` |
| Event-driven cache invalidation | `eventSource: myWillEventSource` |
| Contract call hooks | `hooks.onBeforeInvoke(...)`, `hooks.onAfterInvoke(...)` |
| Multisig and fee-bump helpers | `MultisigCollector`, `buildFeeBumpXdr`, `submitFeeBumpTransaction` |
| SEP-7 signing URIs | `client.buildSep7SigningUri(...)`, `parseSep7Callback(...)` |
| React hooks | `import { useWill, useWillsByOwner } from '@sorowill/sdk/react'` |

## Code migration examples

### Client setup

```ts
// v0.0.x
import { SoroWillClient } from '@sorowill/sdk';

const client = new SoroWillClient({ network: 'testnet', contractId: 'C...' });
```

```ts
// v0.1.x: same code works. Recommended production setup:
import { LocalStorageCachePersistenceAdapter, SoroWillClient } from '@sorowill/sdk';

const client = new SoroWillClient({
  network: 'mainnet',
  contractId: 'C...',
  rpcUrls: ['https://primary-rpc.example.com', 'https://backup-rpc.example.com'],
  readCache: {
    ttlMs: 30_000,
    persistence: new LocalStorageCachePersistenceAdapter(window.localStorage),
  },
  timeoutMs: 20_000,
});
```

### Checking in on several wills

```ts
// v0.0.x: one wallet prompt per will
for (const will of wills) {
  await client.checkIn(will.id);
}
```

```ts
// v0.1.x: one wallet prompt for all of them
await client.batch(
  wills.map((w) => ({ method: 'check_in', args: { will_id: BigInt(w.id), owner } })),
);
```

### React data fetching

```tsx
// v0.0.x: hand-written effect
const [will, setWill] = useState<Will | null>(null);
useEffect(() => {
  client.getWill(id).then(setWill);
}, [id]);
```

```tsx
// v0.1.x
import { useWill } from '@sorowill/sdk/react';

const options = { network: 'testnet', contractId: 'C...' } as const;

function WillCard({ id }: { id: string }) {
  const { data: will, loading, error, refetch } = useWill(options, id);
  if (loading) return <p>Loading…</p>;
  if (error) return <p>{error.message}</p>;
  return <p onClick={refetch}>{will?.status}</p>;
}
```

## Deprecation timeline

No public API was removed in v0.1.x, and nothing is formally deprecated yet. Going forward, SoroWill follows this policy while the SDK is pre-1.0:

1. **Announce:** an API is marked `@deprecated` in its JSDoc and listed in this guide in a minor release (`0.N.0`). It keeps working.
2. **Grace period:** deprecated APIs stay for **at least one further minor release, and at least 90 days**, whichever is longer.
3. **Remove:** removal happens only in a later minor release (`0.N+2.0` or later) and is listed under "Breaking changes" in that release's notes and in this file.

APIs currently planned for deprecation:

| API | Replacement | Status |
|---|---|---|
| Top-level Freighter helpers used for signing (`getPublicKey`, `signTransaction`) | A `WalletAdapter` passed as `wallet` (e.g. `freighterAdapter`) | Planned. Still supported in all 0.1.x releases |
| Matching error message strings | `instanceof` checks on typed errors | Messages aren't part of the public API and may change in any release |

Before every upgrade, check the [releases page](https://github.com/SoroWill/sorowill-sdk/releases) and this file. If something breaks that isn't listed here, please [open an issue](https://github.com/SoroWill/sorowill-sdk/issues).
