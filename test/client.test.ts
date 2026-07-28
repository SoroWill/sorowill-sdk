import { Account, Networks, Operation, TransactionBuilder } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';

import { ReadCache } from '../src/cache';
import { RpcEndpointPool } from '../src/rpc';
import { buildSep7TxUri, parseSep7Callback } from '../src/sep7';
import { assertPreparedTransactionMatchesIntendedOperation } from '../src/txValidation';
import {
  calculateShares,
  formatDeadline,
  formatUSDC,
  getTimeUntilCheckin,
  isCheckinDue,
  toStroops,
  validateBeneficiaries,
} from '../src/utils';
import { WillStatus, type Will } from '../src/types';
import { HookManager } from '../src/hooks';
import type { AfterInvokeContext } from '../src/hooks';

describe('formatUSDC', () => {
  it('formats whole numbers with two decimal places', () => {
    expect(formatUSDC(10_000_000n)).toBe('1.00');
  });

  it('formats fractional amounts', () => {
    expect(formatUSDC(12_345_000_000n)).toBe('1,234.50');
  });

  it('adds thousands separators', () => {
    expect(formatUSDC(1_000_000_000_000n)).toBe('100,000.00');
  });

  it('handles negative amounts', () => {
    expect(formatUSDC(-5_000_000n)).toBe('-0.50');
  });

  it('handles zero', () => {
    expect(formatUSDC(0n)).toBe('0.00');
  });
});

describe('toStroops', () => {
  it('parses whole numbers', () => {
    expect(toStroops('1')).toBe(10_000_000n);
  });

  it('parses decimals', () => {
    expect(toStroops('1234.50')).toBe(12_345_000_000n);
  });

  it('strips thousands separators', () => {
    expect(toStroops('1,234.50')).toBe(12_345_000_000n);
  });

  it('round-trips with formatUSDC at cents precision', () => {
    const original = 9_876_500_000n;
    expect(toStroops(formatUSDC(original))).toBe(original);
  });

  it('throws on invalid input', () => {
    expect(() => toStroops('not-a-number')).toThrow();
    expect(() => toStroops('')).toThrow();
  });
});

function makeWill(overrides: Partial<Will> = {}): Will {
  return {
    id: '1',
    owner: 'GABC',
    token: 'CABC',
    balance: '1000000000',
    beneficiaries: [{ address: 'GBEN', percentage: 100 }],
    checkinPeriodDays: 90,
    gracePeriodDays: 7,
    lastCheckin: new Date(),
    triggerTime: null,
    status: WillStatus.Active,
    guardians: [],
    guardianVotes: 0,
    ...overrides,
  };
}

describe('getTimeUntilCheckin / isCheckinDue', () => {
  it('returns a large positive value for a freshly created will', () => {
    const will = makeWill({ lastCheckin: new Date(), checkinPeriodDays: 90 });
    expect(getTimeUntilCheckin(will)).toBeGreaterThan(89 * 86_400);
    expect(isCheckinDue(will)).toBe(false);
  });

  it('returns a negative value once the deadline has passed', () => {
    const longAgo = new Date(Date.now() - 100 * 86_400 * 1000);
    const will = makeWill({ lastCheckin: longAgo, checkinPeriodDays: 90 });
    expect(getTimeUntilCheckin(will)).toBeLessThan(0);
    expect(isCheckinDue(will)).toBe(true);
  });
});

describe('calculateShares', () => {
  it('splits evenly for a single beneficiary', () => {
    const shares = calculateShares('1000000', [{ address: 'GBEN', percentage: 100 }]);
    expect(shares).toEqual([{ address: 'GBEN', share: '1000000' }]);
  });

  it('splits proportionally across multiple beneficiaries', () => {
    const shares = calculateShares('1000000', [
      { address: 'GBEN_A', percentage: 60 },
      { address: 'GBEN_B', percentage: 40 },
    ]);
    expect(shares).toEqual([
      { address: 'GBEN_A', share: '600000' },
      { address: 'GBEN_B', share: '400000' },
    ]);
  });

  it('pays any rounding remainder to the final beneficiary', () => {
    const shares = calculateShares('100', [
      { address: 'GBEN_A', percentage: 33 },
      { address: 'GBEN_B', percentage: 33 },
      { address: 'GBEN_C', percentage: 34 },
    ]);
    const total = shares.reduce((sum, share) => sum + BigInt(share.share), 0n);
    expect(total).toBe(100n);
    expect(shares[2]?.share).toBe('34');
  });

  // Task 3: Fixture-based tests mirroring contract distribute() behavior.
  // See: https://github.com/SoroWill/sorowill-contracts/blob/main/contracts/sorowill/src/contract.rs
  it('contract fixture: 50/50 split of 1 stroop (indivisible balance)', () => {
    const shares = calculateShares('1', [
      { address: 'GA', percentage: 50 },
      { address: 'GB', percentage: 50 },
    ]);
    expect(shares).toEqual([
      { address: 'GA', share: '0' },
      { address: 'GB', share: '1' },
    ]);
    const total = shares.reduce((sum, s) => sum + BigInt(s.share), 0n);
    expect(total).toBe(1n);
  });

  it('contract fixture: 3-way split of prime balance 997', () => {
    const shares = calculateShares('997', [
      { address: 'GA', percentage: 34 },
      { address: 'GB', percentage: 33 },
      { address: 'GC', percentage: 33 },
    ]);
    const total = shares.reduce((sum, s) => sum + BigInt(s.share), 0n);
    expect(total).toBe(997n);
    expect(shares[0]?.share).toBe('338');
    expect(shares[1]?.share).toBe('329');
    expect(shares[2]?.share).toBe('330');
  });
});

