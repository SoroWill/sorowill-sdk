# Document all public API with TSDoc and examples

_Tracks [GitHub #752](https://github.com/SoroWill/sorowill-sdk/issues/752)._

## Description

The public API surface (everything re-exported from `src/index.ts` and
`src/react/index.ts`) is only partly documented. Many exports have a one-line
summary, or nothing at all. Very few have usage examples or `@param` /
`@returns` tags. The generated TypeDoc reference (`npm run docs:api`) is
therefore thin: users can see signatures, but they get no guidance on how to
call things or what comes back.

## Evidence

Measured over the top-level `export function|class|const` declarations in
`src/` (test files excluded; type-only exports and class members are not
counted):

| Metric                              | Count     |
| ----------------------------------- | --------- |
| Exported runtime declarations       | 314       |
| With any `/** ... */` block         | 227 (72%) |
| With an `@example`                  | 14 (4%)   |
| With `@param` tags                  | 18        |
| With `@returns` tag                 | 7         |

The biggest gaps, by file:

- `src/errors.ts`: 47 of 97 documented, and 4 with examples. Most error
  classes say nothing about when they are thrown or how to catch them.
- `src/config.ts`: 0 of 3 documented (`DEFAULT_NETWORK`,
  `getDefaultContractId`, `resolveSoroWillConfig`).
- `src/rpc.ts`: 8 of 13. `src/wallet.ts`: 21 of 27. `src/walletConnect.ts`: 4 of 7.
- `src/SoroWillClient.ts`: 5 of 8 top-level exports documented, and none have
  examples. This is the main entry point of the SDK. Its class methods
  (`createWill`, `checkIn`, `claimWill`, `fundWill`, `cancelWill`, …) are not
  in the counts above and need their own audit.
- `src/react/hooks.tsx` is the one area in good shape (6 of 6 documented,
  5 with examples). Use it as the reference style.

Also, `typedoc.json` has no `validation` settings, so new undocumented
exports are never flagged.

## Documentation standard

Every public export should have:

1. **Summary.** One sentence on what it does, then any non-obvious behaviour
   (side effects, network calls, caching, retries).
2. **`@param`** for every parameter, including the fields of option objects
   whose meaning is not obvious from the type.
3. **`@returns`**, saying what the resolved value is (for promises, the
   resolved value, not just "a Promise").
4. **`@throws`**, listing the specific `SoroWillError` subclasses a caller may
   want to handle.
5. **`@example`**: a short, runnable snippet that imports from
   `@sorowill/sdk` (not from relative paths).
6. **`@category`**, matching `typedoc.json`'s `categoryOrder` (`Client`,
   `Wallet`, `Types`, `Utilities`, `Errors`).

Parameter types come from the TypeScript signature, and TypeDoc renders them
automatically. Do not repeat types in `{braces}` inside `@param` tags.

### Reference example

````ts
/**
 * Records an owner check-in, resetting the will's inactivity deadline.
 *
 * Simulates, signs (via the configured wallet adapter) and submits the
 * transaction, then waits for confirmation.
 *
 * @param willId - ID of the will to check in on. Must be owned by the
 *   connected wallet.
 * @param options - Optional per-request settings (timeout, abort signal).
 * @returns The updated {@link Will}, with its new `lastCheckin` timestamp.
 * @throws {@link NotOwnerError} if the connected wallet does not own the will.
 * @throws {@link WillNotActiveError} if the will has been released or cancelled.
 * @throws {@link WalletCancelledError} if the user rejects the signing prompt.
 *
 * @example
 * ```ts
 * import { SoroWillClient } from '@sorowill/sdk';
 *
 * const client = new SoroWillClient({ network: 'testnet' });
 * const will = await client.checkIn(42n);
 * console.log('Next deadline:', will.nextDeadline);
 * ```
 *
 * @category Client
 */
````

For error classes, the example shows how to catch the error:

````ts
/**
 * Thrown when a check-in is attempted before the current period allows it.
 *
 * @example
 * ```ts
 * try {
 *   await client.checkIn(willId);
 * } catch (err) {
 *   if (err instanceof CheckinNotDueError) {
 *     showToast('You are already checked in for this period.');
 *   } else {
 *     throw err;
 *   }
 * }
 * ```
 *
 * @category Errors
 */
````

## Implementation plan

1. **Turn on enforcement first** so the gaps show up as a list:
   ```jsonc
   // typedoc.json
   "validation": { "notExported": true, "invalidLink": true, "notDocumented": true },
   "requiredToBeDocumented": ["Class", "Function", "Method", "Variable", "Interface", "TypeAlias", "Enum"]
   ```
   Run `npx typedoc --treatValidationWarningsAsErrors` to get the full list
   of missing docs, class methods included.
2. **Work in priority order:** `SoroWillClient` methods, then wallet and
   adapters, then errors, then config and utilities, then the rest.
3. **Add `eslint-plugin-tsdoc`** to `eslint.config.js` to catch malformed
   tags (`tsdoc/syntax`).
4. **Gate CI:** add a `docs:check` script
   (`typedoc --emit none --treatValidationWarningsAsErrors`) and run it in CI
   so coverage can't regress.
5. **Optional:** type-check the `@example` blocks by extracting them into a
   temporary `.ts` file and running `tsc --noEmit` on it, so examples don't
   go stale.

## Acceptance criteria

- [ ] Every function, class, and constant exported from `src/index.ts` and
      `src/react/index.ts` has a TSDoc block. Every public method of
      `SoroWillClient` has one too.
- [ ] Every function and method has an `@example`.
- [ ] Every parameter has an `@param` description. Types are shown by
      TypeDoc from the signature.
- [ ] Every non-`void` function or method has `@returns`. Async methods
      describe the resolved value.
- [ ] Error classes say when they are thrown and show a `catch` example.
- [ ] `typedoc --treatValidationWarningsAsErrors` passes, and runs in CI.
