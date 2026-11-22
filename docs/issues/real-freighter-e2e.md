# Test with the real Freighter extension in a browser

_Tracks [GitHub #750](https://github.com/SoroWill/sorowill-sdk/issues/750)._

## Description

All Freighter coverage today is unit-level. `@stellar/freighter-api` is
replaced with `vi.mock(...)` in 17 places across `test/` (for example
`test/wallet.test.ts`, `test/issue-524-wallet-adapter-error-types.test.ts`,
and `test/subscribe-events-timeout.test.ts`), and the suite runs in
`environment: 'node'`. So nothing verifies that `FreighterWalletAdapter`,
`connectWallet`, `signTransaction`, or the network-mismatch checks work
against the real extension. Regressions in the extension's message protocol,
permission prompts, or `freighter-api` version drift (currently `^6.0.1`, an
optional peer dependency) would not be caught.

## Approach

Use **Playwright** with Chromium and a **persistent context that loads the
unpacked Freighter extension**. This suite is separate from `npm test`
because it is slow, needs network access, and depends on Stellar testnet.

```
test/e2e/freighter/
  fixtures.ts            # launches Chromium with the extension and exposes the popup page
  onboard.ts             # imports the test account into Freighter, sets password and network
  harness/index.html     # minimal page that bundles @sorowill/sdk (built from dist/)
  connect.e2e.ts
  sign.e2e.ts
  network.e2e.ts
playwright.freighter.config.ts
```

### Setup

- **Extension build:** download a pinned Freighter release (`.zip` from the
  `stellar/freighter` GitHub releases), checksum it, and unpack it into
  `.cache/freighter/<version>`. Pin the version in an env var or config so
  extension upgrades are deliberate.
- **Launch:**
  ```ts
  chromium.launchPersistentContext(userDataDir, {
    headless: false, // MV3 extensions need headed mode or --headless=new
    args: [
      `--disable-extensions-except=${extPath}`,
      `--load-extension=${extPath}`,
    ],
  });
  ```
  On CI, run headed under `xvfb-run`.
- **Extension ID:** read it from the service worker URL
  (`context.serviceWorkers()[0].url()`), then open
  `chrome-extension://<id>/index.html` to drive the extension's own UI.
- **Test account:** a throwaway testnet keypair, generated per run and
  funded through Friendbot. Its mnemonic or secret is passed via environment
  variable and never committed. `onboard.ts` imports it through the
  extension's onboarding screens.
- **Harness page:** serve `harness/index.html` from a local static server
  (`http://localhost:<port>`). Freighter injects into `http(s)` pages, not
  `file://`. The page exposes `window.sdk` for the tests to call.

### Test cases

**Wallet connection** (`connect.e2e.ts`)
- `isFreighterInstalled()` resolves to `true` with the extension, and to
  `false` in a plain context without it.
- `connectWallet()` opens the Freighter access prompt. The test clicks
  Approve in the popup, and the result is the onboarded public key.
- Rejecting the prompt rejects with an error for which
  `isUserCancellationError()` is true.
- Without unlocking, `connectWallet()` surfaces a
  `FreighterConnectionTimeoutError` within
  `DEFAULT_FREIGHTER_CONNECT_TIMEOUT_MS`.

**Signing flow** (`sign.e2e.ts`)
- Build a real `createWill` transaction against the testnet contract
  (`DEFAULT_CONTRACT_IDS.testnet`) and call `signTransaction()`. The test
  approves in the popup. The returned XDR passes
  `assertSignedTransactionXdrSignatures()` for the onboarded key.
- Submit the signed transaction and assert the will can then be read back
  with `client.getWill()`. This is a full round trip.
- Rejecting the signature yields `WalletCancelledError`.
- Leaving the popup untouched yields `SignTransactionTimeoutError`.

**Network switching** (`network.e2e.ts`)
- With Freighter on Testnet and the client on `testnet`, signing succeeds.
- Switch Freighter to Mainnet in its settings UI. The next SDK call rejects
  with `WalletNetworkMismatchError`, and `isWalletNetworkMismatchError()`
  is true. The SDK must not submit anything.
- Switch back to Testnet and retry. The call succeeds without reconnecting.
- If the adapter exposes network-change events, assert they fire on the
  switch.

### CI

- Add the `test:e2e:freighter` script:
  `playwright test -c playwright.freighter.config.ts`.
- Run it in a separate GitHub Actions job, nightly and on demand
  (`workflow_dispatch`). It also runs on PRs that touch `src/wallet.ts`,
  `src/adapters/**`, or the `@stellar/freighter-api` version.
- Retry once on failure, because testnet and Friendbot can be flaky. Upload
  Playwright traces and screenshots as artifacts.
- Do not make it a required check until it has been stable for two weeks.

### Risks

- The selectors in Freighter's UI are not a public API. Keep them in one
  page-object file so an extension upgrade touches only that file.
- Testnet resets wipe accounts and contract state. Fund accounts in each
  run, and resolve the contract ID from config, not a hard-coded value.

## Acceptance criteria

- [ ] The tests run in Chromium with the real, pinned Freighter extension
      loaded. No Freighter mocks are used.
- [ ] Connection is tested: approve, reject, and timeout paths.
- [ ] Signing is tested: a real transaction is signed in Freighter, its
      signature is validated, and it is submitted to testnet. Reject and
      timeout paths are tested too.
- [ ] Network switching is tested: the mismatch is detected and nothing is
      submitted, then the call recovers after switching back.
- [ ] The suite runs in CI as a separate job, and keeps traces on failure.
