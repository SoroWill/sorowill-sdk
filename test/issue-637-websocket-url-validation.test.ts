/**
 * Tests for issue #637: EventSubscription doesn't validate WebSocket URL
 * before connecting.
 *
 * Acceptance criteria:
 * - WebSocket URL validation is applied when the client is constructed
 * - Only wss:// URLs are accepted (not ws://)
 * - Test covers URL validation
 */

import { Account, xdr } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';

import { SoroWillClient, type SoroWillRpcServer } from '../src/SoroWillClient';
import { InvalidWebSocketUrlError } from '../src/errors';

const CONTRACT_ID = 'CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR';
const _TEST_ACCOUNT = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

function makeMinimalRpcServer(): SoroWillRpcServer {
  return {
    async getContractWasmByContractId(): Promise<Uint8Array> {
      return new Uint8Array();
    },
    async simulateTransaction() {
      return { result: { retval: xdr.ScVal.scvVoid() } } as never;
    },
    async getAccount(address: string) {
      return new Account(address, '1');
    },
    async prepareTransaction(tx: unknown) {
      return tx as never;
    },
    async sendTransaction() {
      return { status: 'PENDING', hash: 'tx_hash' } as never;
    },
    async pollTransaction() {
      return { status: 'SUCCESS', createdAt: 1_000_000, returnValue: xdr.ScVal.scvVoid() } as never;
    },
  };
}

const BASE_OPTIONS = {
  network: 'testnet' as const,
  contractId: CONTRACT_ID,
  rpcServer: makeMinimalRpcServer(),
};

describe('Issue #637: WebSocket URL validation', () => {
  // ── Rejection of insecure/invalid URLs ────────────────────────────────────

  it('throws InvalidWebSocketUrlError when eventStreamUrl uses ws:// (plaintext)', () => {
    expect(() =>
      new SoroWillClient({
        ...BASE_OPTIONS,
        eventStreamUrl: 'ws://example.com/events',
      }),
    ).toThrow(InvalidWebSocketUrlError);
  });

  it('throws InvalidWebSocketUrlError for an http:// URL passed as eventStreamUrl', () => {
    expect(() =>
      new SoroWillClient({
        ...BASE_OPTIONS,
        eventStreamUrl: 'http://example.com/events',
      }),
    ).toThrow(InvalidWebSocketUrlError);
  });

  it('throws InvalidWebSocketUrlError for a plain hostname with no scheme', () => {
    expect(() =>
      new SoroWillClient({
        ...BASE_OPTIONS,
        eventStreamUrl: 'example.com/events',
      }),
    ).toThrow(InvalidWebSocketUrlError);
  });

  it('throws InvalidWebSocketUrlError for an empty string eventStreamUrl', () => {
    expect(() =>
      new SoroWillClient({
        ...BASE_OPTIONS,
        eventStreamUrl: '',
      }),
    ).toThrow(InvalidWebSocketUrlError);
  });

  it('error message mentions the rejected URL', () => {
    const badUrl = 'ws://evil.example.com/steal-events';
    let thrown: unknown;
    try {
      new SoroWillClient({ ...BASE_OPTIONS, eventStreamUrl: badUrl });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(InvalidWebSocketUrlError);
    const err = thrown as InvalidWebSocketUrlError;
    expect(err.url).toBe(badUrl);
    expect(err.message).toContain(badUrl);
  });

  // ── Acceptance of valid wss:// URLs ───────────────────────────────────────

  it('accepts a wss:// eventStreamUrl without throwing', () => {
    expect(() =>
      new SoroWillClient({
        ...BASE_OPTIONS,
        eventStreamUrl: 'wss://events.example.com/stream',
      }),
    ).not.toThrow();
  });

  it('accepts a wss:// URL with a port and path', () => {
    expect(() =>
      new SoroWillClient({
        ...BASE_OPTIONS,
        eventStreamUrl: 'wss://events.example.com:4443/sorowill/events',
      }),
    ).not.toThrow();
  });

  // ── No eventStreamUrl is still valid ──────────────────────────────────────

  it('does not throw when eventStreamUrl is omitted entirely', () => {
    expect(() =>
      new SoroWillClient({
        ...BASE_OPTIONS,
        // no eventStreamUrl
      }),
    ).not.toThrow();
  });

  // ── Public export from package index ──────────────────────────────────────

  it('InvalidWebSocketUrlError is exported from the main package index', async () => {
    const pkg = await import('../src/index');
    expect(pkg.InvalidWebSocketUrlError).toBeDefined();
    const err = new pkg.InvalidWebSocketUrlError('ws://bad');
    expect(err).toBeInstanceOf(InvalidWebSocketUrlError);
  });
});
