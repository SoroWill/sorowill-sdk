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
- Make sure `npm run typecheck`, `npm test`, and `npm run build` all pass cleanly before requesting review.
- Add or update unit tests in `test/` for any behavior change to `src/utils.ts` or type validation logic.
- Keep the public API in `src/index.ts` in sync with any new exports.

## Local setup

See the [README](./README.md#installation) for installation and how to run the test suite.

## Releasing

Publishing to npm is fully automated by [`.github/workflows/publish.yml`](./.github/workflows/publish.yml), which runs on every GitHub Release being **published** and, in order, typechecks, tests, builds, and runs `npm publish --access public`. There is no separate "release" branch or manual publish step — creating the GitHub Release *is* what ships the package.

1. **Decide and apply the version bump.** This project follows [semver](https://semver.org/): patch for fixes, minor for backwards-compatible additions, major for breaking changes to the public API in `src/index.ts`. On `main`, with a clean working tree, run one of:

   ```
   npm version patch   # or: minor / major
   ```

   This bumps `version` in `package.json` and `package-lock.json`, commits the change, and creates a matching local git tag (e.g. `v0.2.0`). Push both:

   ```
   git push origin main --follow-tags
   ```

2. **Create the GitHub Release that triggers `publish.yml`.** Go to the repo's Releases page (or run `gh release create`) and create a release using the tag you just pushed. The tag name should match the version (e.g. `v0.2.0`); the release title and notes can summarize what changed since the last release. Publishing the release (not just saving it as a draft) fires the `release: published` event and starts the workflow.

3. **Watch the workflow run.** Check the Actions tab for the `Publish` run triggered by your release. If typecheck, test, or build fails, the job stops before `npm publish` runs — fix forward with a new commit/tag/release rather than trying to reuse the failed tag.

Because the publish step authenticates as `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}`, only maintainers with access to configure repository secrets can make this workflow succeed — the `NPM_TOKEN` secret is scoped to whoever administers this repo's GitHub settings, not to individual Wave contributors. If you're a contributor working an issue that requires a release to close out, ask a maintainer to cut it once your PR is merged.

## Learn more

Full details on how Wave Programs work — applying, Points, rewards, and payouts — are documented at <https://drips.network/wave>.
