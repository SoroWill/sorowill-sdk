import type { Beneficiary, Will } from './types';

/**
 * A single field-level difference between two versions of a will.
 *
 * `before` and `after` hold the raw values from each version. For
 * {@link WillFieldName} values that are arrays (`beneficiaries`, `guardians`)
 * the values are the full arrays from each side; use
 * {@link WillComparisonEntry.added} / {@link WillComparisonEntry.removed} for
 * the element-level diff.
 *
 * @since 0.2.0
 */
export interface WillComparisonEntry {
  /** Name of the will field that differs. */
  readonly field: WillFieldName;
  /** Value in the earlier version, or `undefined` if the field was absent. */
  readonly before: unknown;
  /** Value in the later version, or `undefined` if the field was absent. */
  readonly after: unknown;
  /** Elements present in `after` but not in `before` (array fields only). */
  readonly added?: readonly unknown[];
  /** Elements present in `before` but not in `after` (array fields only). */
  readonly removed?: readonly unknown[];
}

/** Fields of {@link Will} that {@link compareWills} inspects. */
export type WillFieldName =
  | 'id'
  | 'owner'
  | 'token'
  | 'balance'
  | 'beneficiaries'
  | 'checkinPeriodDays'
  | 'gracePeriodDays'
  | 'lastCheckin'
  | 'triggerTime'
  | 'status'
  | 'guardians'
  | 'guardianVotes';

/** Options for {@link compareWills}. */
export interface CompareWillsOptions {
  /**
   * Timestamp recorded for the earlier version. Defaults to the version's
   * `lastCheckin` when omitted.
   */
  readonly beforeTimestamp?: Date;
  /**
   * Timestamp recorded for the later version. Defaults to the version's
   * `lastCheckin` when omitted.
   */
  readonly afterTimestamp?: Date;
}

/**
 * Result of comparing two versions of a will for auditing.
 *
 * @since 0.2.0
 */
export interface WillComparison {
  /** The will id both versions belong to. */
  readonly willId: string;
  /** Timestamp attributed to the earlier version. */
  readonly beforeTimestamp: Date;
  /** Timestamp attributed to the later version. */
  readonly afterTimestamp: Date;
  /** `true` when no field differs between the two versions. */
  readonly identical: boolean;
  /** Field-level differences, in a stable field order. */
  readonly differences: readonly WillComparisonEntry[];
  /** Convenience list of the differing field names. */
  readonly changedFields: readonly WillFieldName[];
}

const COMPARED_FIELDS: readonly WillFieldName[] = [
  'id',
  'owner',
  'token',
  'balance',
  'beneficiaries',
  'checkinPeriodDays',
  'gracePeriodDays',
  'lastCheckin',
  'triggerTime',
  'status',
  'guardians',
  'guardianVotes',
];

function timeOf(value: Date | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date || b instanceof Date) {
    return timeOf(a as Date) === timeOf(b as Date);
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => sameValue(item, b[i]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const aKeys = Object.keys(a as Record<string, unknown>);
    const bKeys = Object.keys(b as Record<string, unknown>);
    return (
      aKeys.length === bKeys.length &&
      aKeys.every((key) =>
        sameValue(
          (a as Record<string, unknown>)[key],
          (b as Record<string, unknown>)[key],
        ),
      )
    );
  }
  return a === b;
}

function beneficiaryKey(beneficiary: Beneficiary): string {
  return `${beneficiary.address}:${beneficiary.percentage}`;
}

function diffArray(
  before: readonly unknown[],
  after: readonly unknown[],
  keyOf: (item: unknown) => string,
): { added: unknown[]; removed: unknown[] } {
  const beforeKeys = new Set(before.map(keyOf));
  const afterKeys = new Set(after.map(keyOf));
  return {
    added: after.filter((item) => !beforeKeys.has(keyOf(item))),
    removed: before.filter((item) => !afterKeys.has(keyOf(item))),
  };
}

function arrayKey(item: unknown): string {
  if (item && typeof item === 'object' && 'address' in item) {
    return beneficiaryKey(item as Beneficiary);
  }
  return String(item);
}

/**
 * Compares two versions of a will for auditing, reporting every field that
 * changed and the timestamps attributed to each version.
 *
 * Comparison is order-insensitive for `beneficiaries` and `guardians`, and
 * `Date` fields are compared by instant rather than object identity.
 *
 * @example
 * ```ts
 * const diff = compareWills(previous, current, {
 *   beforeTimestamp: new Date('2026-01-01T00:00:00Z'),
 *   afterTimestamp: new Date('2026-02-01T00:00:00Z'),
 * });
 * if (!diff.identical) console.log(diff.changedFields);
 * ```
 *
 * @since 0.2.0
 */
export function compareWills(
  before: Will,
  after: Will,
  options: CompareWillsOptions = {},
): WillComparison {
  const differences: WillComparisonEntry[] = [];

  for (const field of COMPARED_FIELDS) {
    const beforeValue = before[field] as unknown;
    const afterValue = after[field] as unknown;

    if (field === 'beneficiaries' || field === 'guardians') {
      const beforeList = (beforeValue ?? []) as readonly unknown[];
      const afterList = (afterValue ?? []) as readonly unknown[];
      const { added, removed } = diffArray(beforeList, afterList, arrayKey);
      if (added.length > 0 || removed.length > 0) {
        differences.push({
          field,
          before: beforeList,
          after: afterList,
          added,
          removed,
        });
      }
      continue;
    }

    if (!sameValue(beforeValue, afterValue)) {
      differences.push({ field, before: beforeValue, after: afterValue });
    }
  }

  return {
    willId: after.id,
    beforeTimestamp: options.beforeTimestamp ?? before.lastCheckin,
    afterTimestamp: options.afterTimestamp ?? after.lastCheckin,
    identical: differences.length === 0,
    differences,
    changedFields: differences.map((entry) => entry.field),
  };
}