describe('formatDeadline', () => {
  it('formats a date as a human-readable string', () => {
    const formatted = formatDeadline(new Date('2027-01-05T15:45:00Z'));
    expect(formatted).toContain('2027');
    expect(formatted).toContain('Jan');
  });
});

describe('validateBeneficiaries', () => {
  it('accepts percentages that sum to 100', () => {
    expect(
      validateBeneficiaries([
        { address: 'GBEN_A', percentage: 60 },
        { address: 'GBEN_B', percentage: 40 },
      ]),
    ).toBe(true);
  });

  it('rejects percentages that do not sum to 100', () => {
    expect(
      validateBeneficiaries([
        { address: 'GBEN_A', percentage: 60 },
        { address: 'GBEN_B', percentage: 30 },
      ]),
    ).toBe(false);
  });

  it('rejects an empty list', () => {
    expect(validateBeneficiaries([])).toBe(false);
  });

  it('rejects zero or negative percentages', () => {
    expect(
      validateBeneficiaries([
        { address: 'GBEN_A', percentage: 100 },
        { address: 'GBEN_B', percentage: 0 },
      ]),
    ).toBe(false);
  });
});

describe('HookManager', () => {
  it('registers and counts beforeInvoke hooks', () => {
    const hm = new HookManager();
    expect(hm.beforeInvokeCount).toBe(0);
    hm.onBeforeInvoke(() => {});
    hm.onBeforeInvoke(() => {});
    expect(hm.beforeInvokeCount).toBe(2);
  });

  it('registers and counts afterInvoke hooks', () => {
    const hm = new HookManager();
    hm.onAfterInvoke(() => {});
    expect(hm.afterInvokeCount).toBe(1);
  });

  it('runs beforeInvoke hooks in order and returns true when none abort', async () => {
    const hm = new HookManager();
    const calls: string[] = [];
    hm.onBeforeInvoke(async () => { calls.push('a'); });
    hm.onBeforeInvoke(async () => { calls.push('b'); });
    const proceed = await hm.runBeforeInvoke({ method: 'test', args: {}, timestamp: '' });
    expect(proceed).toBe(true);
    expect(calls).toEqual(['a', 'b']);
  });

  it('aborts when a beforeInvoke hook returns false', async () => {
    const hm = new HookManager();
    const calls: string[] = [];
    hm.onBeforeInvoke(async () => { calls.push('a'); });
    hm.onBeforeInvoke(async () => { calls.push('b'); return false; });
    hm.onBeforeInvoke(async () => { calls.push('c'); });
    const proceed = await hm.runBeforeInvoke({ method: 'test', args: {}, timestamp: '' });
    expect(proceed).toBe(false);
    expect(calls).toEqual(['a', 'b']);
  });

  it('offBeforeInvoke removes a specific hook', async () => {
    const hm = new HookManager();
    const calls: string[] = [];
    const hook = async () => { calls.push('x'); };
    hm.onBeforeInvoke(hook);
    hm.onBeforeInvoke(async () => { calls.push('y'); });
    hm.offBeforeInvoke(hook);
    await hm.runBeforeInvoke({ method: 'test', args: {}, timestamp: '' });
    expect(calls).toEqual(['y']);
    expect(hm.beforeInvokeCount).toBe(1);
  });

  it('offAfterInvoke removes a specific hook', () => {
    const hm = new HookManager();
    const hook = () => {};
    hm.onAfterInvoke(hook);
    hm.onAfterInvoke(() => {});
    hm.offAfterInvoke(hook);
    expect(hm.afterInvokeCount).toBe(1);
  });

  it('clear removes all hooks', () => {
    const hm = new HookManager();
    hm.onBeforeInvoke(() => {});
    hm.onAfterInvoke(() => {});
    hm.onAfterInvoke(() => {});
    hm.clear();
    expect(hm.beforeInvokeCount).toBe(0);
    expect(hm.afterInvokeCount).toBe(0);
  });

  it('runs afterInvoke hooks with context', async () => {
    const hm = new HookManager();
    let captured: AfterInvokeContext | null = null;
    hm.onAfterInvoke((ctx: AfterInvokeContext) => { captured = ctx; });
    const ctx: AfterInvokeContext = { method: 'test', args: { a: 1 }, timestamp: '', txHash: 'abc', error: null, durationMs: 42 };
    await hm.runAfterInvoke(ctx);
    expect(captured).toBe(ctx);
  });
});

