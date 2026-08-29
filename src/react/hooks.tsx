import { useCallback, useEffect, useMemo, useState } from 'react';

import { SoroWillClient } from '../SoroWillClient';
import type { SoroWillClientOptions } from '../SoroWillClient';
import type { Will } from '../types';

/** Standard data-fetching state returned by the hooks. */
export interface UseQueryResult<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  refetch: () => void;
}

function useSoroWillClient(options: SoroWillClientOptions): SoroWillClient {
  const client = useMemo(
    () => new SoroWillClient(options),
    [options.network, options.contractId],
  );

  useEffect(() => {
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
  const [data, setData] = useState<Will | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(false);
  const [fetchKey, setFetchKey] = useState(0);

  const refetch = useCallback(() => setFetchKey((k) => k + 1), []);

  useEffect(() => {
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
  const [data, setData] = useState<Will[] | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(false);
  const [fetchKey, setFetchKey] = useState(0);

  const refetch = useCallback(() => setFetchKey((k) => k + 1), []);

  useEffect(() => {
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
  const [data, setData] = useState<Will[] | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(false);
  const [fetchKey, setFetchKey] = useState(0);

  const refetch = useCallback(() => setFetchKey((k) => k + 1), []);

  useEffect(() => {
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
