# Test accessibility of error dialogs and prompts

_Tracks [GitHub #751](https://github.com/SoroWill/sorowill-sdk/issues/751)._

## Description

The SDK ships one piece of UI: `WalletConnectionDialog` in
`src/react/hooks.tsx`, exported from `@sorowill/sdk/react`. It shows
connection progress and errors, and offers Retry, Connect, and Close buttons.
Its own doc comment calls it "accessible", but no tests check that. Some
basic accessibility behaviour is also missing.

## Evidence

Current markup (`src/react/hooks.tsx`, `WalletConnectionDialog`):

```html
<div role="dialog" aria-modal="true" aria-label="Connect Wallet">
  <h2>Connect Wallet</h2>
  <p>Connecting to wallet...</p>                <!-- when loading -->
  <div role="alert"><p>{error.message}</p><button>Retry</button></div>
  <button>Connect</button>
  <button>Close</button>
</div>
```

What already works:

- `role="dialog"` and `aria-modal="true"` are set, and the dialog has an
  accessible name.
- The error container has `role="alert"`, so screen readers announce it when
  it appears.
- All controls are native `<button type="button">` elements, so they can be
  focused and activated with Enter and Space.

What is missing:

| Gap | Impact | WCAG |
| --- | --- | --- |
| Focus is not moved into the dialog when it opens | Keyboard and screen-reader users stay on the page behind the dialog | 2.4.3 Focus Order |
| No focus trap | Tab moves out of an `aria-modal` dialog into page content | 2.4.3, 2.1.2 |
| Escape does not close the dialog | Users expect Escape to dismiss a modal | 2.1.1 Keyboard |
| Focus is not returned to the trigger when the dialog closes | Users lose their place on the page | 2.4.3 |
| Hard-coded `aria-label` instead of `aria-labelledby` pointing at the `<h2>` | The label and the visible heading can drift apart | 2.5.3 Label in Name |
| The loading text has no live region (`role="status"`) | "Connecting to wallet..." is never announced | 4.1.3 Status Messages |
| The error is not linked to the dialog with `aria-describedby` | Re-entering the dialog doesn't re-read the error | 1.3.1 |
| Retry is `disabled` while loading, which removes it from the tab order | Focus can be lost mid-retry | 2.4.3 |

**Contrast:** the component ships **no CSS**. Colours come from the user
agent stylesheet or from the consuming app. The SDK can only test contrast
of the default (unstyled) render. Contrast in a themed app is the
integrator's responsibility, and the docs should say so.

**Tooling:** `jsdom`, `@testing-library/react`, and `@testing-library/dom`
are already dev dependencies. No axe-based tooling is installed.
`vitest.config.ts` excludes `src/react/**/*.test.tsx` from the default run,
so the a11y tests need their own jsdom project or config.

## Test plan

Add `test/a11y/wallet-connection-dialog.a11y.test.tsx` and run it in a jsdom
Vitest project. New dev dependencies: `vitest-axe` (or `jest-axe`) and
`@testing-library/user-event`.

**1. ARIA labels and roles**
- `getByRole('dialog', { name: 'Connect Wallet' })` resolves.
- The dialog has `aria-modal="true"`.
- Each button is found by its accessible name (`Retry`, `Connect`, `Close`).
- `axe(container)` reports no violations in each state: idle, loading,
  error, and error while retrying.

**2. Screen-reader announcements**
- Rendering with `error` set produces an element with `role="alert"` that
  contains `error.message`.
- Changing `error` from `null` to an error object inserts the alert. Live
  regions only announce changes, so the test must re-render rather than
  mount with the error already set.
- Loading state: an element with `role="status"` (or `aria-live="polite"`)
  contains the progress text. This fails today.
- Errors produced by `formatUserFriendlyError()` render as readable text,
  with no raw XDR or stack traces.

**3. Keyboard navigation** (with `userEvent`)
- On open, focus moves inside the dialog. This fails today.
- Tab and Shift+Tab cycle only through the dialog's buttons. This fails today.
- Escape calls `onClose`. This fails today.
- Enter and Space on Retry call `onRetry`, and on Connect call `onConnect`.
- After close, focus returns to the element that opened the dialog. This
  fails today.

**4. Contrast (WCAG 2.1 AA)**
- Run axe's `color-contrast` rule on the unstyled render. jsdom does not
  compute layout, so this check is approximate. For a real check, run the
  same axe pass in Playwright (`@axe-core/playwright`) in Chromium as part of
  the browser suite in [`mobile-browser-compat.md`](./mobile-browser-compat.md).
- Document a contrast requirement (≥ 4.5:1 for text, ≥ 3:1 for focus
  indicators) in the component's TSDoc for integrators who style it.

## Fixes needed to pass

1. Add `aria-labelledby` pointing at the `<h2>` (use `useId()`), and
   `aria-describedby` pointing at the error message.
2. Wrap the loading text in `role="status"`.
3. On open, focus the first button and remember the previously focused
   element. On close, restore focus to it.
4. Trap Tab inside the dialog, and handle Escape by calling `onClose`.
5. Use `aria-disabled` instead of `disabled` on Retry while loading, so it
   keeps focus.

## Acceptance criteria

- [ ] The error dialog has a correct role, `aria-modal`, an accessible name,
      and a description. axe reports no violations in any state.
- [ ] Error messages are announced through `role="alert"`, and loading
      progress through `role="status"`.
- [ ] Keyboard: focus moves in on open, Tab is trapped, Escape closes the
      dialog, and focus returns to the trigger on close.
- [ ] Contrast of the default render meets WCAG 2.1 AA in a real-browser
      axe run. Integrator contrast requirements are documented.
- [ ] The a11y tests run in CI.