describe('ReadCache', () => {
  it('returns cached values before expiry', () => {
    let now = 1_000;
    const cache = new ReadCache({ ttlMs: 500, now: () => now });

    expect(cache.get('will:1')).toBeUndefined();

    cache.set('will:1', { id: '1' });
    expect(cache.get<{ id: string }>('will:1')).toEqual({ id: '1' });

    now = 1_400;
    expect(cache.get<{ id: string }>('will:1')).toEqual({ id: '1' });
  });

  it('expires cached values after the ttl', () => {
    let now = 1_000;
    const cache = new ReadCache({ ttlMs: 500, now: () => now });

    cache.set('owner:GABC', ['1']);
    now = 1_501;

    expect(cache.get<string[]>('owner:GABC')).toBeUndefined();
  });
});

describe('RpcEndpointPool', () => {
  it('fails over to the next endpoint on a connection error', async () => {
    const pool = new RpcEndpointPool(['https://rpc-a.example', 'https://rpc-b.example']);
    const attempts: string[] = [];

    const result = await pool.withFailover(async (_server, rpcUrl) => {
      attempts.push(rpcUrl);
      if (rpcUrl.endsWith('rpc-a.example')) {
        throw new Error('fetch failed');
      }
      return 'ok';
    });

    expect(result).toBe('ok');
    expect(attempts).toEqual(['https://rpc-a.example', 'https://rpc-b.example']);
    expect(pool.getActiveRpcUrl()).toBe('https://rpc-b.example');
  });

  it('does not fail over on non-connection errors', async () => {
    const pool = new RpcEndpointPool(['https://rpc-a.example', 'https://rpc-b.example']);

    await expect(
      pool.withFailover(async () => {
        throw new Error('contract execution failed');
      }),
    ).rejects.toThrow('contract execution failed');
  });
});

describe('SEP-7 helpers', () => {
  it('builds a valid tx deep-link uri', () => {
    const uri = buildSep7TxUri('AAAA', {
      callbackUrl: 'https://example.com/callback',
      message: 'Sign this will operation',
      networkPassphrase: Networks.TESTNET,
    });

    expect(uri).toContain('web+stellar:tx?');
    expect(uri).toContain('xdr=AAAA');
    expect(uri).toContain('callback=https%3A%2F%2Fexample.com%2Fcallback');
    expect(uri).toContain('msg=Sign+this+will+operation');
  });

  it('parses a callback url carrying a signed xdr result', () => {
    const result = parseSep7Callback(
      'https://example.com/callback?xdr=SIGNED123&pubkey=GABC&status=success',
    );

    expect(result).toEqual({
      transactionXdr: 'SIGNED123',
      signerAddress: 'GABC',
      status: 'success',
      message: undefined,
    });
  });
});

describe('pre-sign XDR validation', () => {
  function buildManageDataTx(name: string) {
    const account = new Account('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF', '1');
    return new TransactionBuilder(account, {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(Operation.manageData({ name, value: 'payload' }))
      .setTimeout(30)
      .build();
  }

  it('accepts a prepared transaction when the decoded operation matches', () => {
    const tx = buildManageDataTx('sorowill');

    expect(() =>
      assertPreparedTransactionMatchesIntendedOperation({
        intendedTransactionXdr: tx.toXDR(),
        preparedTransactionXdr: tx.toXDR(),
        networkPassphrase: Networks.TESTNET,
        context: 'manage_data',
      }),
    ).not.toThrow();
  });

  it('throws when the decoded operation does not match the intended one', () => {
    const intendedTx = buildManageDataTx('sorowill');
    const mismatchedTx = buildManageDataTx('tampered');

    expect(() =>
      assertPreparedTransactionMatchesIntendedOperation({
        intendedTransactionXdr: intendedTx.toXDR(),
        preparedTransactionXdr: mismatchedTx.toXDR(),
        networkPassphrase: Networks.TESTNET,
        context: 'manage_data',
      }),
    ).toThrow('did not match the intended operation');
  });
});
