# Test fee bump transaction failures and recovery

_Tracks [GitHub #741](https://github.com/SoroWill/sorowill-sdk/issues/741)._

## Description

No tests cover fee-bump failure paths, or recovery from them, from start to
finish. Today's tests cover the happy path and option handling.

## Evidence

Code in `src/feeBump.ts`:

- `submitFeeBumpTransaction` (380):
  - Throws on an `ERROR` send status (400) and on `TRY_AGAIN_LATER` (407).
  - Polls `PENDING`/`DUPLICATE` results.
  - Calls `trackFailedFeeBumpSequence` when the final status isn't `SUCCESS`
    (424).
- `submitFeeBump` (451) refuses a retry that would reuse a consumed sequence
  number (477). `validateInnerTransactionSequence` throws
  `StaleTransactionSequenceError` (648).
- `autoFeeBumpOnTimeout` (554) waits `timeoutMs`, checks the original's
  on-chain status, and bumps only while the original is still pending.
- `assertReasonableFeeBumpFee` throws `ExorbitantFeeError`, and
  `refreshFeeEstimateIfStale` re-estimates stale fees.

Gaps:

- The SDK doesn't handle insufficient balance for fee bumps: there are no
  `insufficient`/`txInsufficientBalance` checks in `feeBump.ts`. A fee source
  that can't pay surfaces only as the generic "submission failed (error: <XDR>)"
  message.

Existing tests:

- `test/feeBump.test.ts`, `test/fee-bump-auto-resubmit.test.ts`,
  `test/issue-614-fee-reestimation.test.ts` and
  `test/issue-719-ledger-fee-bump.test.ts` don't cover failure-then-retry
  sequences.

## Suggested acceptance criteria

New file: `test/fee-bump-failure-recovery.test.ts`, with a mocked RPC pool and
fake timers.

- [ ] **Insufficient balance for fee bump**:
  - [ ] Mock `sendTransaction` returning `ERROR` with a
        `txInsufficientBalance` / `txInsufficientFee` result.
  - [ ] Assert the thrown error names the problem (fee source can't cover the
        fee) with a recovery step (fund the fee source), not raw XDR. This may
        need a small source change: a typed `InsufficientFeeBalanceError`. See
        [`error-message-clarity-tests.md`](./error-message-clarity-tests.md).
- [ ] **Fee bump timeout**:
  - [ ] `autoFeeBumpOnTimeout`:
    - [ ] When the original is still pending, the bump is submitted.
    - [ ] When the original resolves during the wait, no bump is sent.
    - [ ] When polling the bump times out, the error is clear.
  - [ ] `TRY_AGAIN_LATER` surfaces as a retryable `SoroWillError`.
- [ ] **Retry after fee bump failure**:
  - [ ] After a failed bump, retrying with the same inner sequence is rejected
        (`isFeeBumpSequenceReused`).
  - [ ] Retrying with a rebuilt inner transaction (fresh sequence) is allowed.
  - [ ] A stale fee estimate is refreshed before the retry.
  - [ ] Call `resetFailedFeeBumpSequences()` in `beforeEach` so the
        module-level set doesn't leak state between tests.
- [ ] **Verify transaction eventually succeeds**: one scripted sequence (first
      bump fails, then rebuild, re-estimate and resubmit) ends with `SUCCESS`
      and returns the expected hash. Assert the original operation is never
      applied twice.
