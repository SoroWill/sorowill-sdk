# Test mobile browser compatibility

_Tracks [GitHub #749](https://github.com/SoroWill/sorowill-sdk/issues/749)._

## Description

The SDK has never been checked on mobile browsers. The only mobile-specific
test is `test/issue-721-lobstr-mobile-deeplink.test.ts`, which runs in Node.
On mobile, Freighter (a desktop extension) is not available. Users connect
through `WalletConnectAdapter`, `LobstrWalletAdapter` (deep link), or SEP-7
URIs (`buildSep7TxUri`). None of these paths has run in a real mobile
browser.

## Evidence: the requested version floors are below what the bundle can run

The issue asks for **iOS Safari 11.3+**, **Chrome Android 64+**, and Firefox
mobile. The current build cannot run on the first two:

- `tsconfig.json` sets `"target": "ES2022"`, and `tsup.config.ts` does not
  set a lower `target`. So modern syntax ships unchanged.
- `dist/index.js` contains about **136 optional-chaining (`?.`)** sites and
  about **45 BigInt** usages (`BigInt(...)` or `123n` literals). Will IDs
  and amounts are `bigint`.
- `@stellar/stellar-sdk`, a hard dependency, also needs native BigInt.

| Feature | iOS Safari | Chrome Android | Firefox Android |
| --- | --- | --- | --- |
| Optional chaining `?.` and `??` | 13.4 | 80 | 79 |
| `BigInt` | 14.0 | 67 | 68 |
| **Practical minimum** | **14.0** | **80** | **79** |

Optional chaining could be transpiled away. **BigInt cannot be polyfilled**:
there is no way to support `123n` literals or `typeof x === 'bigint'`. On
iOS Safari 11.3 and Chrome 64, the bundle fails at parse time with a
`SyntaxError` before any SDK code runs.

**Recommendation:** change the supported floor to **iOS Safari 14+, Chrome
Android 80+, and Firefox Android 79+**, which covers nearly all mobile
traffic today. Document it in the README and in a `browserslist` field. If
the 11.3 and 64 floors are a hard requirement, the issue needs a separate
design decision, because the SDK would have to stop using `bigint` in its
public types (a breaking change). That decision must come before any
testing work.

## Other mobile risks to cover

- **Storage:** `LocalStorageCachePersistenceAdapter` and
  `IndexedDbCachePersistenceAdapter` (`src/cache.ts`). Safari Private
  Browsing and iOS storage eviction can make `localStorage.setItem` throw,
  or make `indexedDB.open` fail. The code silently swallows these errors, so
  the tests should check that it falls back to the in-memory cache and
  doesn't crash.
- **Crypto:** `crypto.getRandomValues` (`src/utils.ts`) and
  `crypto.randomUUID` (`src/debugLogger.ts`, which has a fallback).
  `randomUUID` needs iOS 15.4 or later, so test the fallback on iOS 14.
- **Backgrounding:** mobile browsers suspend tabs during the deep-link round
  trip to LOBSTR or a WalletConnect wallet. WebSocket event subscriptions and
  pending requests must survive or reconnect when the app returns to the
  foreground (`visibilitychange`).
- **Deep links:** LOBSTR and SEP-7 URIs must open the wallet app from a user
  gesture. Safari blocks navigations that aren't triggered by a gesture.
  `SEP7_MAX_URI_LENGTH` must hold on mobile URL limits.

## Test plan

### Tier 1: emulated, every PR (Playwright)

Add a `playwright.mobile.config.ts` with these projects:

- `Mobile Safari`: `devices['iPhone 13']` on **WebKit**.
- `Mobile Chrome`: `devices['Pixel 7']` on **Chromium**.
- `Mobile Firefox`: Firefox with a mobile viewport and touch enabled
  (Playwright has no Firefox Android engine, so this is an approximation).

They load a harness page that imports the built `dist/` ESM bundle and run:

1. **Smoke:** import the SDK, construct `SoroWillClient({ network: 'testnet' })`,
   and call a read (`getWill`) against a mocked RPC route. Assert no
   `SyntaxError` and no unhandled rejections.
2. **BigInt and amount utilities:** `toStroops`, `formatTokenAmount`, and
   `calculateShares` give the same results as in Node.
3. **Cache persistence:** IndexedDB and localStorage round trip. Also stub
   `localStorage.setItem` to throw `QuotaExceededError` and check that the
   SDK degrades gracefully.
4. **Touch interactions:** render `WalletConnectionDialog` and use
   `page.tap()` on Connect, Retry, and Close. Check that the callbacks fire,
   that tap targets are at least 44×44 CSS px, and that the dialog fits a
   360 px viewport without horizontal scroll.
5. **Deep links:** tapping Connect with the LOBSTR adapter triggers a
   navigation to the expected `lobstr://` or universal-link URL, and a
   SEP-7 URI is generated within the length limits.
6. **Backgrounding:** fire `visibilitychange` (hidden, then visible) during
   an open event subscription, and check that it reconnects.

### Tier 2: real devices, nightly or before release (BrowserStack or Sauce Labs)

Run the same Playwright specs on real devices, using the cloud provider's
Playwright integration:

| Browser | Versions |
| --- | --- |
| iOS Safari | 14 (the floor), 16, and latest |
| Chrome Android | 80 (the floor), and latest |
| Firefox Android | 79 (the floor), and latest |

Also add a **negative test**: load the bundle on a browser below the floor
(for example iOS 13) and check that it fails in a documented way, either a
clear `SyntaxError` or a feature-detection message, if one is added.

### Build changes to support this

- Set `target: ['es2020', 'safari14', 'chrome80', 'firefox79']` in
  `tsup.config.ts`, so esbuild lowers any syntax newer than the floor.
- Add `"browserslist": ["ios_saf >= 14", "chrome >= 80", "and_chr >= 80", "firefox >= 79", "and_ff >= 79"]`
  to `package.json`.
- Add a CI check (`es-check es2020 dist/index.js`) so no newer syntax slips
  into the bundle.

## Acceptance criteria

- [ ] The supported mobile floor is decided and documented. The
      recommendation is iOS Safari 14+, Chrome Android 80+, and Firefox
      Android 79+, because the 11.3 and 64 floors are blocked by BigInt.
- [ ] iOS Safari is tested: emulated on WebKit for every PR, and on real
      devices at the floor and latest versions.
- [ ] Chrome Android is tested: emulated on Chromium for every PR, and on
      real devices at the floor and latest versions.
- [ ] Firefox mobile is tested: emulated for every PR, and on real Firefox
      Android devices.
- [ ] Touch interactions are verified: tap targets, callbacks, and the
      viewport fit of `WalletConnectionDialog`, plus deep-link triggers.
- [ ] Storage fallback, crypto fallback, and backgrounding behaviour are
      covered.
- [ ] The build target is pinned to the floor, and `es-check` runs in CI.
