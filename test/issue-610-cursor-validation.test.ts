/**
 * Tests for issue #610: will pagination doesn't validate cursor format before
 * querying, so a malformed cursor reaches the RPC and surfaces as a 500
 * instead of a client-side validation error.
 *
 * Fix: `getWillsByOwner`/`getWillsByBeneficiary` reject malformed cursors
 * with an `InvalidCursorError` (carrying a human-readable `reason`) before
 * any RPC call, and `subscribeToEvents` validates its paging-token cursor
 * before it is forwarded to the event RPC or WebSocket stream.
 */

import { describe, it, expect, vi } from 'vitest';
import { Networks } from '@stellar/stellar-sdk';
import { SoroWillClient } from '../src/SoroWillClient';
import type { SoroWillRpcServer } from '../src/SoroWillClient';
import { InvalidCursorError } from '../src/errors';
import type { WalletAdapter } from '../src/wallet';

const CONTRACT_ID = 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE';
const OWNER = 'GA3JE5IXBSOR6DCLZSGN7JIWQWO45RCS7PUFKKVXWSTE4Y75ISIDMHJG';

function makeWallet(): WalletAdapter {
  return {
    isConnected: vi.fn().mockResolvedValue(true),
    connect: vi.fn().mockResolvedValue({ publicKey: OWNER, network: 'testnet', networkPassphrase: Networks.TESTNET }),
    reconnect: vi.fn().mockResolvedValue({ publicKey: OWNER, network: 'testnet', networkPassphrase: Networks.TESTNET }),
    disconnect: vi.fn().mockResolvedValue(undefined),
    getPublicKey: vi.fn().mockResolvedValue(OWNER),
    signTransaction: vi.fn(),
  };
}

function makeClient() {
  const server: SoroWillRpcServer = {
    getContractWasmByContractId: vi.fn(),
    simulateTransaction: vi.fn(),
    getAccount: vi.fn(),
    prepareTransaction: vi.fn(),
    sendTransaction: vi.fn(),
    pollTransaction: vi.fn(),
  };
  const fetchImpl = vi.fn();
  const client = new SoroWillClient({
    network: 'testnet',
    contractId: CONTRACT_ID,
    rpcServer: server,
    wallet: makeWallet(),
    fetch: fetchImpl as never,
    eventRpcUrl: 'https://rpc.example',
  });
  return { client, server, fetchImpl };
}

const MALFORMED_WILL_CURSORS: unknown[] = [
  '',
  'abc',
  '-1',
  '1.5',
  ' 1',
  '1 ',
  '01',
  '1e3',
  '0x10',
  '99999999999999999999',
  "1; DROP TABLE wills",
  5,
  null,
  {},
];

describe('will pagination cursor validation (#610)', () => {
  it.each(MALFORMED_WILL_CURSORS)(
    'getWillsByOwner rejects malformed cursor %j before calling the RPC',
    async (cursor) => {
      const { client, server } = makeClient();
      const error = await client
        .getWillsByOwner(OWNER, { pageSize: 2, cursor } as never)
        .catch((err: unknown) => err);

      expect(error).toBeInstanceOf(InvalidCursorError);
      expect((error as InvalidCursorError).reason).toBeTruthy();
      expect((error as Error).message).toMatch(/^Invalid pagination cursor: /);
      expect(server.simulateTransaction).not.toHaveBeenCalled();
      expect(server.getContractWasmByContractId).not.toHaveBeenCalled();
    },
  );

  it.each(MALFORMED_WILL_CURSORS)(
    'getWillsByBeneficiary rejects malformed cursor %j before calling the RPC',
    async (cursor) => {
      const { client, server } = makeClient();
      await expect(
        client.getWillsByBeneficiary(OWNER, { cursor } as never),
      ).rejects.toBeInstanceOf(InvalidCursorError);
      expect(server.simulateTransaction).not.toHaveBeenCalled();
    },
  );

  it('records the offending cursor on the error', async () => {
    const { client } = makeClient();
    const error = (await client
      .getWillsByOwner(OWNER, { cursor: 'not-a-cursor' })
      .catch((err: unknown) => err)) as InvalidCursorError;

    expect(error.cursor).toBe('not-a-cursor');
  });
});

describe('event subscription cursor validation (#610)', () => {
  it.each(['', 'bad cursor', 'cursor"}', 'x'.repeat(257), 42])(
    'rejects malformed event cursor %j before contacting the RPC',
    async (cursor) => {
      const { client, fetchImpl } = makeClient();
      await expect(
        client.subscribeToEvents(() => undefined, { transport: 'polling', cursor } as never),
      ).rejects.toBeInstanceOf(InvalidCursorError);
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it('accepts a well-formed RPC paging token', async () => {
    const { client } = makeClient();
    const subscription = await client.subscribeToEvents(() => undefined, {
      transport: 'polling',
      cursor: '0004294967296-0000000001',
      pollIntervalMs: 60_000,
    });
    subscription.unsubscribe();
    expect(subscription.closed).toBe(true);
  });
});
