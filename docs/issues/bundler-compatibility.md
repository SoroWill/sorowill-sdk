# Test ESM/CJS compatibility across bundlers

_Tracks GitHub #747._

## Description

There are no tests that consume the published package through real
bundlers. A change to `exports`, `tsup` options, or `sideEffects` could break
Webpack, Vite, esbuild, or Next.js users without any CI signal.

> Note: the issue says the SDK ships "ESM only". It actually ships **both**
> ESM and CJS (`tsup.config.ts` `format: ['esm', 'cjs']`; `package.json`
> `exports` maps `import` → `.js` and `require` → `.cjs` for both `.` and
> `./react`). Both formats need coverage.

## Evidence

- `scripts/smoke-test.mjs` packs the tarball and imports it from plain Node.
  No bundler is involved.
- `npm run check:exports` (`attw`) validates export resolution, but
  `.github/workflows/test.yml` does not run it.
- The build uses `platform: 'neutral'` with custom `mainFields`/`conditions`
  (`tsup.config.ts:16-19`). Each bundler resolves these differently, which
  makes it the most likely place for breakage.
- `react` is marked external, and the `./react` entry needs `react` to
  resolve from the consumer's tree. Next.js also requires a
  `"use client"` boundary for hook modules.

## Suggested acceptance criteria

- [ ] Add a `test/bundlers/` fixture per tool. Each fixture installs the
      `npm pack` tarball, imports both `@sorowill/sdk` and
      `@sorowill/sdk/react`, and asserts that key exports
      (`SoroWillClient`, `useWill`, …) are defined after the build.
- [ ] **Webpack 5+:** production build of an ESM entry and a CJS
      (`require`) entry.
- [ ] **Vite 4+:** `vite build` (library or app mode), plus a dev-server
      import check if practical.
- [ ] **esbuild:** `--bundle` for `--platform=browser` and
      `--platform=node`, `--format=esm` and `--format=cjs`.
- [ ] **Next.js:** App Router build with a server component importing the
      core client and a `"use client"` component using the React hooks.
- [ ] Verify tree-shaking: importing only a utility doesn't pull in the
      whole client.
- [ ] Add `npm run check:exports` and the bundler job to CI. Bundler jobs
      can run in a separate matrix job so the main test job stays fast.
