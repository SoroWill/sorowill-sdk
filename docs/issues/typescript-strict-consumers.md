# Test TypeScript strict mode compatibility for consumers

_Tracks GitHub #745._

## Description

Users who compile with `"strict": true` (and stricter flags) must be able
to import the SDK's published types without type errors. The SDK's own
source is already strict, but nothing checks what a **consumer** sees,
which is the emitted `.d.ts` files.

## Evidence

- The repo's `tsconfig.json` already enables `strict`,
  `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes`, and CI runs
  `npm run typecheck`. That only covers `src/` and `test/`, not `dist/*.d.ts`.
- It also sets `skipLibCheck: true`. A consumer with `skipLibCheck: false`
  would type-check the SDK's declarations, which are never validated today.
- `package.json` `exports` points `types` at `./dist/index.d.ts` and
  `./dist/react/index.d.ts`. Declaration files can depend on
  `@stellar/stellar-sdk` and `@types/react` types, which a strict consumer
  must be able to resolve.
- The local `dist/` snapshot has no `.d.ts` files. Confirm that a clean
  `npm run build` emits them before you rely on them in a test.

## Suggested acceptance criteria

- [ ] Add a `test/types/strict-consumer/` fixture with its own `tsconfig.json`:
      `strict: true`, `skipLibCheck: false`, `noUncheckedIndexedAccess`,
      `exactOptionalPropertyTypes`, and `moduleResolution` set to both
      `bundler` and `node16` (a matrix or two configs).
- [ ] The fixture imports from the built package (`@sorowill/sdk` and
      `@sorowill/sdk/react`, through the packed tarball or a path mapping
      to `dist/`) and uses the main APIs: construct the client, call
      read/invoke methods, narrow error types, and use the hooks.
- [ ] `tsc --noEmit -p test/types/strict-consumer` exits with no errors.
- [ ] Add negative type assertions (`// @ts-expect-error`) for misuse that
      strict mode should catch, for example passing `undefined` to required
      options.
- [ ] Add a `typecheck:consumer` script and run it in
      `.github/workflows/test.yml` after the `Build` step.
