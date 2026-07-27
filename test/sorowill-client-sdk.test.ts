import { Account, xdr } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';

import { ReadCache } from '../src/cache';
import { SoroWillClient, type SoroWillRpcServer } from '../src/SoroWillClient';
import type { WillEvent, WillEventSource } from '../src/events';
import { WillStatus } from '../src/types';
import type { WalletAdapter, WalletConnection } from '../src/wallet';

const TEST_ACCOUNT = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const VOID_SCVAL = xdr.ScVal.scvVoid();

interface RawWillShape {
  id: bigint;
  owner: string;
  token: string;
  balance: bigint;
  beneficiaries: Array<{ address: string; percentage: number }>;
  checkin_period_days: bigint;
  grace_period_days: bigint;
  last_checkin: bigint;
  trigger_time: bigint | undefined;
  status: WillStatus;
  guardians: string[];
  guardian_votes: number;
}

function makeRawWill(id: bigint): RawWillShape {
  return {
    id,
    owner: 'GOWNER',
    token: 'CTOKEN',
    balance: 1_000_000n,
    beneficiaries: [{ address: 'GBEN', percentage: 100 }],
    checkin_period_days: 90n,
    grace_period_days: 7n,
    last_checkin: 1_700_000_000n,
    trigger_time: undefined,
    status: WillStatus.Active,
    guardians: [],
    guardian_votes: 0,
  };
}

class StubWalletAdapter implements WalletAdapter {
  async isConnected(): Promise<boolean> {
    return true;
  }

  async connect(): Promise<WalletConnection> {
    return {
      publicKey: TEST_ACCOUNT,
      network: 'testnet',
      networkPassphrase: 'Test SDF Network ; September 2015',
    };
  }

  async reconnect(): Promise<WalletConnection> {
    return await this.connect();
  }

  async disconnect(): Promise<void> {
    return;
  }

  async getPublicKey(): Promise<string> {
    return TEST_ACCOUNT;
  }

  async signTransaction(transactionXdr: string, _opts: { networkPassphrase: string }): Promise<string> {
    return transactionXdr;
  }
}

class StubEventSource implements WillEventSource {
  private listener: ((event: WillEvent) => void) | null = null;

  subscribe(listener: (event: WillEvent) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = null;
    };
  }

  emit(event: WillEvent): void {
    this.listener?.(event);
  }
}

function createSpec(results: Record<string, unknown[]>) {
  return {
    funcArgsToScVals(_method: string, _args: Record<string, unknown>): xdr.ScVal[] {
      return [];
    },
    funcResToNative(method: string, _value: xdr.ScVal): unknown {
      const queue = results[method];
      if (!queue || queue.length === 0) {
        throw new Error(`No stub result queued for ${method}`);
      }
      return queue.shift();
    },
  };
}

function createRpcServer(options: {
  simulateTransactionImpl?: () => Promise<unknown>;
  pollTransactionImpl?: () => Promise<unknown>;
  sendTransactionImpl?: () => Promise<unknown>;
} = {}): SoroWillRpcServer {
  return {
    async getContractWasmByContractId(_contractId: string): Promise<Uint8Array> {
      return new Uint8Array();
    },
    async simulateTransaction(_transaction) {
      if (options.simulateTransactionImpl) {
        return (await options.simulateTransactionImpl()) as never;
      }
      return {
        result: {
          retval: VOID_SCVAL,
        },
      } as never;
    },
    async getAccount(_address: string): Promise<Account> {
      return new Account(TEST_ACCOUNT, '1');
    },
    async prepareTransaction(transaction) {
      return transaction;
    },
    async sendTransaction(_transaction) {
      if (options.sendTransactionImpl) {
        return (await options.sendTransactionImpl()) as never;
      }
      return {
        status: 'PENDING',
        hash: 'abc123',
      } as never;
    },
    async pollTransaction(_hash: string, _options: { attempts: number }) {
      if (options.pollTransactionImpl) {
        return (await options.pollTransactionImpl()) as never;
      }
      return {
        status: 'SUCCESS',
        createdAt: 1_700_000_000,
        returnValue: VOID_SCVAL,
      } as never;
    },
  };
}

describe('SoroWillClient read cache', () => {
  it('caches getWill results within the TTL window', async () => {
    const cache = new ReadCache({ ttlMs: 60_000 });

    cache.set('key1', { id: 'cached' });
    expect(cache.get('key1')).toEqual({ id: 'cached' });

    cache.clear();
    expect(cache.get('key1')).toBeUndefined();
  });
});

describe('SoroWillClient event-driven invalidation', () => {
  it('invalidates a cached will when a matching event is received', async () => {
    const events = new StubEventSource();
    let simulateCalls = 0;

    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM',
      wallet: new StubWalletAdapter(),
      readCache: { ttlMs: 60_000 },
      eventSource: events,
      spec: createSpec({ get_will: [makeRawWill(1n), makeRawWill(1n)] }),
      rpcServer: createRpcServer({
        async simulateTransactionImpl() {
          simulateCalls += 1;
          return { result: { retval: VOID_SCVAL } };
        },
      }),
    });

    await client.getWill('1');
    await client.getWill('1');
    expect(simulateCalls).toBe(1);

    events.emit({ type: 'will.updated', willId: '1' });

    await client.getWill('1');
    expect(simulateCalls).toBe(2);
  });
});

describe('SoroWillClient RPC retries', () => {
  it('retries a transient simulateTransaction failure and then succeeds', async () => {
    let attempts = 0;

    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM',
      wallet: new StubWalletAdapter(),
      readCache: false,
      retry: { maxAttempts: 3, initialDelayMs: 0, maxDelayMs: 0 },
      spec: createSpec({ get_will: [makeRawWill(1n)] }),
      rpcServer: createRpcServer({
        async simulateTransactionImpl() {
          attempts += 1;
          if (attempts === 1) {
            throw new Error('temporary rpc outage');
          }
          return { result: { retval: VOID_SCVAL } };
        },
      }),
    });

    const will = await client.getWill('1');
    expect(will.id).toBe('1');
    expect(attempts).toBe(2);
  });

  it('throws after the configured retry budget is exhausted', async () => {
    let attempts = 0;

    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM',
      wallet: new StubWalletAdapter(),
      readCache: false,
      retry: { maxAttempts: 2, initialDelayMs: 0, maxDelayMs: 0 },
      spec: createSpec({ get_will: [makeRawWill(1n), makeRawWill(1n)] }),
      rpcServer: createRpcServer({
        async simulateTransactionImpl() {
          attempts += 1;
          throw new Error('still failing');
        },
      }),
    });

    await expect(client.getWill('1')).rejects.toThrow(/failed after 2 attempts/i);
    expect(attempts).toBe(2);
  });
});
