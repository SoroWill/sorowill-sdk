/**
 * Transaction batching helpers (#780).
 *
 * Soroban transactions may contain only a single `InvokeHostFunction`
 * operation, so "batching" on-chain means submitting several contract
 * invocations as one atomic unit: either every invocation lands in the same
 * ledger, or none of them do. This module provides the pure, transport-free
 * pieces of that flow:
 *
 * - {@link validateBatchOperations} — rejects empty batches, malformed
 *   operations, and operations that disagree on the target network before any
 *   transaction is built, signed, or submitted.
 * - {@link buildBatchInvocation} — turns a validated batch into the ordered
 *   list of `(contract, method, args)` invocations the client submits.
 * - {@link aggregateBatchResults} — folds per-operation outcomes into a single
 *   {@link BatchResult}, marking the whole batch failed if any operation
 *   failed (atomicity).
 *
 * The client wires these together in `SoroWillClient.batch`.
 */
import { BatchNetworkMismatchError, UnsupportedBatchSizeError } from './errors';
import type {
  BatchOperation,
  BatchOperationResult,
  BatchOperationResults,
  BatchResult,
} from './types';

/** A single validated contract invocation ready to be submitted. */
export interface BatchInvocation {
  /** Position of the invocation within the batch. */
  index: number;
  /** The contract method to invoke. */
  method: string;
  /** The arguments to the method. */
  args: Record<string, unknown>;
}

/**
 * Validate a batch before any transaction is built.
 *
 * Throws {@link UnsupportedBatchSizeError} for an empty batch and
 * {@link BatchNetworkMismatchError} when an operation declares a network that
 * differs from the client's network or from another operation's network.
 *
 * @param operations The operations to validate.
 * @param clientNetwork The network the client is configured for.
 */
export function validateBatchOperations(
  operations: readonly BatchOperation[],
  clientNetwork: 'testnet' | 'mainnet',
): void {
  if (operations.length === 0) {
    throw new UnsupportedBatchSizeError(0);
  }

  let declaredNetwork: string | undefined;
  let declaredIndex = -1;

  operations.forEach((operation, index) => {
    if (operation.network === undefined) return;

    if (operation.network !== clientNetwork) {
      throw new BatchNetworkMismatchError(clientNetwork, operation.network, index);
    }

    if (declaredNetwork === undefined) {
      declaredNetwork = operation.network;
      declaredIndex = index;
    } else if (declaredNetwork !== operation.network) {
      throw new BatchNetworkMismatchError(
        clientNetwork,
        operation.network,
        index,
        declaredIndex,
        declaredNetwork,
      );
    }
  });
}

/**
 * Build the ordered invocation list for a validated batch.
 *
 * Operations whose `condition` predicate resolves to `false` are omitted, so
 * the returned list may be shorter than the input. The predicate receives the
 * results of all prior operations, in order.
 */
export async function buildBatchInvocation(
  operations: readonly BatchOperation[],
  priorResults: readonly BatchOperationResult[] = [],
): Promise<BatchInvocation[]> {
  const invocations: BatchInvocation[] = [];

  for (let index = 0; index < operations.length; index += 1) {
    const operation = operations[index];
    if (operation.condition && !(await operation.condition(priorResults))) {
      continue;
    }
    invocations.push({ index, method: operation.method, args: operation.args });
  }

  return invocations;
}

/**
 * Fold per-operation outcomes into a single {@link BatchResult}.
 *
 * A batch is atomic: `success` is `true` only when every operation succeeded.
 * The first failure is surfaced as `error` so callers get a clear, typed cause
 * rather than a partial-success result.
 */
export function aggregateBatchResults<TOperations extends readonly BatchOperation[]>(
  operations: TOperations,
  results: BatchOperationResult[],
  txHash: string,
  createdAt: number,
): BatchResult<TOperations> {
  const failure = results.find((result) => result.status !== 'success');

  return {
    success: failure === undefined,
    txHash,
    createdAt,
    results: results as unknown as BatchOperationResults<TOperations>,
    ...(failure?.error ? { error: failure.error } : {}),
  };
}
