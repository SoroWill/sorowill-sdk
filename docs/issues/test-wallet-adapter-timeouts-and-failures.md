# Test wallet adapter timeouts and failures

_Tracks [GitHub #738](https://github.com/SoroWill/sorowill-sdk/issues/738)._

## Description

The wallet adapter layer (`src/wallet.ts`, `src/adapters/`) defines typed
errors for timeout and failure scenarios (`SignTransactionTimeoutError`,
`WalletCancelledError`, `WalletSessionError`, `WalletNetworkMismatchError`,
`FreighterInstallCheckError`, etc.) and contracts around when each should be
thrown. However, the cross-adapter test coverage for those error paths is
uneven: several failure modes that the `WalletAdapter` interface documents as
required behaviour are tested only within individual adapter files and have no
shared scenario test that exercises them through the full SDK invocation path.

Gaps include:

- **`signTransaction` timeout**: a wallet that hangs past its `timeoutMs`
  should produce a `SignTransactionTimeoutError`. `LedgerWalletAdapter` has
  this guard internally, but no test verifies the error propagates to a
  `SoroWillClient.invoke()` / `submit()` call and that the client surfaces it
  without wrapping it in a generic `InvokeFailedError`.
- **User cancellation**: a wallet that rejects with `WalletCancelledError`
  should propagate unchanged. No test validates that the client lets it
  through rather than re-wrapping it.
- **Session expiry during signing**: `WalletSessionError` thrown by a session-
  based adapter mid-invoke should reach the caller as-is.
- **`isConnected()` failures**: an adapter whose `isConnected()` throws a
  `FreighterInstallCheckError` should not silently succeed.
- **`connect()` network mismatch**: `WalletNetworkMismatchError` from `connect()`
  should propagate to the caller of whatever method triggered the connection.

## Evidence

- `src/wallet.ts` documents the full error contract in JSDoc on
  `WalletAdapter` and its methods (lines ~380–520) but no corresponding
  integration-level test file covers the full matrix.
- Existing test coverage is at the adapter-unit level (`test/adapters.test.ts`,
  `test/issue-524-wallet-adapter-error-types.test.ts`) or mocks the wallet at
  the wrong layer (after `SoroWillClient` has already normalized the error).
- `src/wallet.ts` exports type guards (`isWalletCancelledError`,
  `isSignTransactionTimeoutError`, `isWalletNetworkMismatchError`,
  `isWalletSessionError`) specifically so callers can distinguish these errors —
  confirming the intent that they propagate rather than being re-wrapped.

## Suggested acceptance criteria

- [ ] Add a test file `test/issue-738-wallet-adapter-timeouts-and-failures.test.ts`
      covering the following scenarios end-to-end (wallet injected via the
      `wallet` option on `SoroWillClient`):
  1. A wallet whose `signTransaction` does not resolve within `timeoutMs` causes
     the client's write operation to reject with `SignTransactionTimeoutError`.
  2. A wallet that calls `reject(new WalletCancelledError(...))` causes the
     client's write operation to reject with that exact `WalletCancelledError`
     instance, not an `InvokeFailedError` wrapper.
  3. A wallet that throws `WalletSessionError` from `signTransaction` causes the
     client's write operation to reject with `WalletSessionError`.
  4. A wallet that throws `WalletNetworkMismatchError` from `connect()` causes
     the first state-changing client call to reject with
     `WalletNetworkMismatchError`.
  5. `isWalletCancelledError`, `isSignTransactionTimeoutError`,
     `isWalletNetworkMismatchError`, and `isWalletSessionError` each return
     `true` for their respective error type and `false` for every other type in
     the union.
- [ ] All five scenarios should use a minimal stub `WalletAdapter`
      (implementing only `isConnected`, `connect`, `reconnect`, `disconnect`,
      `getPublicKey`, `signTransaction`) rather than any real wallet library.
- [ ] No real RPC calls; stub `rpcServer` via `SoroWillClientOptions.rpcServer`.

## Implementation notes

The simplest stub pattern:

```ts
import { WalletCancelledError, WalletSessionError, SignTransactionTimeoutError }
  from '../src/errors';
import type { WalletAdapter, WalletConnection, SignTransactionOptions }
  from '../src/wallet';

function makeWallet(
  signImpl: () => Promise<string>,
): WalletAdapter {
  return {
    async isConnected() { return true; },
    async connect(): Promise<WalletConnection> {
      return { publicKey: 'G...', network: 'testnet', networkPassphrase: '...' };
    },
    async reconnect() { return this.connect(); },
    async disconnect() {},
    async getPublicKey() { return 'G...'; },
    signTransaction: signImpl,
  };
}

// Timeout scenario:
const hangingWallet = makeWallet(
  () => new Promise(() => {}), // never resolves
);
// Pass to SoroWillClient with a short timeoutMs to verify SignTransactionTimeoutError.

// Cancellation scenario:
const cancellingWallet = makeWallet(async () => {
  throw new WalletCancelledError('user rejected');
});
```

For the network-mismatch scenario, `connect()` should throw before
`signTransaction` is called:

```ts
function makeMismatchWallet(): WalletAdapter {
  return {
    ...baseWallet,
    async connect() {
      throw new WalletNetworkMismatchError('Test SDF Network ; September 2015', 'Public Global Stellar Network ; September 2015');
    },
  };
}
```

After writing the tests, verify they all pass with `npx vitest run
test/issue-738-wallet-adapter-timeouts-and-failures.test.ts`.
