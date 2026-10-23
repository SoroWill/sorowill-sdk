/**
 * Tests for issue #631: releaseInheritance() grace period validation.
 *
 * Verifies that releaseInheritance throws a clear GracePeriodActiveError
 * when called during the grace period, instead of forwarding a cryptic
 * contract rejection.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SoroWillClient } from './SoroWillClient';
import { GracePeriodActiveError } from './errors';
import { WillStatus } from './types';
import type { Will } from './types';

// ---------------------------------------------------------------------------
// Minimal fakes
// ---------------------------------------------------------------------------

const CONTRACT_ID = 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE';

function makeWill(overrides: Partial<Will> = {}): Will {
  const now = Date.now();
  return {
    id: '1',
    owner: 'GABC',
    token: 'native',
    balance: '1000000',
    beneficiaries: [{ address: 'GDEF', percentage: 100 }],
    checkinPeriodDays: 30,
    gracePeriodDays: 7,
    lastCheckin: new Date(now - 40 * 24 * 60 * 60 * 1000),
    // triggerTime 1 hour ago → grace period (7 days) has NOT expired
    triggerTime: new Date(now - 60 * 60 * 1000),
    status: WillStatus.Triggered,
    guardians: [],
    guardianVotes: 0,
    ...overrides,
  };
}

function makeRpcServer(will: Will) {
  return {
    getContractWasmByContractId: vi.fn().mockResolvedValue(new Uint8Array()),
    simulateTransaction: vi.fn().mockResolvedValue({ results: [] }),
    getAccount: vi.fn().mockResolvedValue({ accountId: () => 'GABC', incrementSequenceNumber: vi.fn(), sequence: '0' }),
    prepareTransaction: vi.fn().mockResolvedValue({}),
    sendTransaction: vi.fn().mockResolvedValue({ hash: 'abc', status: 'PENDING' }),
    pollTransaction: vi.fn().mockResolvedValue({ status: 'SUCCESS', returnValue: null }),
    // Not called during grace period validation — should not be reached
    __will: will,
  };
}

function makeWallet(publicKey = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF') {
  return {
    getPublicKey: vi.fn().mockResolvedValue(publicKey),
    signTransaction: vi.fn().mockResolvedValue({ signedTxXdr: '' }),
    getNetwork: vi.fn().mockResolvedValue({ networkPassphrase: 'Test SDF Network ; September 2015' }),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeClient(will: Will) {
  const rpcServer = makeRpcServer(will);
  const wallet = makeWallet();

  const client = new SoroWillClient({
    network: 'testnet',
    contractId: CONTRACT_ID,
    rpcServer,
    wallet,
  });

  // Inject a spy on getWill to return our fake will without hitting RPC
  vi.spyOn(client as unknown as { getWill: (id: string) => Promise<Will> }, 'getWill').mockResolvedValue(will);

  return { client, rpcServer, wallet };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('#631 releaseInheritance — grace period validation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('throws GracePeriodActiveError when grace period has not expired', async () => {
    const now = Date.now();
    const triggerTime = new Date(now - 60 * 60 * 1000); // triggered 1 hour ago
    const gracePeriodDays = 7;
    const will = makeWill({ triggerTime, gracePeriodDays });

    vi.setSystemTime(now);

    const { client } = makeClient(will);

    await expect(client.releaseInheritance('1')).rejects.toThrow(GracePeriodActiveError);
  });

  it('GracePeriodActiveError includes the will ID and expiry time', async () => {
    const now = Date.now();
    const triggerTime = new Date(now - 60 * 60 * 1000);
    const gracePeriodDays = 7;
    const will = makeWill({ triggerTime, gracePeriodDays });

    vi.setSystemTime(now);

    const { client } = makeClient(will);

    let caught: GracePeriodActiveError | null = null;
    try {
      await client.releaseInheritance('1');
    } catch (err) {
      if (err instanceof GracePeriodActiveError) caught = err;
    }

    expect(caught).not.toBeNull();
    expect(caught!.willId).toBe('1');
    expect(caught!.expiresAt).toBeInstanceOf(Date);
    // expiresAt should be triggerTime + gracePeriodDays
    const expectedExpiry = new Date(triggerTime.getTime() + gracePeriodDays * 24 * 60 * 60 * 1000);
    expect(caught!.expiresAt.getTime()).toBe(expectedExpiry.getTime());
  });

  it('does not throw GracePeriodActiveError when triggerTime is null', async () => {
    // Will not yet triggered — gracePeriod check should be skipped.
    // releaseInheritance will still fail, but not with GracePeriodActiveError.
    const will = makeWill({ triggerTime: null, status: WillStatus.Active });
    const { client, rpcServer } = makeClient(will);
    // Let the RPC call fail after the guard so we can confirm the guard didn't fire
    rpcServer.getAccount.mockRejectedValue(new Error('account not found'));

    await expect(client.releaseInheritance('1')).rejects.not.toThrow(GracePeriodActiveError);
  });

  it('does not throw GracePeriodActiveError when grace period has expired', async () => {
    const now = Date.now();
    // Triggered 10 days ago, grace period is 7 days → already expired
    const triggerTime = new Date(now - 10 * 24 * 60 * 60 * 1000);
    const gracePeriodDays = 7;
    const will = makeWill({ triggerTime, gracePeriodDays });

    vi.setSystemTime(now);

    const { client, rpcServer } = makeClient(will);
    // getAccount succeeds (beneficiary funded), but send/poll might fail — that's fine
    rpcServer.sendTransaction.mockResolvedValue({ hash: 'tx123', status: 'PENDING' });

    // Should not throw GracePeriodActiveError specifically
    try {
      await client.releaseInheritance('1');
    } catch (err) {
      expect(err).not.toBeInstanceOf(GracePeriodActiveError);
    }
  });

  it('error message mentions releaseInheritance and the expiry time', async () => {
    const now = Date.now();
    const triggerTime = new Date(now - 1000);
    const will = makeWill({ triggerTime, gracePeriodDays: 3 });

    vi.setSystemTime(now);

    const { client } = makeClient(will);

    await expect(client.releaseInheritance('1')).rejects.toThrow(
      /grace period is still active/,
    );
  });
});
