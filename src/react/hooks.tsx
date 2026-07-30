import { useCallback, useEffect, useRef, useState } from 'react';

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
  const clientRef = useRef<SoroWillClient | null>(null);

  if (clientRef.current === null) {
    clientRef.current = new SoroWillClient(options);
  }

  return clientRef.current;
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

    let cancelled = false;
    setLoading(true);
    setError(null);

    client
      .getWill(willId)
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

    let cancelled = false;
    setLoading(true);
    setError(null);

    client
      .getWillsByOwner(owner)
      .then((wills) => {
        if (!cancelled) {
          const resolvedWills = Array.isArray(wills) ? wills : (wills as { wills?: Will[] }).wills ?? [];
          setData(resolvedWills);
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

    let cancelled = false;
    setLoading(true);
    setError(null);

    client
      .getWillsByBeneficiary(beneficiary)
      .then((wills) => {
        if (!cancelled) {
          const resolvedWills = Array.isArray(wills) ? wills : (wills as { wills?: Will[] }).wills ?? [];
          setData(resolvedWills);
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
    };
  }, [client, beneficiary, fetchKey]);

  return { data, error, loading, refetch };
}
