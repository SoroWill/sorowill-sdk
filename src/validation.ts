/**
 * Input and response validation utilities for batch-204 improvements (#621-624).
 *
 * Provides validation for:
 * - RPC response envelopes (security)
 * - Will IDs (format)
 * - Sequence numbers (transaction reliability)
 * - Signature collection timeouts (multisig reliability)
 */

import { StrKey } from '@stellar/stellar-sdk';

/**
 * Validates that a will ID is a non-empty string.
 * Prevents invalid IDs from being sent to RPC.
 *
 * @param willId - The will ID to validate.
 * @throws {Error} when will ID is missing or empty.
 */
export function validateWillId(willId: unknown): asserts willId is string {
  if (typeof willId !== 'string' || willId.trim().length === 0) {
    throw new Error(`Invalid will ID: expected a non-empty string, got ${typeof willId}`);
  }
}

/**
 * Validates that a sequence number is a valid, non-negative integer.
 *
 * @param sequence - The sequence number to validate.
 * @throws {Error} when sequence is invalid.
 */
export function validateSequenceNumber(sequence: unknown): asserts sequence is number {
  if (!Number.isInteger(sequence) || (sequence as number) < 0) {
    throw new RangeError(
      `Invalid sequence number: expected a non-negative integer, got ${typeof sequence}: ${sequence}`,
    );
  }
}

/**
 * Validates that an account address is a valid Stellar public key.
 *
 * @param address - The address to validate.
 * @throws {Error} when address is not a valid Stellar account.
 */
export function validateAccountAddress(address: unknown): asserts address is string {
  if (typeof address !== 'string' || !StrKey.isValidEd25519PublicKey(address)) {
    throw new Error(
      `Invalid account address: expected a valid Stellar public key, got ${typeof address}`,
    );
  }
}

/**
 * RPC response envelope structure expected from Soroban RPC.
 * Validates before XDR decoding to prevent malicious responses.
 */
export interface RpcResponseEnvelope {
  jsonrpc: string;
  id?: string | number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

/**
 * Validates RPC response envelope structure before XDR decoding (#622).
 *
 * Checks that the response has valid JSON-RPC structure to prevent
 * malformed responses from reaching XDR parsers.
 *
 * @param response - The RPC response to validate.
 * @throws {Error} when response structure is invalid.
 * @returns The validated response.
 */
export function validateRpcResponseEnvelope(response: unknown): RpcResponseEnvelope {
  if (!response || typeof response !== 'object') {
    throw new Error(
      `Invalid RPC response envelope: expected an object, got ${typeof response}`,
    );
  }

  const envelope = response as Record<string, unknown>;

  // Validate required jsonrpc field
  if (typeof envelope.jsonrpc !== 'string') {
    throw new Error(
      `Invalid RPC response envelope: missing or invalid 'jsonrpc' field, got ${typeof envelope.jsonrpc}`,
    );
  }

  // Validate jsonrpc version
  if (envelope.jsonrpc !== '2.0') {
    throw new Error(
      `Invalid RPC response envelope: unsupported jsonrpc version '${envelope.jsonrpc}', expected '2.0'`,
    );
  }

  // Check for error or result, but not both
  const hasError = 'error' in envelope && envelope.error !== null && envelope.error !== undefined;
  const hasResult = 'result' in envelope && envelope.result !== undefined;

  if (!hasError && !hasResult) {
    throw new Error(
      `Invalid RPC response envelope: must contain either 'result' or 'error' field`,
    );
  }

  if (hasError && hasResult) {
    throw new Error(
      `Invalid RPC response envelope: must not contain both 'result' and 'error' fields`,
    );
  }

  // Validate error structure if present
  if (hasError) {
    const error = envelope.error as Record<string, unknown>;
    if (typeof error.code !== 'number') {
      throw new Error(
        `Invalid RPC response envelope: error.code must be a number, got ${typeof error.code}`,
      );
    }
    if (typeof error.message !== 'string') {
      throw new Error(
        `Invalid RPC response envelope: error.message must be a string, got ${typeof error.message}`,
      );
    }
  }

  return envelope as RpcResponseEnvelope;
}

/**
 * Options for multisig signature collection timeout (#621).
 */
export interface SignatureCollectionOptions {
  /** Timeout in milliseconds to wait for all signatures. Defaults to 120000 (2 min). */
  timeoutMs?: number;
  /** Minimum number of signatures required. Defaults to 1. */
  minSignatures?: number;
  /** Maximum number of signatures to collect. Defaults to Infinity. */
  maxSignatures?: number;
}

/**
 * Validates signature collection options and applies defaults.
 *
 * @param options - Options to validate.
 * @returns Options with defaults applied.
 * @throws {Error} when options are invalid.
 */
export function validateSignatureCollectionOptions(
  options?: SignatureCollectionOptions,
): Required<SignatureCollectionOptions> {
  const timeoutMs = options?.timeoutMs ?? 120_000;
  const minSignatures = options?.minSignatures ?? 1;
  const maxSignatures = options?.maxSignatures ?? Infinity;

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('timeoutMs must be a positive finite number');
  }

  if (!Number.isInteger(minSignatures) || minSignatures < 1) {
    throw new RangeError('minSignatures must be a positive integer');
  }

  if (maxSignatures !== Infinity && (!Number.isInteger(maxSignatures) || maxSignatures < minSignatures)) {
    throw new RangeError('maxSignatures must be >= minSignatures');
  }

  return {
    timeoutMs: Math.floor(timeoutMs),
    minSignatures,
    maxSignatures,
  };
}
