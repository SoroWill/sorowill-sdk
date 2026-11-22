# Best Practices

How to use `@sorowill/sdk` efficiently and avoid putting too much load on Soroban RPC endpoints.

## Rate limiting

All RPC traffic from a `SoroWillClient` goes through one shared FIFO request queue. Reads (simulations) and writes (prepare, send, poll) count against the same limits.

| Option | Default | What it does |
|---|---|---|
| `maxConcurrentRequests` | `4` | Maximum number of RPC requests in flight at once |
| `requestsPerSecond` | `10` | Maximum number of requests **started** in any rolling 1-second window |
| `timeoutMs` | `30_000` | Deadline for each request. Can be overridden per call with `{ timeoutMs }` |

Both limits must be positive integers. Otherwise the client throws a `RangeError` when it's constructed.

```ts
import { SoroWillClient } from '@sorowill/sdk';

const client = new SoroWillClient({
  network: 'mainnet',
  contractId: 'C...',
  maxConcurrentRequests: 4,
  requestsPerSecond: 10,
  timeoutMs: 15_000,
});

// Give one slow call more time:
const will = await client.getWill('42', { timeoutMs: 60_000 });
```

### Choosing thresholds

| Environment | Suggested `requestsPerSecond` | Suggested `maxConcurrentRequests` |
|---|---|---|
| Public SDF testnet RPC (`soroban-testnet.stellar.org`) | 5–10 (default) | 2–4 |
| Public mainnet RPC | 5–10 (default) | 2–4 |
| Paid or private RPC provider | Your plan's limit minus ~20% headroom | 8–16 |
| Backend job running alongside a web app on the same key | Split the provider limit between processes | — |

Notes:

