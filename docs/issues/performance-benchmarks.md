# Add performance benchmarks for SDK operations

_Tracks [GitHub #743](https://github.com/SoroWill/sorowill-sdk/issues/743)._

## Description

The SDK has no performance baseline, so regressions in its hot paths go
unnoticed and there is nothing to measure optimizations against.

## Evidence

- There is no benchmark tooling in the repo: no `bench` script in
  `package.json`, no `*.bench.ts` files, and nothing benchmark-related in
  `vitest.config.ts`. `scripts/` contains only `smoke-test.mjs`.
- Vitest (already a dev dependency) ships `vitest bench` (tinybench), so no new
  dependency is needed.
- Operations named in the issue, and where they live in `src/SoroWillClient.ts`:
  - Will creation: `createWill` (line 1575), `batchCreateWill` (2103)
  - Check-in: `checkIn` (1654), `batchCheckIn` (2125)
  - Claim: the SDK has no `claimWill` method. The claim path is
    `releaseInheritance` (1876), which also checks that beneficiaries'
    accounts are funded before submitting.

## Scope

The benchmarks measure **SDK-side cost only**: argument validation, ScVal
encoding, transaction building, simulation-result handling, cache/queue
overhead. RPC and wallet are mocked with fixed or zero latency. Network
latency is out of scope because it is noisy and the SDK doesn't control it.

## Suggested acceptance criteria

- [ ] Add `test/bench/` with `vitest bench` suites:
  - [ ] `createWill.bench.ts`: 1, 5 and max beneficiaries, plus
        `batchCreateWill` at a few batch sizes.
  - [ ] `checkIn.bench.ts`: `checkIn` and `batchCheckIn`.
  - [ ] `claim.bench.ts`: `releaseInheritance`, including the
        beneficiary-funding check.
- [ ] Share mocks for the RPC server and wallet adapter so every benchmark runs
      against the same deterministic stubs.
- [ ] Add a `"bench": "vitest bench --run"` script. Keep benchmarks out of
      `npm test` so CI test time is unchanged.
- [ ] Track performance across versions:
  - [ ] Write results as JSON (`vitest bench --outputJson`) to
        `bench/results/<version>.json`, or upload them as a CI artifact.
  - [ ] Add a compare step (`vitest bench --compare <baseline.json>`) that
        reports the change against the last release baseline.
  - [ ] Agree on a regression threshold (for example >20% slower ops/sec)
        and decide whether crossing it warns or fails CI.
- [ ] Document how to run and compare benchmarks in `CONTRIBUTING.md`.

## Open questions

- Should results be committed per release, or kept only as CI artifacts?
- Is a failing CI gate wanted, or a report only? Shared CI runners are noisy,
  so a report-only first version is the safer start.
