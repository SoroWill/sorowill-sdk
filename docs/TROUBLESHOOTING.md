# Troubleshooting

Common `@sorowill/sdk` errors, what causes them, and how to fix them.

## Identifying an error

Every error the SDK raises on purpose extends `SoroWillError`. Errors returned by the contract extend `WillContractError` and include the contract's numeric `code`:

```ts
import { RequestTimeoutError, SoroWillError, WillContractError } from '@sorowill/sdk';

try {
  await client.checkIn(willId);
} catch (error) {
  if (error instanceof WillContractError) {
    console.error(`Contract rejected the call: ${error.name} (code ${error.code})`);
  } else if (error instanceof RequestTimeoutError) {
    console.error(`RPC timed out after ${error.timeoutMs}ms`);
  } else if (error instanceof SoroWillError) {
    console.error('SDK error:', error.message);
  } else {
    console.error('Wallet, network, or unexpected error:', error);
  }
  // The original RPC error is kept on `cause`:
  console.error((error as Error).cause);
}
```

## Contract errors

| Code | Error class | Cause | Fix |
|---|---|---|---|
| 1 | `WillNotFoundError` | No will with this ID exists on this contract | Check the `willId` and make sure `contractId` and `network` match where the will was created |
| 2 | `NotOwnerError` | The connected wallet isn't the will's owner | Switch to the owner account in the wallet. Compare `will.owner` with `await getPublicKey()` |
| 3 | `WillNotActiveError` | The will is `Triggered`, `Released`, or `Cancelled` | Read `will.status` first. If it's `Triggered`, the owner should call `emergencyCheckIn` instead of `checkIn` |
| 4 | `WillNotTriggeredError` | `releaseInheritance` or `emergencyCheckIn` was called on a will that isn't `Triggered` | Call `triggerWill` first (after the check-in deadline) |
| 5 | `GracePeriodNotExpiredError` | `releaseInheritance` was called before the grace period ended | Wait until `will.triggerTime + gracePeriodDays` |
| 6 | `GracePeriodExpiredError` | `emergencyCheckIn` was called after the grace period ended | The owner can no longer stop the release. The will can now be released |
| 7 | `InvalidPercentagesError` | Beneficiary percentages don't sum to 100 | Run `validateBeneficiaries()` before you submit. Percentages must be positive integers |
| 8 | `AlreadyVotedError` | This guardian already voted in the current release cycle | No action needed. A second, different guardian has to vote |
| 9 | `NotGuardianError` | The caller isn't one of the will's guardians | Connect a wallet whose address is in `will.guardians` |
| 10 | `CheckinNotDueError` | `triggerWill` was called before the check-in deadline | Check with `isCheckinDue(will)`. Ledger time can trail your local clock by a few seconds, so allow a small buffer |
| 11 | `ZeroAmountError` | `amount` is `0` in `createWill` or `topUp` | Pass a positive base-unit amount, e.g. `toStroops('10').toString()` |
| 12 | `TooManyBeneficiariesError` | More than 10 beneficiaries or more than 3 guardians | Reduce the list |

## Wallet errors

### `No Freighter account is connected. Call connectWallet() first.`

A write method was called before the user connected Freighter.

1. Check that Freighter is installed: `await isFreighterInstalled()`.
2. Call `await connectWallet()` once, after a user action such as a button click.
3. Unlock Freighter if it's locked.

### The user rejected the request, or the signature prompt never appears

- The user clicked "Reject" in the wallet. Catch the error and let them try again. Don't retry automatically.
- Pop-up blockers can hide the wallet window. Call write methods from a click handler.
- Ledger: `signTransaction` doesn't resolve until the user physically approves on the device. Make sure the Stellar app is open and "blind signing" / contract data is enabled in the app settings.
- LOBSTR or WalletConnect: `connect()` doesn't resolve until the mobile wallet approves the pairing. Check that `onPairingUri` actually shows a QR code.

### Network mismatch / `tx_bad_auth`

The wallet is on a different network from the client (for example Freighter on Mainnet while the client uses `network: 'testnet'`). Switch the wallet's network, or create the client with the matching `network`.

## Transaction and RPC errors

### `SoroWill simulation failed for <method>: ...`

The RPC couldn't simulate the call. Common causes:

- The contract would reject it. The SDK usually turns these into a typed error from the table above. If you see this raw message, check the text for `Error(Contract, #N)` and look up `N` in the table.
- The account doesn't exist on this network. Fund it (on testnet, use Friendbot).
- Not enough token balance or trustline for `createWill` / `topUp`. The owner needs a USDC trustline and enough balance.
- Wrong `contractId` for the selected network.

### `SoroWill RPC call <label> failed after N attempts: ...`

Every retry failed. Usually the network or the endpoint is the problem.

