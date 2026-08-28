import { rpc } from '@stellar/stellar-sdk';
import type { SoroWillRpcServer } from './SoroWillClient';

export function isRetryableRpcConnectionError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return [
    'fetch failed',
    'network error',
    'failed to fetch',
    'econnrefused',
    'etimedout',
    'timeout',
    'socket hang up',
    'enotfound',
    'econnreset',
    'connection refused',
    'could not connect',
    'unable to connect',
  ].some((fragment) => message.includes(fragment));
}

export class RpcEndpointPool {
  private readonly servers: SoroWillRpcServer[];
  private readonly rpcUrls: string[];
  private activeIndex = 0;

  /**
   * @param serverOverride - When provided (e.g. `SoroWillClientOptions.rpcServer`
   * in tests), every endpoint in the pool uses this server instead of
   * constructing a real `rpc.Server` per URL. Without this, `withFailover`
   * would silently bypass an injected test double and hit the real network.
   */
  constructor(rpcUrls: readonly string[], serverOverride?: SoroWillRpcServer) {
    const normalizedRpcUrls = rpcUrls
      .map((rpcUrl) => rpcUrl.trim())
      .filter((rpcUrl) => rpcUrl.length > 0);

    if (normalizedRpcUrls.length === 0) {
      throw new Error('At least one RPC URL must be configured');
    }

    this.rpcUrls = normalizedRpcUrls;
    this.servers = serverOverride
      ? normalizedRpcUrls.map(() => serverOverride)
      : normalizedRpcUrls.map(
          (rpcUrl) => new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith('http://') }),
        );
  }

  async withFailover<T>(operation: (server: SoroWillRpcServer, rpcUrl: string) => Promise<T>): Promise<T> {
    let lastError: unknown;

    for (let attempt = 0; attempt < this.servers.length; attempt += 1) {
      const rpcUrl = this.rpcUrls[this.activeIndex];
      const server = this.servers[this.activeIndex];

      if (!rpcUrl || !server) {
        break;
      }

      try {
        return await operation(server, rpcUrl);
      } catch (error) {
        lastError = error;
        if (!isRetryableRpcConnectionError(error) || attempt === this.servers.length - 1) {
          throw error;
        }
        this.activeIndex = (this.activeIndex + 1) % this.servers.length;
      }
    }

    throw lastError ?? new Error('RPC failover exhausted every configured endpoint');
  }

  getActiveRpcUrl(): string {
    const rpcUrl = this.rpcUrls[this.activeIndex];
    if (!rpcUrl) {
      throw new Error('No active RPC URL is configured');
    }
    return rpcUrl;
  }
}
