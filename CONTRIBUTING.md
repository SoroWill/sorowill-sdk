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

## Local setup

See the [README](./README.md#installation) for installation and how to run the test suite.

## Learn more

Full details on how Wave Programs work — applying, Points, rewards, and payouts — are documented at <https://drips.network/wave>.