1. Check that the endpoint responds: `curl -X POST <rpcUrl> -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}'`.
2. If you see HTTP 429 (rate limited), lower `requestsPerSecond`. See [BEST_PRACTICES.md](./BEST_PRACTICES.md#rate-limiting).
3. Add a fallback endpoint with `rpcUrls: [primary, backup]`.
4. Raise `retry.maxAttempts` if the network is unreliable.

### `RequestTimeoutError: SoroWill RPC request timed out after Xms`

A single request took longer than `timeoutMs` (30 seconds by default).

- Pass a longer timeout for slow calls: `client.getWill(id, { timeoutMs: 60_000 })`.
- If many calls time out at once, the queue may be backed up. Look for loops that fire many reads, and run them with `Promise.all` on a shared client.
- A write that times out **may still confirm on-chain**. Look up the transaction (or re-read the will) before you submit it again, so it doesn't run twice.

### `SoroWill invocation aborted by beforeInvoke hook for <method>`

One of your `onBeforeInvoke` hooks returned `false`. That cancels the call on purpose. Check your hook logic.

### `SoroWill transaction for <method> did not succeed: FAILED`

The transaction was submitted but failed on-chain. This usually means the state changed between simulation and submission (for example, someone else triggered the will). Re-read the will and decide again.

### `Prepared transaction for <method> did not match the intended operation`

As a safety check, the SDK compares the transaction the RPC prepared with the one it built. If they differ, the RPC endpoint returned something unexpected. Switch to a trusted RPC provider, and report the problem if it keeps happening.

### `A batch must contain at least one operation`

`client.batch([])` was called. Check for an empty list before you call it.

## Configuration errors

| Message | Fix |
|---|---|
| `SOROWILL_NETWORK must be set to "testnet" or "mainnet"` | Set the env var before calling `SoroWillClient.fromEnv()` |
| `SOROWILL_CONTRACT_ID must be set` | Set the contract address env var |
| `At least one RPC URL must be configured` | `rpcUrls` was empty or contained only blank strings |
| `maxConcurrent must be a positive integer` / `requestsPerSecond must be a positive integer` | Use whole numbers ≥ 1 |
| `timeoutMs must be greater than zero` | Use a positive timeout |
| `Invalid USDC amount: "..."` | `toStroops` got a non-numeric string. Strip currency symbols first |
| `Invalid pagination cursor` / `pageSize must be a positive integer` | Pass back the `nextCursor` exactly as you received it, and use an integer `pageSize` |

## Stale or unexpected data

- **A read doesn't show a change made elsewhere.** Reads are cached for 60 seconds by default. Use a shorter `readCache.ttlMs`, pass an `eventSource`, or set `readCache: false` for screens where decisions depend on current state.
- **Amounts look 10,000,000× too big.** Amounts are base units with 7 decimals. Use `formatUSDC(BigInt(will.balance))` to display them and `toStroops('1.5')` to parse user input.
- **`nextDeadline` is a little off from your expectation.** It's computed from the ledger close time, not your local clock.

## Debugging steps

1. **Check the configuration.** Log `network`, `contractId`, and the wallet's network. Most "not found" and auth problems come from a mismatch between them.
2. **Read the will.** `console.log(await client.getWill(id))` shows `status`, `lastCheckin`, `triggerTime`, and `owner`. Compare them with what the call needs.
3. **Look at the cause chain.** Log `error.cause`. It contains the raw RPC or simulation response.
4. **Log every contract call with hooks:**

   ```ts
   import { HookManager, SoroWillClient } from '@sorowill/sdk';

   const hooks = new HookManager();
   hooks.onBeforeInvoke(({ method, args }) => console.debug('→', method, args));
   hooks.onAfterInvoke(({ method, txHash, error, durationMs }) =>
     console.debug('←', method, { txHash, error, durationMs }),
   );

   const client = new SoroWillClient({ network: 'testnet', contractId: 'C...', hooks });
   ```

5. **Inspect the transaction.** Paste the `txHash` into [Stellar Expert](https://stellar.expert/explorer/testnet) or [Stellar Lab](https://lab.stellar.org/) to see the on-chain result and events.
6. **Turn off caching** (`readCache: false`) to rule out stale reads.
7. **Try it on testnet** with short `checkinPeriodDays` / `gracePeriodDays` before mainnet.

## Getting help

- **Bugs and feature requests:** [open an issue](https://github.com/SoroWill/sorowill-sdk/issues/new) on GitHub. Include the SDK version (`npm ls @sorowill/sdk`), the network, the method you called, the full error with its `cause`, and the `txHash` if there is one.
- **Questions:** search [existing issues](https://github.com/SoroWill/sorowill-sdk/issues) first. Someone may have hit the same problem.
- **Security vulnerabilities:** don't open a public issue. Use [GitHub private vulnerability reporting](https://github.com/SoroWill/sorowill-sdk/security/advisories/new) instead.
- **Contributing a fix:** see [CONTRIBUTING.md](../CONTRIBUTING.md).

> Never share secret keys, seed phrases, or private RPC API keys in an issue or log output.
