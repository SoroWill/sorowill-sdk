# Enforce bundle size < 50KB minified

_Tracks GitHub #746._

## Description

Bundle size has no meaningful budget, so the SDK can grow without anyone
noticing. The goal is to keep the minified bundle under 50KB, report the
gzip size, and fail CI when the budget is exceeded.

## Evidence

- `test/bundle-size-audit.test.ts` already measures the raw and gzip size
  of all four `dist/` outputs. However, it measures **unminified** output
  against a ceiling that keeps being raised: `MAX_BUNDLE_SIZE_KB = 315`,
  raised step by step from 200 (`:27-31`), and `MAX_GZIP_SIZE_KB = 75`.
- `tsup.config.ts` does not set `minify`, so `dist/` never contains
  minified output to measure.
- Current local measurements (`@stellar/stellar-sdk` and `react` external):

  | File                  | Raw     | Minified (esbuild) | Gzip (raw) |
  | --------------------- | ------- | ------------------ | ---------- |
  | `dist/index.js`       | ~374 KB | ~167 KB            | ~88 KB     |
  | `dist/react/index.js` | ~297 KB | ~123 KB            | ~72 KB     |

  **Both entries are already 2–3× over the proposed 50KB budget.**
  The acceptance criterion can't pass without reduction work or a different
  target.
- `splitting: false` (`tsup.config.ts:13`) means `react/index` contains its
  own full copy of the client code, so an app that imports both entries
  ships that code twice.

## Suggested acceptance criteria

- [ ] Agree on the metric: minified size of the ESM entry with dependencies
      external, or a full consumer bundle. Then agree on a realistic
      budget, or plan the reduction work (enable `splitting`, split rarely
      used modules such as Ledger, WalletConnect, and SEP-7 into subpath
      exports, and remove dead code).
- [ ] Add a size check that minifies each entry with esbuild and asserts:
      - minified size < budget (target 50KB)
      - gzip size is recorded and has its own budget
- [ ] Print a size report table in the build output (for example, a
      `postbuild` script or a `size-limit` config).
- [ ] CI fails when any budget is exceeded. Raising a budget should require
      an explicit, reviewed change to the config.
- [ ] Optional: post the size delta as a comment on each PR.
