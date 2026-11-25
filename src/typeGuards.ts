/**
 * Runtime TypeScript type guards for SoroWill SDK data models (#707).
 *
 * Validates structure and data constraints at runtime for values decoded from
 * RPC responses or external inputs so malformed data is caught early.
 */

import { StrKey } from '@stellar/stellar-sdk';
import {
  WillStatus,
  type BatchOperationResult,
  type BatchResult,
  type Beneficiary,
  type CreateWillParams,
  type PaginatedWillsResult,
  type SoroWillEvent,
  type UpdateBeneficiariesParams,
  type Will,
} from './types';

/**
 * Minimal runtime shape of a Soroban RPC transaction response.
 */
export interface RpcTransaction {
  readonly status: string;
  readonly hash?: string;
  readonly txHash?: string;
  readonly ledger?: number;
  readonly createdAt?: number | string;
  readonly resultXdr?: string;
  readonly resultMetaXdr?: string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isValidDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

const VALID_WILL_STATUSES = new Set<string>(Object.values(WillStatus));

/**
 * Type guard for {@link WillStatus}.
 */
export function isWillStatus(value: unknown): value is WillStatus {
  return typeof value === 'string' && VALID_WILL_STATUSES.has(value);
}

/**
 * Type guard for {@link Beneficiary}.
 * Validates that `address` is a valid Stellar Ed25519 public key (`G...`)
 * and `percentage` is a finite number in `[0, 100]`.
 */
export function isBeneficiaryRecord(value: unknown): value is Beneficiary {
  if (!isPlainRecord(value)) {
    return false;
  }
  return (
    typeof value.address === 'string' &&
    StrKey.isValidEd25519PublicKey(value.address) &&
    typeof value.percentage === 'number' &&
    Number.isFinite(value.percentage) &&
    value.percentage >= 0 &&
    value.percentage <= 100
  );
}

/**
 * Type guard for {@link Will}.
 * Validates all required fields, Stellar address formats, numeric bounds,
 * dates, and nested beneficiary entries.
 */
export function isWill(value: unknown): value is Will {
  if (!isPlainRecord(value)) {
    return false;
  }
  if (!isNonEmptyString(value.id)) {
    return false;
  }
  if (typeof value.owner !== 'string' || !StrKey.isValidEd25519PublicKey(value.owner)) {
    return false;
  }
  if (typeof value.token !== 'string' || !StrKey.isValidContract(value.token)) {
    return false;
  }
  if (typeof value.balance !== 'string' || !/^\d+$/.test(value.balance)) {
    return false;
  }
  if (!Array.isArray(value.beneficiaries) || !value.beneficiaries.every(isBeneficiaryRecord)) {
    return false;
  }
  if (
    typeof value.checkinPeriodDays !== 'number' ||
    !Number.isInteger(value.checkinPeriodDays) ||
    value.checkinPeriodDays <= 0
  ) {
    return false;
  }
  if (
    typeof value.gracePeriodDays !== 'number' ||
    !Number.isInteger(value.gracePeriodDays) ||
    value.gracePeriodDays < 0
  ) {
    return false;
  }
  if (!isValidDate(value.lastCheckin)) {
    return false;
  }
  if (value.triggerTime !== null && !isValidDate(value.triggerTime)) {
    return false;
  }
  if (value.releaseAfter !== undefined && value.releaseAfter !== null && !isValidDate(value.releaseAfter)) {
    return false;
  }
  if (!isWillStatus(value.status)) {
    return false;
  }
  if (
    !Array.isArray(value.guardians) ||
    !value.guardians.every((g) => typeof g === 'string' && StrKey.isValidEd25519PublicKey(g))
  ) {
    return false;
  }
  if (
    typeof value.guardianVotes !== 'number' ||
    !Number.isInteger(value.guardianVotes) ||
    value.guardianVotes < 0
  ) {
    return false;
  }
  return true;
}

/**
 * Type guard for {@link RpcTransaction}.
 * Validates Soroban RPC transaction responses (`status` and optional metadata).
 */
export function isTransaction(value: unknown): value is RpcTransaction {
  if (!isPlainRecord(value)) {
    return false;
  }
  if (!isNonEmptyString(value.status)) {
    return false;
  }
  if (value.hash !== undefined && !isNonEmptyString(value.hash)) {
    return false;
  }
  if (value.txHash !== undefined && !isNonEmptyString(value.txHash)) {
    return false;
  }
  if (
    value.ledger !== undefined &&
    (typeof value.ledger !== 'number' || !Number.isInteger(value.ledger) || value.ledger < 0)
  ) {
    return false;
  }
  if (
    value.createdAt !== undefined &&
    !(
      (typeof value.createdAt === 'number' && Number.isFinite(value.createdAt)) ||
      isNonEmptyString(value.createdAt)
    )
  ) {
    return false;
  }
  if (value.resultXdr !== undefined && typeof value.resultXdr !== 'string') {
    return false;
  }
  if (value.resultMetaXdr !== undefined && typeof value.resultMetaXdr !== 'string') {
    return false;
  }
  return true;
}

/**
 * Type guard for {@link SoroWillEvent}.
 */
export function isSoroWillEvent(value: unknown): value is SoroWillEvent {
  if (!isPlainRecord(value)) {
    return false;
  }
  if (!isNonEmptyString(value.id) || !isNonEmptyString(value.type)) {
    return false;
  }
  if (typeof value.cursor !== 'string') {
    return false;
  }
  if (
    value.ledger !== null &&
    (typeof value.ledger !== 'number' || !Number.isInteger(value.ledger) || value.ledger < 0)
  ) {
    return false;
  }
  if (value.ledgerClosedAt !== null && !isValidDate(value.ledgerClosedAt)) {
    return false;
  }
  if (typeof value.contractId !== 'string' || !StrKey.isValidContract(value.contractId)) {
    return false;
  }
  if (value.txHash !== null && !isNonEmptyString(value.txHash)) {
    return false;
  }
  if (!Array.isArray(value.topics)) {
    return false;
  }
  return 'value' in value && 'raw' in value;
}

/**
 * Type guard for {@link PaginatedWillsResult}.
 */
export function isPaginatedWillsResult(value: unknown): value is PaginatedWillsResult {
  if (!isPlainRecord(value)) {
    return false;
  }
  if (!Array.isArray(value.wills) || !value.wills.every(isWill)) {
    return false;
  }
  return value.nextCursor === null || isNonEmptyString(value.nextCursor);
}

/**
 * Type guard for {@link CreateWillParams}.
 */
export function isCreateWillParams(value: unknown): value is CreateWillParams {
  if (!isPlainRecord(value)) {
    return false;
  }
  if (typeof value.token !== 'string' || !StrKey.isValidContract(value.token)) {
    return false;
  }
  if (typeof value.amount !== 'string' || !/^\d+$/.test(value.amount)) {
    return false;
  }
  if (
    !Array.isArray(value.beneficiaries) ||
    value.beneficiaries.length === 0 ||
    !value.beneficiaries.every(isBeneficiaryRecord)
  ) {
    return false;
  }
  if (
    typeof value.checkinPeriodDays !== 'number' ||
    !Number.isInteger(value.checkinPeriodDays) ||
    value.checkinPeriodDays <= 0
  ) {
    return false;
  }
  if (
    typeof value.gracePeriodDays !== 'number' ||
    !Number.isInteger(value.gracePeriodDays) ||
    value.gracePeriodDays < 0
  ) {
    return false;
  }
  return (
    Array.isArray(value.guardians) &&
    value.guardians.every((g) => typeof g === 'string' && StrKey.isValidEd25519PublicKey(g)) &&
    (value.timeLockDays === undefined ||
      (typeof value.timeLockDays === 'number' &&
        Number.isInteger(value.timeLockDays) &&
        value.timeLockDays > 0)) &&
    (value.releaseAfter === undefined || isValidDate(value.releaseAfter))
  );
}

/**
 * Type guard for {@link UpdateBeneficiariesParams}.
 */
export function isUpdateBeneficiariesParams(value: unknown): value is UpdateBeneficiariesParams {
  if (!isPlainRecord(value)) {
    return false;
  }
  return (
    isNonEmptyString(value.willId) &&
    Array.isArray(value.beneficiaries) &&
    value.beneficiaries.length > 0 &&
    value.beneficiaries.every(isBeneficiaryRecord)
  );
}

const VALID_BATCH_STATUSES = new Set<string>(['success', 'failed', 'skipped']);

/**
 * Type guard for {@link BatchOperationResult}.
 */
export function isBatchOperationResult(value: unknown): value is BatchOperationResult {
  if (!isPlainRecord(value)) {
    return false;
  }
  if (typeof value.index !== 'number' || !Number.isInteger(value.index) || value.index < 0) {
    return false;
  }
  if (!isNonEmptyString(value.method)) {
    return false;
  }
  if (typeof value.status !== 'string' || !VALID_BATCH_STATUSES.has(value.status)) {
    return false;
  }
  if (
    typeof value.attempts !== 'number' ||
    !Number.isInteger(value.attempts) ||
    value.attempts < 0
  ) {
    return false;
  }
  if (value.txHash !== undefined && typeof value.txHash !== 'string') {
    return false;
  }
  if (value.error !== undefined && !(value.error instanceof Error)) {
    return false;
  }
  return true;
}

/**
 * Type guard for {@link BatchResult}.
 */
export function isBatchResult(value: unknown): value is BatchResult {
  if (!isPlainRecord(value)) {
    return false;
  }
  if (typeof value.success !== 'boolean') {
    return false;
  }
  if (typeof value.txHash !== 'string') {
    return false;
  }
  if (typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt)) {
    return false;
  }
  if (!Array.isArray(value.results) || !value.results.every(isBatchOperationResult)) {
    return false;
  }
  if (value.error !== undefined && !(value.error instanceof Error)) {
    return false;
  }
  return true;
}
