# Contributing to sorowill-sdk

This repo participates in the **Stellar Wave Program** on [Drips](https://drips.network/wave). Contribution work is tied to issues that maintainers tag for an active Wave, and contributors earn rewards proportional to the Points assigned to the issues they resolve.

## Ground rules

- **Do not start work on any issue until you have been assigned by the maintainer.** Applying to an issue does not mean you're assigned — wait for confirmation (via the Drips Wave dashboard or a direct assignment on GitHub) before opening a PR.
- Keep PRs scoped to the issue they resolve. Unrelated changes slow down review and can cost you the Wave window.
- Be responsive during an active Wave — issues must be resolved before the Wave ends for Points to be awarded.

## Branch naming

Use the issue number in your branch name:

```
feat/N-short-description
fix/N-short-description
```

## Pull requests

- Your PR description must reference the issue it resolves (e.g. `Closes #12`).
- Make sure `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build` all pass cleanly before requesting review.
- Add or update unit tests in `test/` for any behavior change to `src/utils.ts` or type validation logic.
- Keep the public API in `src/index.ts` in sync with any new exports.
- **If your PR changes public behavior** (new features, breaking changes, deprecations, or behavioral fixes), add a bullet entry under the `[Unreleased]` section of [`CHANGELOG.md`](./CHANGELOG.md). The release workflow (`publish.yml`) triggers from published GitHub Releases, and the changelog is the authoritative record of what shipped in each version.

## API reference

The full public API reference is generated from JSDoc comments via [TypeDoc](https://typedoc.org/).

### Generating locally

```bash
npm run docs:api
```

Output lands in `docs/api/` (gitignored). Open `docs/api/index.html` in a browser to browse the
generated HTML reference. Alternatively, run the command and point a local HTTP server at the
directory:

```bash
npx serve docs/api
```

### Keeping docs in sync

- Every public symbol exported from `src/index.ts` should have a JSDoc comment (`/** ... */`).
- When adding or renaming exports, re-run `npm run docs:api` locally and verify the symbol appears
  in the generated output before opening your PR.
- TypeDoc reads from `typedoc.json` at the repo root — adjust category or navigation settings
  there, not via CLI flags.

### Publishing to GitHub Pages

The reference can be published automatically via GitHub Actions. Add a workflow job such as:

```yaml
- name: Generate API docs
  run: npm run docs:api

- name: Deploy to GitHub Pages
  uses: peaceiris/actions-gh-pages@v4
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    publish_dir: docs/api
```

Trigger this job on every push to `main` (or as a separate manual/release workflow). GitHub Pages
must be enabled in the repository settings with the source set to the `gh-pages` branch. Once
deployed, the reference is reachable at
`https://sorowill.github.io/sorowill-sdk/`.

## ScVal / XDR snapshot tests

Every state-changing method encodes its arguments into Soroban `ScVal`s via
`spec.funcArgsToScVals(method, args)` before building a transaction. A future
upgrade to `@stellar/stellar-sdk` could silently change that encoding — for
example altering how `u64` or `Address` values are serialised — producing
transactions that the contract rejects, with nothing in CI catching the
regression.

Snapshot tests lock in the exact `ScVal` / XDR output for each method's
typical arguments so any encoding change is caught immediately.

### Running the snapshot tests

```bash
npm test
```

Vitest runs all tests including the snapshot suite. Snapshot files live next to
the test files under `test/__snapshots__/`.

### Reviewing a snapshot diff

When a snapshot assertion fails you will see a diff like:

```
- Snapshot  "create_will args ScVal snapshot 1"
+ Received

  - scvMap: [ { key: scvSymbol("owner"), val: scvAddress(...) }, ... ]
  + scvMap: [ { key: scvSymbol("owner"), val: scvAddress(...) }, ... ]
```

Before updating, answer these questions:

1. **What changed?** Identify the `@stellar/stellar-sdk` commit or release note
   that explains the encoding difference.
2. **Is the new encoding correct on-chain?** Simulate the new XDR against the
   deployed testnet contract (`npm run test -- --reporter=verbose`) and confirm
   it succeeds.
3. **Is the change intentional?** If a dependency upgrade deliberately changes
   encoding for correctness, the snapshot should be updated. If you cannot
   explain why the encoding changed, treat it as a potential regression and do
   not update.

### Intentionally updating snapshots

Once you have verified the new encoding is correct, update the snapshot file:

```bash
npx vitest run --update-snapshots
```

Commit **both** the source change that caused the encoding to shift (e.g. the
`package.json` version bump) **and** the updated snapshot file in the same PR,
with a description explaining why the XDR shape changed. Reviewers should be
able to cross-reference the diff against the upstream SDK changelog.

### Adding a snapshot for a new method

When you add a new state-changing method, add a corresponding snapshot
assertion in `test/sorowill-client-sdk.test.ts` (or a dedicated snapshot test
file). Use `toMatchSnapshot()` on the serialised ScVal array:

```ts
it('encodes create_will args to the expected ScVal shape', () => {
  const scVals = spec.funcArgsToScVals('create_will', {
    owner: 'GABC...',
    token: 'CABC...',
    amount: 1_000_000n,
    beneficiaries: [{ address: 'GBEN', percentage: 100 }],
    checkin_period_days: 90n,
    grace_period_days: 7n,
    guardians: [],
  });
  expect(scVals.map((v) => v.toXDR('base64'))).toMatchSnapshot();
});
```

Run `npx vitest run --update-snapshots` once to write the initial snapshot,
then commit it. All subsequent runs will assert against that baseline.

## Local setup

See the [README](./README.md#installation) for installation and how to run the test suite.

## Learn more

Full details on how Wave Programs work — applying, Points, rewards, and payouts — are documented at <https://drips.network/wave>.
