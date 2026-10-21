/**
 * Tests for issue #614: FeeBump estimation doesn't account for inclusion-fee
 * baseline changes between estimation and submission.
 *
 * Acceptance criteria:
 * - Fee re-estimation before submission
 * - Configurable fee staleness threshold
 * - Test covers fee change scenario
 */

import { Account, Keypair, Networks, Operation, TransactionBuilder } from '@stellar/stellar-sdk';
import type { rpc } from '@stellar/stellar-sdk';
import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_FEE_STALENESS_THRESHOLD_MS,
  estimateFeeBumpFee,
  isFeeEstimateStale,
  refreshFeeEstimateIfStale,
  submitFeeBump,
} from '../src/feeBump';
import type { FeeEstimate } from '../src/feeBump';
import type { SoroWillRpcServer } from '../src/SoroWillClient';

const innerSource = Keypair.random();
const sponsor = Keypair.random();

function buildInnerXdr(): string {
  return new TransactionBuilder(new Account(innerSource.publicKey(), '1'), {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.bumpSequence({ bumpTo: '10' }))
    .setTimeout(0)
    .build()
    .toXDR();
}

const feeStats = (p90: string) =>
  ({ sorobanInclusionFee: { p90 }, inclusionFee: { p90 }, latestLedger: 1 }) as unknown as rpc.Api.GetFeeStatsResponse;

function makeServer(p90Values: string[]) {
  const getFeeStats = vi.fn();
  for (const p90 of p90Values) getFeeStats.mockResolvedValueOnce(feeStats(p90));
  const sendTransaction = vi.fn().mockResolvedValue({ status: 'PENDING', hash: 'abc123' });
  const pollTransaction = vi.fn().mockResolvedValue({ status: 'SUCCESS', createdAt: 42 });
  const server = {
    getContractWasmByContractId: vi.fn(),
    simulateTransaction: vi.fn(),
    getAccount: vi.fn(),
    prepareTransaction: vi.fn(),
    sendTransaction,
    pollTransaction,
    getFeeStats,
  } as unknown as SoroWillRpcServer;
  return { server, getFeeStats, sendTransaction };
}

describe('issue #614 — fee-bump fee re-estimation', () => {
  it('estimates the fee from the network inclusion-fee baseline', async () => {
    const { server } = makeServer(['500']);
    const estimate = await estimateFeeBumpFee({
      network: 'testnet',
      innerTransactionXdr: buildInnerXdr(),
      rpcServer: server,
    });
    expect(estimate.fee).toBe('500');
    expect(estimate.estimatedAt).toBeLessThanOrEqual(Date.now());
  });

  it('never estimates below the base fee', async () => {
    const { server } = makeServer(['10']);
    const estimate = await estimateFeeBumpFee({
      network: 'testnet',
      innerTransactionXdr: buildInnerXdr(),
      rpcServer: server,
    });
    expect(estimate.fee).toBe('100');
  });

  it('isFeeEstimateStale honours the default and custom thresholds', () => {
    const now = 1_000_000;
    const estimate: FeeEstimate = { fee: '200', estimatedAt: now - 10_000 };
    expect(isFeeEstimateStale(estimate, DEFAULT_FEE_STALENESS_THRESHOLD_MS, now)).toBe(false);
    expect(isFeeEstimateStale(estimate, 5_000, now)).toBe(true);
  });

  it('does not re-estimate a fresh estimate', async () => {
    const { server, getFeeStats } = makeServer([]);
    const estimate: FeeEstimate = { fee: '200', estimatedAt: Date.now() };
    const result = await refreshFeeEstimateIfStale(estimate, {
      network: 'testnet',
      innerTransactionXdr: buildInnerXdr(),
      rpcServer: server,
    });
    expect(result).toBe(estimate);
    expect(getFeeStats).not.toHaveBeenCalled();
  });

  it('never lowers the fee when the baseline has dropped', async () => {
    const { server } = makeServer(['100']);
    const estimate: FeeEstimate = { fee: '5000', estimatedAt: 0 };
    const result = await refreshFeeEstimateIfStale(estimate, {
      network: 'testnet',
      innerTransactionXdr: buildInnerXdr(),
      rpcServer: server,
    });
    expect(result.fee).toBe('5000');
  });

  it('re-estimates a stale fee before submission when the network fee rises', async () => {
    const innerXdr = buildInnerXdr();
    const { server, getFeeStats, sendTransaction } = makeServer(['200', '1500']);

    const estimate = await estimateFeeBumpFee({ network: 'testnet', innerTransactionXdr: innerXdr, rpcServer: server });
    expect(estimate.fee).toBe('200');

    // Simulate time passing beyond the staleness threshold while the network fee rose.
    const stale: FeeEstimate = { ...estimate, estimatedAt: estimate.estimatedAt - 60_000 };

    const result = await submitFeeBump({
      network: 'testnet',
      innerTransactionXdr: innerXdr,
      feeSourceSecretKey: sponsor.secret(),
      feeEstimate: stale,
      rpcServer: server,
    });

    expect(result.txHash).toBe('abc123');
    expect(getFeeStats).toHaveBeenCalledTimes(2);
    // Fee-bump total = per-op fee * (1 inner op + the fee-bump envelope).
    const submitted = sendTransaction.mock.calls[0]![0] as { fee: string };
    expect(submitted.fee).toBe('3000');
  });

  it('uses the original estimate when within a custom staleness threshold', async () => {
    const innerXdr = buildInnerXdr();
    const { server, getFeeStats, sendTransaction } = makeServer(['1500']);
    const estimate: FeeEstimate = { fee: '400', estimatedAt: Date.now() - 60_000 };

    await submitFeeBump({
      network: 'testnet',
      innerTransactionXdr: innerXdr,
      feeSourceSecretKey: sponsor.secret(),
      feeEstimate: estimate,
      feeStalenessThresholdMs: 120_000,
      rpcServer: server,
    });

    expect(getFeeStats).not.toHaveBeenCalled();
    const submitted = sendTransaction.mock.calls[0]![0] as { fee: string };
    expect(submitted.fee).toBe('800');
  });
});