- The limits apply **per client instance**. Two `SoroWillClient`s in the same process each get their own budget, so create one client and share it (see [Reuse one client](#reuse-one-client)).
- A single write uses several RPC requests: one `getAccount`, one prepare/simulate, one `sendTransaction`, plus `pollTransaction` until the transaction confirms. Budget roughly 4 or more requests per write. `checkIn`, `emergencyCheckIn`, and `cancelWill` also do a `getWill` read first.
- Public endpoints apply their own limits on top of these. If you get HTTP 429 responses, lower `requestsPerSecond` before you add retries.

### Retries and failover

Transient RPC failures are retried with exponential backoff:

| `retry` option | Default |
|---|---|
| `maxAttempts` | `3` |
| `initialDelayMs` | `250` |
| `maxDelayMs` | `2_000` |
| `backoffFactor` | `2` |

```ts
const client = new SoroWillClient({
  network: 'mainnet',
  contractId: 'C...',
  retry: { maxAttempts: 5, initialDelayMs: 500 },
  rpcUrls: ['https://primary-rpc.example.com', 'https://backup-rpc.example.com'],
});
```

With `rpcUrls`, the client switches to the next endpoint when it hits a connection-level error (`ECONNREFUSED`, `ETIMEDOUT`, `fetch failed`, …). It doesn't switch on contract errors. Use at least two providers in production.

## Caching strategy

Read methods (`getWill`, `getWillsByOwner`, `getWillsByBeneficiary`) are cached. Writes are never cached.

- **Default TTL:** 60 seconds, in memory.
- **Keys:** method name plus the arguments in a stable order, so identical reads share one entry.
- **Invalidation on write:** after a successful write, the SDK removes every cached read for that will. A `getWill` right after `topUp` therefore returns fresh data.
- **Invalidation from events:** pass an `eventSource` and cached reads are removed when an event for a will arrives. This covers changes made by *other* users, such as a beneficiary triggering the will.
- **Persistence:** cache entries can survive page reloads.

```ts
import {
  IndexedDbCachePersistenceAdapter,
  LocalStorageCachePersistenceAdapter,
  SoroWillClient,
} from '@sorowill/sdk';

const client = new SoroWillClient({
  network: 'testnet',
  contractId: 'C...',
  readCache: {
    ttlMs: 30_000,
    persistence: new LocalStorageCachePersistenceAdapter(window.localStorage),
  },
});
```

### Which TTL to use

| Use case | Recommendation |
|---|---|
| Dashboard listing a user's wills | `ttlMs: 30_000`–`60_000` with `LocalStorage` or `IndexedDb` persistence |
| Countdown or "time until check-in" display | Fetch once, then compute locally with `getTimeUntilCheckin(will)`. Don't poll the RPC every second |
| Pages that decide whether to trigger or release | Short TTL (`5_000`) or `readCache: false`. These decisions need current state |
| Backend keeper or cron job | `readCache: false`, or a TTL shorter than the job interval |
| Many wills or large beneficiary lists | `IndexedDbCachePersistenceAdapter` (avoids the ~5 MB localStorage limit) |

Things to keep in mind:

- A cached `Will` can lag behind the chain by up to `ttlMs` when someone else changes it and you have no `eventSource`. The contract always has the final say: if a write is made against stale state, the call fails with a typed error such as `WillNotActiveError`. It doesn't silently do the wrong thing.
- Persisted cache entries store public on-chain data only. Even so, clear the cache when a user signs out on a shared device.
- Use a different `namespace` for each network/contract pair if your app switches between testnet and mainnet.

## Batch operations

`client.batch()` puts several contract calls into **one Stellar transaction**: one simulation, one wallet signature, and atomic submission.

```ts
import { connectWallet, SoroWillClient } from '@sorowill/sdk';

const client = new SoroWillClient({ network: 'testnet', contractId: 'C...' });
const { publicKey: owner } = await connectWallet();

// Check in on every will this owner holds, with one signature.
const wills = await client.getWillsByOwner(owner);
const result = await client.batch(
  wills
    .filter((w) => w.status === 'Active')
    .map((w) => ({ method: 'check_in', args: { will_id: BigInt(w.id), owner } })),
);
console.log(`Checked in on ${wills.length} wills in tx ${result.txHash}`);
```

Recommendations:

- **Use batch for related user actions.** Examples: check in on several wills, or create a will and top it up. The user signs once instead of N times.
- **Batches are atomic.** If any operation fails, the whole transaction fails and nothing changes. Don't mix operations that might fail (for example a `trigger_will` that may be too early) with ones that must succeed.
- **Use contract argument names.** `batch` takes the raw contract function names and snake_case args (`will_id`, `checkin_period_days`, …). Integer arguments must be `bigint`.
- **Keep batches small.** Soroban transactions have CPU, memory, and footprint limits. Around 5–10 simple operations per batch is a safe starting point. Split larger sets into chunks.
- **An empty batch throws** `RangeError('A batch must contain at least one operation')`. Check for this before you call it.
- **Reads don't need batching.** Run independent reads with `Promise.all`. The request queue keeps them within your rate limit.

```ts
const [owned, inherited] = await Promise.all([
  client.getWillsByOwner(address),
  client.getWillsByBeneficiary(address),
]);
```

## Performance tips

### Reuse one client

Create one `SoroWillClient` per network/contract and share it across your app. Each instance fetches and parses the contract spec, keeps its own cache, and has its own rate-limit budget. In React, create the client at module level or in a context. Don't create it inside a component body.

### Use pagination for list views

```ts
const page = await client.getWillsByOwner(owner, { pageSize: 20 });
// page.wills, page.nextCursor
```

The contract returns the full list, and the SDK splits it into pages on the client. The cache reuses the full result, so moving between pages doesn't make new RPC calls within the TTL.

### Compute locally when you can

`getTimeUntilCheckin`, `isCheckinDue`, `calculateShares`, `formatUSDC`, and `validateBeneficiaries` are pure functions. Use them for UI state, and call the RPC only when the underlying `Will` might have changed.

### Validate before you submit

A failed write still costs a simulation and a wallet prompt. Check inputs on the client first:

- `validateBeneficiaries(beneficiaries)`: integer percentages that sum to 100.
- At most 10 beneficiaries and 3 guardians.
- `amount` is greater than 0.
- `will.status === WillStatus.Active` before you call `topUp`, `checkIn`, or `updateBeneficiaries`.
- `isCheckinDue(will)` before you call `triggerWill`.

### Use events instead of polling

If you need to show changes from other users, use an `eventSource` (which also keeps the cache correct). Don't poll `getWill` on a short interval. If you have to poll, use 30 seconds or more.

### Clean up

Call `client.destroy()` when you're done with a client (for example when a component unmounts or a server shuts down). It unsubscribes from the configured event source.

### Configure through the environment on servers

```ts
// SOROWILL_NETWORK=mainnet
// SOROWILL_CONTRACT_ID=C...
// SOROWILL_RPC_URL=https://your-private-rpc.example.com
import { SoroWillClient } from '@sorowill/sdk';

const client = SoroWillClient.fromEnv();
```

This keeps your RPC provider URL (which often contains an API key) out of source control.
