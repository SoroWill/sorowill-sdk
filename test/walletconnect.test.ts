import { describe, expect, it } from 'vitest';

import {
  LocalStorageWalletConnectSessionStore,
  MemoryWalletConnectSessionStore,
  WalletConnectAdapter,
  type WalletConnectClient,
  type WalletConnectSession,
} from '../src/walletConnect';

function makeSession(topic = 'topic-1'): WalletConnectSession {
  return {
    topic,
    namespaces: {
      stellar: {
        accounts: ['stellar:testnet:GABC123'],
        methods: ['stellar_signXdr'],
        events: [],
      },
    },
  };
}

describe('WalletConnectAdapter', () => {
  it('persists session topics through the localStorage store', async () => {
    const storage = new Map<string, string>();
    const store = new LocalStorageWalletConnectSessionStore({
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, value),
      removeItem: (key: string) => void storage.delete(key),
    } as Storage);

    await store.setSessionTopic('topic-local');
    await expect(store.getSessionTopic()).resolves.toBe('topic-local');
    await store.clearSessionTopic();
    await expect(store.getSessionTopic()).resolves.toBeNull();
  });

  it('connects, signs, and disconnects through the generic WalletConnect client', async () => {
    const session = makeSession();
    let disconnectedTopic: string | null = null;

    const client: WalletConnectClient = {
      async connect() {
        return {
          uri: 'wc:test',
          async approval() {
            return session;
          },
        };
      },
      async disconnect(options) {
        disconnectedTopic = options.topic;
      },
      async getSession(topic) {
        return topic === session.topic ? session : null;
      },
      async request<T>(_options: {
        topic: string;
        chainId: string;
        request: { method: string; params: unknown };
      }) {
        return { signedTxXdr: 'SIGNED_XDR' } as T;
      },
    };

    const adapter = new WalletConnectAdapter(client, {
      networkPassphrase: 'Test SDF Network ; September 2015',
    });

    const connection = await adapter.connect();
    expect(connection.publicKey).toBe('GABC123');
    expect(connection.network).toBe('testnet');
    expect(await adapter.signTransaction('UNSIGNED_XDR', { networkPassphrase: connection.networkPassphrase })).toBe(
      'SIGNED_XDR',
    );

    await adapter.disconnect();
    expect(disconnectedTopic).toBe(session.topic);
    expect(await adapter.isConnected()).toBe(false);
  });

  it('reconnects from a stored session topic', async () => {
    const session = makeSession('topic-2');
    const store = new MemoryWalletConnectSessionStore();
    await store.setSessionTopic(session.topic);

    const client: WalletConnectClient = {
      async connect() {
        throw new Error('connect should not be called during reconnect');
      },
      async disconnect() {
        return;
      },
      async getSession(topic) {
        return topic === session.topic ? session : null;
      },
      async request<T>(_options: {
        topic: string;
        chainId: string;
        request: { method: string; params: unknown };
      }) {
        return 'SIGNED_XDR' as T;
      },
    };

    const adapter = new WalletConnectAdapter(client, { sessionStore: store });
    const connection = await adapter.reconnect();

    expect(connection.publicKey).toBe('GABC123');
    expect(await adapter.getPublicKey()).toBe('GABC123');
  });

  it('parses default network and public key from the stored session', async () => {
    const session = makeSession('topic-4');
    const store = new MemoryWalletConnectSessionStore();
    await store.setSessionTopic(session.topic);

    const client: WalletConnectClient = {
      async connect() {
        throw new Error('unused');
      },
      async disconnect() {
        return;
      },
      async getSession(topic) {
        return topic === session.topic ? session : null;
      },
      async request<T>() {
        return 'SIGNED_XDR' as T;
      },
    };

    const adapter = new WalletConnectAdapter(client, { sessionStore: store });
    await expect(adapter.reconnect()).resolves.toEqual({
      publicKey: 'GABC123',
      network: 'testnet',
      networkPassphrase: 'Test SDF Network ; September 2015',
    });
  });

  it('accepts string WalletConnect signing responses by default', async () => {
    const session = makeSession('topic-5');
    const store = new MemoryWalletConnectSessionStore();
    await store.setSessionTopic(session.topic);

    const client: WalletConnectClient = {
      async connect() {
        throw new Error('unused');
      },
      async disconnect() {
        return;
      },
      async getSession(topic) {
        return topic === session.topic ? session : null;
      },
      async request<T>() {
        return 'SIGNED_XDR' as T;
      },
    };

    const adapter = new WalletConnectAdapter(client, { sessionStore: store });
    await adapter.reconnect();
    await expect(
      adapter.signTransaction('UNSIGNED_XDR', {
        networkPassphrase: 'Test SDF Network ; September 2015',
      }),
    ).resolves.toBe('SIGNED_XDR');
  });
});
