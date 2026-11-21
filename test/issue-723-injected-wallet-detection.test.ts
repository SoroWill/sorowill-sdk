import { afterEach, describe, expect, it } from 'vitest';

import { detectInjectedWallets } from '../src/wallet';

type GlobalWithWindow = { window?: Record<string, unknown> };

function setWindow(value: Record<string, unknown> | undefined): void {
  (globalThis as GlobalWithWindow).window = value;
}

describe('Issue #723: injected wallet detection without the extension package', () => {
  afterEach(() => {
    setWindow(undefined);
  });

  it('detects a wallet injected as window.stellar even when the extension module is absent', () => {
    setWindow({ stellar: { signTransaction: () => {} } });

    expect(detectInjectedWallets()).toEqual(['stellar']);
  });

  it('detects the legacy window.freighter injection as a fallback', () => {
    setWindow({ freighter: { signTransaction: () => {} } });

    expect(detectInjectedWallets()).toEqual(['freighter']);
  });

  it('reports every injected wallet when multiple are present', () => {
    setWindow({
      stellar: { signTransaction: () => {} },
      freighter: { signTransaction: () => {} },
    });

    expect(detectInjectedWallets().sort()).toEqual(['freighter', 'stellar']);
  });

  it('ignores window globals that do not expose a signing method', () => {
    setWindow({ stellar: { note: 'not a wallet' } });

    expect(() => detectInjectedWallets()).toThrow(/no stellar wallet/i);
  });

  it('throws a clear error when no wallet is injected', () => {
    setWindow({});

    expect(() => detectInjectedWallets()).toThrow(/no stellar wallet detected/i);
  });

  it('throws a clear error outside a browser (no window)', () => {
    setWindow(undefined);

    expect(() => detectInjectedWallets()).toThrow(/no stellar wallet detected/i);
  });
});
