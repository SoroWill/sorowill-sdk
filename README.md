<img src="./docs/logo.svg" alt="SoroWill" width="56" height="56" />

# @sorowill/sdk

**TypeScript SDK for SoroWill — trustless on-chain inheritance on Stellar Soroban**

[![npm](https://img.shields.io/npm/v/%40sorowill%2Fsdk)](https://www.npmjs.com/package/@sorowill/sdk)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

## Installation

```bash
npm install @sorowill/sdk
```

## Quick Start

```ts
import {
  LocalStorageCachePersistenceAdapter,
  SoroWillClient,
  connectWallet,
  toStroops,
} from '@sorowill/sdk';

// Connect the user's Freighter wallet.
const wallet = await connectWallet();

// Point the client at the deployed SoroWill contract on testnet.
const client = new SoroWillClient({
  network: 'testnet',
  contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
  readCache: {
    ttlMs: 60_000,
    persistence: new LocalStorageCachePersistenceAdapter(window.localStorage),
  },
  retry: {
    maxAttempts: 3,
    initialDelayMs: 250,
  },
  timeoutMs: 15_000,
  maxConcurrentRequests: 4,
  requestsPerSecond: 10,
});

// Or construct from environment variables in Node-based apps:
// SOROWILL_NETWORK=testnet
// SOROWILL_CONTRACT_ID=CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE
// const client = SoroWillClient.fromEnv();

// Create a will locking 1,000 USDC, split 60/40 between two beneficiaries,
// with a 90-day check-in period and a 7-day grace period.
const { willId, txHash } = await client.createWill({
  token: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA', // testnet USDC SAC
  amount: toStroops('1000').toString(),
  beneficiaries: [
    { address: 'GBEN...AAAA', percentage: 60 },
    { address: 'GBEN...BBBB', percentage: 40 },
  ],
  checkinPeriodDays: 90,
  gracePeriodDays: 7,
  guardians: [],
});

console.log(`Created will #${willId} in tx ${txHash}`);

// Check in periodically to reset the countdown and prove you're still active.
const { nextDeadline } = await client.checkIn(willId);
console.log(`Next check-in due by ${nextDeadline.toISOString()}`);

// Read a will's full state at any time — no wallet required.
const will = await client.getWill(willId);
console.log(will.status, will.balance, will.beneficiaries);
```

## API Reference

| Method | Description | Parameters | Returns |
|---|---|---|---|
| `createWill` | Locks a token balance and creates a new will | `CreateWillParams` | `Promise<{ willId, txHash }>` |
| `checkIn` | Resets the check-in countdown | `willId` | `Promise<{ txHash, nextDeadline }>` |
| `triggerWill` | Starts the grace period after a missed check-in | `willId` | `Promise<{ txHash }>` |
| `emergencyCheckIn` | Cancels an in-progress trigger during the grace period | `willId` | `Promise<{ txHash, nextDeadline }>` |
| `releaseInheritance` | Distributes the balance to beneficiaries after the grace period expires | `willId` | `Promise<{ txHash }>` |
| `cancelWill` | Withdraws the full balance and closes the will | `willId` | `Promise<{ txHash, refundAmount }>` |
| `updateBeneficiaries` | Replaces the beneficiary list before the will is triggered | `UpdateBeneficiariesParams` | `Promise<{ txHash }>` |
| `topUp` | Adds more of the token to an existing will | `willId`, `amount` | `Promise<{ txHash }>` |
| `previewFee` | Simulates a state-changing method and returns its estimated Soroban resource fee | `method`, `params` | `Promise<{ resourceFee }>` |
| `getWill` | Reads the full state of a will (no wallet required) | `willId` | `Promise<Will>` |
| `getWillsByOwner` | Lists every will owned by an address, with optional client-side pagination | `owner`, `PaginationOptions?` | `Promise<Will[] \| { wills, nextCursor }>` |
| `getWillsByBeneficiary` | Lists every will an address is named in, with optional client-side pagination | `beneficiary`, `PaginationOptions?` | `Promise<Will[] \| { wills, nextCursor }>` |
| `guardianTrigger` | Casts a guardian vote; 2 of 3 forces an early release | `willId` | `Promise<{ txHash }>` |
| `batch` | Simulates, signs, and submits multiple contract operations atomically | `BatchOperation[]` | `Promise<BatchResult>` |

Every method also accepts an optional final `{ timeoutMs }` argument. RPC work flows through a
shared FIFO queue configured by `maxConcurrentRequests` and `requestsPerSecond`, preventing bursts
of reads or writes from overwhelming a public endpoint. A timeout rejects with
`RequestTimeoutError`.

## Batch transactions

`batch` combines native contract calls into one Stellar transaction and therefore one Freighter
signature prompt:

```ts
const result = await client.batch([
  {
    method: 'create_will',
    args: {
      owner: wallet.publicKey,
      token: 'CBIEL...DAMA',
      amount: 10_000_000n,
      beneficiaries: [{ address: 'GBEN...AAAA', percentage: 100 }],
      checkin_period_days: 90n,
      grace_period_days: 7n,
      guardians: [],
    },
  },
  {
    method: 'check_in',
    args: { will_id: 1n, owner: wallet.publicKey },
  },
]);
```

The whole batch is simulated and assembled together, signed once, and submitted atomically.

## Typed errors

Contract failures are exposed as subclasses of `WillContractError`, including
`WillNotFoundError`, `NotOwnerError`, `WillNotActiveError`, `WillNotTriggeredError`,
`GracePeriodNotExpiredError`, `GracePeriodExpiredError`, `InvalidPercentagesError`,
`AlreadyVotedError`, `NotGuardianError`, `CheckinNotDueError`, `ZeroAmountError`, and
`TooManyBeneficiariesError`.

## Utilities

| Function | Description |
|---|---|
| `formatUSDC(stroops)` | Formats base units as a human-readable decimal string, e.g. `"1,234.50"` |
| `toStroops(usdc)` | Parses a decimal USDC string into base units as a `bigint` |
| `getTimeUntilCheckin(will)` | Seconds until the next check-in deadline (negative if overdue) |
| `isCheckinDue(will)` | Whether the check-in deadline has already passed |
| `calculateShares(balance, beneficiaries)` | Splits a balance across beneficiaries, mirroring on-chain rounding |
| `formatDeadline(date)` | Formats a `Date` as a human-readable string |
| `validateBeneficiaries(beneficiaries)` | Checks that percentages are well-formed and sum to 100 |

## Custom fetch / environments without a global fetch

The SDK's event-polling transport uses the standard `fetch` API. In environments where `fetch` is not available globally — older Node.js versions (< 18), certain React Native runtimes, or test environments — you have two options:

### Option A — inject a fetch implementation per client

Pass any `fetch`-compatible function via the `fetch` option. This only affects the SDK's own HTTP calls (event polling):

```ts
import fetch from 'node-fetch';

const client = new SoroWillClient({
  network: 'testnet',
  contractId: 'C...',
  fetch: fetch as unknown as typeof globalThis.fetch,
});
```

### Option B — install a global polyfill

The underlying `@stellar/stellar-sdk` `rpc.Server` reads `globalThis.fetch` directly and does not expose a per-instance override. If you need polyfilled fetch for all Soroban RPC traffic (not just event polling), install a global polyfill once at the top of your entry point, before constructing any client:

```ts
// entry.ts — must run before any SoroWillClient is constructed
import fetch from 'cross-fetch';
globalThis.fetch = fetch;
```

Popular polyfill packages: [`node-fetch`](https://github.com/node-fetch/node-fetch) (v3+, ESM), [`cross-fetch`](https://github.com/lquixada/cross-fetch) (CJS and ESM).

> **Note:** Node.js 18+ ships with a built-in global `fetch` (unflagged in 21+). If your `engines` field targets `>=18`, no polyfill is needed.

## Scripts, automation, and testing (KeypairSigner)

Every state-changing `SoroWillClient` method signs transactions through the configured `WalletAdapter`. The default adapter uses the Freighter browser extension, which requires a running browser and user approval — neither of which is available in a Node.js script, a keeper bot, or a unit test.

For those environments you can implement `WalletAdapter` directly on top of `@stellar/stellar-sdk`'s `Keypair`. No Freighter dependency is involved:

```ts
import { Keypair, Transaction, TransactionBuilder } from '@stellar/stellar-sdk';
import { SoroWillClient } from '@sorowill/sdk';
import type { WalletAdapter } from '@sorowill/sdk';

class KeypairSigner implements WalletAdapter {
  constructor(private readonly keypair: Keypair) {}

  async getPublicKey(): Promise<string> {
    return this.keypair.publicKey();
  }

  async signTransaction(
    transactionXdr: string,
    opts: { networkPassphrase: string },
  ): Promise<string> {
    const tx = TransactionBuilder.fromXDR(
      transactionXdr,
      opts.networkPassphrase,
    ) as Transaction;
    tx.sign(this.keypair);
    return tx.toXDR();
  }
}

// Load the secret from an environment variable — never hard-code it.
const signer = new KeypairSigner(Keypair.fromSecret(process.env.STELLAR_SECRET!));

const client = new SoroWillClient({
  network: 'testnet',
  contractId: 'C...',
  wallet: signer,
});

const { willId } = await client.createWill({ /* ... */ });
console.log('Created will', willId);
```

> **Security warning:** `KeypairSigner` holds a raw secret key in memory. It is intended for scripts, automation, and testing only — **never use it to handle real end-user funds in a browser** or any environment where the secret could be exposed to untrusted code. For production browser applications always use a browser-extension or hardware-wallet adapter (Freighter, Albedo, Ledger, etc.) so the secret never leaves the wallet.

## Wallet helpers

`isFreighterInstalled()`, `connectWallet()`, `getPublicKey()`, and `signTransaction()` wrap the [Freighter](https://www.freighter.app/) browser extension API used by the default adapter for all state-changing calls.

## Pluggable wallets

`SoroWillClient` reads the connected account and signs transactions through a small `WalletAdapter` interface, so any Stellar wallet can be used — not just Freighter:

```ts
interface WalletAdapter {
  getPublicKey(): Promise<string>;
  signTransaction(transactionXdr: string, opts: { networkPassphrase: string }): Promise<string>;
}
```

If no `wallet` is passed, the client defaults to `freighterAdapter`, so existing code keeps working unchanged. To use [Albedo](https://albedo.link) instead, pass the bundled adapter:

```ts
import { SoroWillClient, createAlbedoAdapter } from '@sorowill/sdk';

const client = new SoroWillClient({
  network: 'testnet',
  contractId: 'C...',
  wallet: createAlbedoAdapter(),
});
```

Supporting another wallet (xBull, Rabet, Lobstr, …) is just a matter of implementing the two `WalletAdapter` methods and passing your object as `wallet`.

## Wallet adapters

All adapters implement `WalletAdapter`, whose `connect`, `disconnect`,
`isConnected`, `getPublicKey`, and `signTransaction` methods make it possible
to switch wallets without changing application transaction code.

```ts
import { HanaWalletAdapter, HotWalletAdapter } from '@sorowill/sdk';

const hana = new HanaWalletAdapter(hanaProvider);
const hot = new HotWalletAdapter(hotProvider);
const connection = await hana.connect();
```

Hana and HOT accept injected providers. Explicit injection supports browser
extensions, embedded webviews, and mini-app environments while keeping wallet
permissions under the host application's control.

### Pairing LOBSTR

LOBSTR is primarily a mobile wallet, so `LobstrWalletAdapter` accepts a
WalletConnect-compatible session client. Calling `connect()` creates a pairing
and reports its URI through `onPairingUri`; desktop applications should render
that URI as a QR code. Applications may also use `openDeepLink` to open the
generated `lobstr://wallet-connect?uri=...` link on the same mobile device.
`connect()` resolves only after LOBSTR approves the session.

```ts
const lobstr = new LobstrWalletAdapter({
  client: walletConnectSession,
  onPairingUri: (uri) => showQrCode(uri),
  openDeepLink: (link) => window.location.assign(link),
});
await lobstr.connect();
```

### Connecting Ledger

Create a Ledger transport appropriate to the environment (WebUSB, WebHID, or
Node) and pass it to `LedgerWalletAdapter`. The default Stellar derivation path
is `44'/148'/0'`. `signTransaction()` sends the transaction signature base to
the Stellar app and remains pending while the device displays the confirmation
screen; it resolves with signed XDR only after the user physically approves.

```ts
const ledger = new LedgerWalletAdapter({
  transport,
  network: 'testnet',
  networkPassphrase: Networks.TESTNET,
});
await ledger.connect();
const signedXdr = await ledger.signTransaction(unsignedXdr, {
  networkPassphrase: Networks.TESTNET,
});
```
The SDK also exports a shared `WalletAdapter` interface, `FreighterWalletAdapter`, and a generic `WalletConnectAdapter` for WalletConnect-compatible Stellar wallets.

## Cache and persistence

Read methods are cached in memory by default. You can disable caching with `readCache: false`, or persist cached reads across reloads with:

- `LocalStorageCachePersistenceAdapter`
- `IndexedDbCachePersistenceAdapter`

If you already have a contract event stream, pass it as `eventSource` and cached will reads will be invalidated automatically when matching will events arrive.

## Local Setup

```bash
git clone https://github.com/SoroWill/sorowill-sdk.git
cd sorowill-sdk
npm install
npm run typecheck
npm test
npm run build
```

## Contributing via Drips Wave

This repo participates in the **Stellar Wave Program** on [Drips](https://drips.network/wave). Maintainer-tagged issues carry Point values, and contributors who resolve them during an active Wave earn a proportional share of that Wave's reward pool. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the contribution workflow, and <https://drips.network/wave> for how Wave itself works.
