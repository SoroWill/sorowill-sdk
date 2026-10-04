import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useSoroWillClient } from './hooks';

const createClient = vi.fn((options: unknown) => ({ options }));

vi.mock('../client', () => ({
  SoroWillClient: vi.fn().mockImplementation((options: unknown) => createClient(options)),
}));

describe('useSoroWillClient', () => {
  beforeEach(() => {
    createClient.mockClear();
  });

  it('reuses the client when options are unchanged', () => {
    const options = { network: 'testnet' as const, contractId: 'CABC' };
    const { result, rerender } = renderHook(() => useSoroWillClient(options));

    const first = result.current;
    rerender();

    expect(result.current).toBe(first);
    expect(createClient).toHaveBeenCalledTimes(1);
  });

  it('rebuilds the client when retry changes', () => {
    const { result, rerender } = renderHook(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ({ retry }: { retry: unknown }) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return useSoroWillClient({ network: 'testnet', contractId: 'CABC', retry: retry as any });
      },
      { initialProps: { retry: { attempts: 1 } } },
    );

    const first = result.current;
    rerender({ retry: { attempts: 3 } });

    expect(result.current).not.toBe(first);
    expect(createClient).toHaveBeenCalledTimes(2);
  });

  it('rebuilds the client when wallet changes', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const walletA = { sign: vi.fn() } as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const walletB = { sign: vi.fn() } as any;

    const { result, rerender } = renderHook(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ({ wallet }: { wallet: any }) =>
        useSoroWillClient({ network: 'testnet', contractId: 'CABC', wallet }),
      { initialProps: { wallet: walletA } },
    );

    const first = result.current;
    rerender({ wallet: walletB });

    expect(result.current).not.toBe(first);
    expect(createClient).toHaveBeenCalledTimes(2);
  });
});
