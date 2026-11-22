# Test that error messages display correctly to users

_Tracks [GitHub #744](https://github.com/SoroWill/sorowill-sdk/issues/744)._

## Description

Nothing checks that the errors the SDK throws carry user-friendly messages.
A wording change, or a new error type added without guidance, can reach end
users with no test failing.

## Evidence

- `src/errors.ts` defines `SoroWillError` with optional `errorCode` and
  `recoverySteps` fields, and `UserFriendlyErrorInfo`
  (`{ errorCode, message, recoverySteps }`). Both fields are **optional**, so
  nothing requires a given error to set them.
- Contract errors get their recovery steps from `CONTRACT_ERROR_METADATA`
  (`src/errors.ts:698`). `WillContractError` appends them to the message
  (`src/errors.ts:748`), so for contract codes 1–37 the data exists but is
  untested as a whole.
- Several user-reachable paths throw a plain `Error` with no code or recovery
  steps. In `src/feeBump.ts` these are lines 400, 424, 477, 575, 617, 668 and
  683, and the messages include raw XDR (`diagnostics: …`, `error: …`). That
  is technical jargon a user would see.
- `FreighterConnectionTimeoutError.recoverySteps` is a `string[]`
  (`src/errors.ts:506`), while the base class declares `recoverySteps?: string`.
  The shape is inconsistent.
- No localization exists: there is no i18n/locale handling in `src/` (the only
  "locale" hits are cache-key comments in `src/cache.ts`). Every message is a
  hard-coded English string.

## Suggested acceptance criteria

- [ ] `test/error-message-clarity.test.ts` loops over every exported
      `SoroWillError` subclass and every contract error code (1–37 plus
      unknown) and checks that each one:
  - [ ] has a non-empty `message` and an `errorCode` from `ErrorCode`.
  - [ ] has non-empty `recoverySteps` that start with a verb (for example
        "Verify…", "Connect…", "Retry…").
- [ ] "No technical jargon": each message is checked against a denylist (`XDR`,
      `ScVal`, `StrKey`, `envelope`, raw base64/hex blobs, stack fragments,
      `undefined`/`[object Object]`). Technical detail stays available on
      `cause`, not in `message`.
- [ ] Secrets and raw input are never interpolated into messages. Existing
      intent: `InvalidStellarAddressError` and `InvalidSignedXdrEncodingError`
      already avoid embedding the offending value.
- [ ] Convert the plain `Error` throws in `src/feeBump.ts` to `SoroWillError`
      with a code and recovery steps, so the sweep covers them.
- [ ] Make the `recoverySteps` type consistent (`string` or `readonly string[]`)
      across all errors.
- [ ] Localization (**needs a design decision first**):
  - [ ] Add a message catalog keyed by `ErrorCode`, with English as the
        default.
  - [ ] Add a way to choose the locale, either a client option or a
        `getUserFriendlyError(err, locale)` helper.
  - [ ] Test that every `ErrorCode` has an entry in every shipped locale, and
        that an unknown locale falls back to English.

## Open questions

- Is localization in scope for the SDK, or should the SDK expose
  `errorCode` + `recoverySteps` and let apps translate? If it's the latter,
  "Messages are localized" becomes "every error has a stable `errorCode` that
  apps can key translations on", and the catalog work is dropped.
