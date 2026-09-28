import { createRequire } from 'node:module';
import type ReactNamespace from 'react';

import { SoroWillClient } from '../SoroWillClient';
import type { SoroWillClientOptions } from '../SoroWillClient';
import type { Will } from '../types';

/**
 * `react` is an optional peer dependency of this subpath — a static
 * `import ... from 'react'` would fail to resolve for a consumer that hasn't
 * installed it, even before any hook is actually called. Loading it lazily
 * via `createRequire` means the module only needs to resolve when a hook in
 * this file actually runs.
 */
let react: typeof ReactNamespace | undefined;
function getReact(): typeof ReactNamespace {
  if (!react) {
    react = createRequire(import.meta.url)('react');
  }
  return react!;
}

/** Standard data-fetching state returned by the hooks. */
export interface UseQueryResult<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  refetch: () => void;
}

function useSoroWillClient(options: SoroWillClientOptions): SoroWillClient {
  const client = getReact().useMemo(
    () => new SoroWillClient(options),
    [options.network, options.contractId],
  );

  getReact().useEffect(() => {
    return () => client.destroy();
  }, [client]);

  return client;
}

/**
 * Fetch a single will by its on-chain ID.
 *
 * @example
 * ```tsx
 * const { data, loading, error } = useWill({ network: 'testnet', contractId: '...' }, '42');
 * ```
 */
export function useWill(
  clientOptions: SoroWillClientOptions,
  willId: string | null,
): UseQueryResult<Will> {
  const client = useSoroWillClient(clientOptions);
  const [data, setData] = getReact().useState<Will | null>(null);
  const [error, setError] = getReact().useState<Error | null>(null);
  const [loading, setLoading] = getReact().useState(false);
  const [fetchKey, setFetchKey] = getReact().useState(0);

  const refetch = getReact().useCallback(() => setFetchKey((k) => k + 1), []);

  getReact().useEffect(() => {
    if (!willId) {
      setData(null);
      return;
    }

    const controller = new AbortController();
    let cancelled = false;
    setLoading(true);
    setError(null);

    client
      .getWill(willId, { signal: controller.signal })
      .then((will) => {
        if (!cancelled) {
          setData(will);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err : new Error(String(err)));
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [client, willId, fetchKey]);

  return { data, error, loading, refetch };
}

/**
 * Fetch all wills owned by a Stellar address.
 *
 * @example
 * ```tsx
 * const { data, loading, error } = useWillsByOwner({ network: 'testnet', contractId: '...' }, 'G...');
 * ```
 */
export function useWillsByOwner(
  clientOptions: SoroWillClientOptions,
  owner: string | null,
): UseQueryResult<Will[]> {
  const client = useSoroWillClient(clientOptions);
  const [data, setData] = getReact().useState<Will[] | null>(null);
  const [error, setError] = getReact().useState<Error | null>(null);
  const [loading, setLoading] = getReact().useState(false);
  const [fetchKey, setFetchKey] = getReact().useState(0);

  const refetch = getReact().useCallback(() => setFetchKey((k) => k + 1), []);

  getReact().useEffect(() => {
    if (!owner) {
      setData(null);
      return;
    }

    const controller = new AbortController();
    let cancelled = false;
    setLoading(true);
    setError(null);

    client
      .getWillsByOwner(owner, { signal: controller.signal })
      .then((wills) => {
        if (!cancelled) {
          setData(wills);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err : new Error(String(err)));
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [client, owner, fetchKey]);

  return { data, error, loading, refetch };
}

/**
 * Fetch all wills where a given address is named as a beneficiary.
 *
 * @example
 * ```tsx
 * const { data, loading, error } = useWillsByBeneficiary({ network: 'testnet', contractId: '...' }, 'G...');
 * ```
 */
export function useWillsByBeneficiary(
  clientOptions: SoroWillClientOptions,
  beneficiary: string | null,
): UseQueryResult<Will[]> {
  const client = useSoroWillClient(clientOptions);
  const [data, setData] = getReact().useState<Will[] | null>(null);
  const [error, setError] = getReact().useState<Error | null>(null);
  const [loading, setLoading] = getReact().useState(false);
  const [fetchKey, setFetchKey] = getReact().useState(0);

  const refetch = getReact().useCallback(() => setFetchKey((k) => k + 1), []);

  getReact().useEffect(() => {
    if (!beneficiary) {
      setData(null);
      return;
    }

    const controller = new AbortController();
    let cancelled = false;
    setLoading(true);
    setError(null);

    client
      .getWillsByBeneficiary(beneficiary, { signal: controller.signal })
      .then((wills) => {
        if (!cancelled) {
          setData(wills);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err : new Error(String(err)));
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [client, beneficiary, fetchKey]);

  return { data, error, loading, refetch };
}
