# Test React hook behavior under StrictMode

_Tracks GitHub #748._

## Description

The React bindings exported from `@sorowill/sdk/react` must behave correctly
when rendered inside `<React.StrictMode>`. In development, StrictMode
double-invokes render functions and runs every effect's
mount → cleanup → mount cycle, which surfaces double-initialization,
leaked subscriptions, and use-after-destroy bugs that never appear in
production.

## Evidence

- Existing coverage is partial: `test/react-hooks.test.tsx:165`, `:200`, and
  `:235` render `useWill`, `useWillsByOwner`, and `useWillsByBeneficiary`
  under `StrictMode`, but only assert the final `data`/`error`/`loading`
  state. They do not check how many clients were constructed or destroyed,
  or how many RPC calls were made.
- `useWallet` (`src/react/hooks.tsx:75`) and `WalletConnectionDialog`
  (`src/react/hooks.tsx:165`) have no StrictMode tests.
- Likely use-after-destroy in `useSoroWillClient`
  (`src/react/hooks.tsx:223-263`): the comment says StrictMode's simulated
  unmount must not destroy the memoized client, but the second effect
  (`:249`) still calls `client.destroy()` in its cleanup. Under StrictMode
  that cleanup runs once before the remount, and `useMemo` then returns the
  same, now destroyed, instance.
- `useSoroWillClient` is not re-exported from `src/react/index.ts`. Decide
  whether it is public API before writing tests against it.

## Suggested acceptance criteria

- [ ] Add `test/react-strict-mode.test.tsx` that renders every exported hook
      and `WalletConnectionDialog` inside `StrictMode`.
- [ ] **No double initialization:** assert how many `SoroWillClient`
      instances get constructed per mount, and that a client still in use
      is never left in a destroyed state after StrictMode's
      cleanup → remount.
- [ ] **Hooks work correctly:** `useWill`, `useWillsByOwner`, and
      `useWillsByBeneficiary` resolve `data` and `error` the same way with
      and without StrictMode. `refetch` starts exactly one new request.
- [ ] **Effects don't interfere:** an in-flight request from the discarded
      first effect run is aborted or ignored, so it never overwrites state
      from the second run. Changing `willId`, owner, or beneficiary mid-flight
      leaves no stale result. `useWallet.connect()` / `retry()` do not
      trigger duplicate wallet prompts.
- [ ] Unmounting a StrictMode tree destroys every client exactly once, and
      no event listeners or timers are left behind.
- [ ] Fix the `useSoroWillClient` destroy-on-cleanup issue if the new tests
      confirm it.
