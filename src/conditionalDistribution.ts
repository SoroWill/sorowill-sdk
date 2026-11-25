/**
 * Conditional beneficiary distribution (#819).
 *
 * Lets a will's distribution amounts be determined by conditions evaluated at
 * distribution time instead of a fixed percentage. A condition tree is
 * evaluated against a caller-supplied {@link ConditionContext}; the first
 * matching rule wins, and its `percentage` (or `amount`) is allocated to the
 * rule's beneficiary. Unallocated remainder is split across the will's
 * beneficiaries by their declared percentages.
 *
 * All arithmetic is done in stroops (`bigint`) so no precision is lost.
 */

import { SoroWillError } from './errors';
import type { Beneficiary } from './types';

/** Raised when a condition tree is malformed or cannot be evaluated. */
export class InvalidDistributionConditionError extends SoroWillError {
  /** Path to the offending node, e.g. `rules[0].when.AND[1]`. */
  readonly path: string;

  constructor(message: string, path: string, options?: ErrorOptions) {
    super(`Invalid distribution condition at ${path}: ${message}`, options);
    this.path = path;
  }
}

/** Raised when a distribution plan cannot be satisfied (e.g. over-allocation). */
export class DistributionAllocationError extends SoroWillError {
  /** Total stroops requested by the rules, when known. */
  readonly requestedStroops?: bigint;
  /** Total stroops available for distribution, when known. */
  readonly availableStroops?: bigint;

  constructor(
    message: string,
    details?: { requestedStroops?: bigint; availableStroops?: bigint },
    options?: ErrorOptions,
  ) {
    super(message, options);
    if (details?.requestedStroops !== undefined) {
      this.requestedStroops = details.requestedStroops;
    }
    if (details?.availableStroops !== undefined) {
      this.availableStroops = details.availableStroops;
    }
  }
}

/**
 * Facts a condition is evaluated against. Every field is optional so callers
 * only supply what their conditions need; a condition referencing a missing
 * fact evaluates to `false` rather than throwing.
 */
export interface ConditionContext {
  /** Current time in milliseconds since the epoch. Defaults to `Date.now()`. */
  readonly now?: number;
  /** Beneficiary address the distribution is being computed for. */
  readonly beneficiary?: string;
  /** Will status string (e.g. `'Triggered'`). */
  readonly willStatus?: string;
  /** Will balance in stroops. */
  readonly balanceStroops?: bigint;
  /** Arbitrary caller-supplied facts, e.g. `{ guardianApproved: true }`. */
  readonly facts?: Readonly<Record<string, unknown>>;
}

/** Comparison operators supported by {@link ComparisonCondition}. */
export type ComparisonOperator =
  | 'eq'
  | 'neq'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'in'
  | 'contains';

/** Compares a context fact against a literal value. */
export interface ComparisonCondition {
  /** Fact name resolved from {@link ConditionContext.facts}. */
  readonly fact: string;
  readonly op: ComparisonOperator;
  readonly value: unknown;
}

/** Matches when the current time is at or after `after` (ms since epoch). */
export interface TimeAfterCondition {
  readonly timeAfter: number;
}

/** Matches when the current time is before `before` (ms since epoch). */
export interface TimeBeforeCondition {
  readonly timeBefore: number;
}

/** Matches when the will's status is one of `statuses`. */
export interface WillStatusCondition {
  readonly willStatus: readonly string[];
}

/** Matches when the will balance is at least `minStroops`. */
export interface BalanceAtLeastCondition {
  readonly balanceAtLeastStroops: bigint;
}

/** All sub-conditions must match. */
export interface AndCondition {
  readonly AND: readonly DistributionCondition[];
}

/** Any sub-condition may match. */
export interface OrCondition {
  readonly OR: readonly DistributionCondition[];
}

/** Inverts a sub-condition. */
export interface NotCondition {
  readonly NOT: DistributionCondition;
}

/** A condition tree node. */
export type DistributionCondition =
  | ComparisonCondition
  | TimeAfterCondition
  | TimeBeforeCondition
  | WillStatusCondition
  | BalanceAtLeastCondition
  | AndCondition
  | OrCondition
  | NotCondition;

/** A single conditional distribution rule. */
export interface ConditionalDistributionRule {
  /** Beneficiary address this rule allocates to. */
  readonly beneficiary: string;
  /** Condition that must match for the rule to apply. Omitted means "always". */
  readonly when?: DistributionCondition;
  /** Percentage (0-100) of the distributable balance to allocate. */
  readonly percentage?: number;
  /** Fixed amount in stroops to allocate. Mutually exclusive with `percentage`. */
  readonly amountStroops?: bigint;
}

/** Options for {@link planConditionalDistribution}. */
export interface ConditionalDistributionOptions {
  /** Total amount to distribute, in stroops. */
  readonly totalStroops: bigint;
  /** Beneficiaries and their fallback percentages (must sum to 100). */
  readonly beneficiaries: readonly Beneficiary[];
  /** Rules evaluated in order; the first matching rule per beneficiary wins. */
  readonly rules: readonly ConditionalDistributionRule[];
  /** Facts used to evaluate conditions. */
  readonly context?: ConditionContext;
}

/** One beneficiary's computed allocation. */
export interface ConditionalDistributionAllocation {
  readonly beneficiary: string;
  readonly amountStroops: bigint;
  /** Index of the rule that produced the allocation, or `null` for the fallback split. */
  readonly ruleIndex: number | null;
}

/** Result of {@link planConditionalDistribution}. */
export interface ConditionalDistributionPlan {
  readonly allocations: readonly ConditionalDistributionAllocation[];
  /** Stroops allocated by matching rules. */
  readonly conditionalStroops: bigint;
  /** Stroops split by fallback percentages. */
  readonly fallbackStroops: bigint;
  /** Stroops that could not be allocated (rounding dust). */
  readonly unallocatedStroops: bigint;
}

function resolveFact(context: ConditionContext, fact: string): unknown {
  switch (fact) {
    case 'now':
      return context.now ?? Date.now();
    case 'beneficiary':
      return context.beneficiary;
    case 'willStatus':
      return context.willStatus;
    case 'balanceStroops':
      return context.balanceStroops;
    default:
      return context.facts?.[fact];
  }
}

function compare(actual: unknown, op: ComparisonOperator, expected: unknown): boolean {
  switch (op) {
    case 'eq':
      return actual === expected;
    case 'neq':
      return actual !== expected;
    case 'in':
      return Array.isArray(expected) && expected.includes(actual);
    case 'contains':
      return (
        (typeof actual === 'string' && typeof expected === 'string' && actual.includes(expected)) ||
        (Array.isArray(actual) && actual.includes(expected))
      );
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const a = toComparable(actual);
      const b = toComparable(expected);
      if (a === null || b === null) {
        return false;
      }
      if (op === 'gt') return a > b;
      if (op === 'gte') return a >= b;
      if (op === 'lt') return a < b;
      return a <= b;
    }
    default:
      return false;
  }
}

function toComparable(value: unknown): number | bigint | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'bigint') {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) {
    return Number(value);
  }
  return null;
}

/**
 * Evaluates a condition tree against a context.
 *
 * @param condition - The condition to evaluate.
 * @param context - Facts to evaluate against.
 * @returns `true` when the condition matches.
 * @throws {InvalidDistributionConditionError} when the tree is malformed.
 */
export function evaluateDistributionCondition(
  condition: DistributionCondition,
  context: ConditionContext = {},
  path = 'condition',
): boolean {
  if (typeof condition !== 'object' || condition === null) {
    throw new InvalidDistributionConditionError('expected an object', path);
  }

  if ('AND' in condition) {
    const children = condition.AND;
    if (!Array.isArray(children) || children.length === 0) {
      throw new InvalidDistributionConditionError('AND requires a non-empty array', path);
    }
    return children.every((child, i) =>
      evaluateDistributionCondition(child, context, `${path}.AND[${i}]`),
    );
  }

  if ('OR' in condition) {
    const children = condition.OR;
    if (!Array.isArray(children) || children.length === 0) {
      throw new InvalidDistributionConditionError('OR requires a non-empty array', path);
    }
    return children.some((child, i) =>
      evaluateDistributionCondition(child, context, `${path}.OR[${i}]`),
    );
  }

  if ('NOT' in condition) {
    return !evaluateDistributionCondition(condition.NOT, context, `${path}.NOT`);
  }

  if ('fact' in condition) {
    const { fact, op, value } = condition;
    if (typeof fact !== 'string' || fact.length === 0) {
      throw new InvalidDistributionConditionError('fact must be a non-empty string', path);
    }
    return compare(resolveFact(context, fact), op, value);
  }

  if ('timeAfter' in condition) {
    return (context.now ?? Date.now()) >= condition.timeAfter;
  }

  if ('timeBefore' in condition) {
    return (context.now ?? Date.now()) < condition.timeBefore;
  }

  if ('willStatus' in condition) {
    const statuses = condition.willStatus;
    if (!Array.isArray(statuses) || statuses.length === 0) {
      throw new InvalidDistributionConditionError('willStatus requires a non-empty array', path);
    }
    return context.willStatus !== undefined && statuses.includes(context.willStatus);
  }

  if ('balanceAtLeastStroops' in condition) {
    return context.balanceStroops !== undefined && context.balanceStroops >= condition.balanceAtLeastStroops;
  }

  throw new InvalidDistributionConditionError('unrecognized condition node', path);
}

/**
 * Computes per-beneficiary distribution amounts, applying conditional rules
 * first and splitting any remainder by the beneficiaries' percentages.
 *
 * @param options - Distribution inputs.
 * @returns The allocation plan.
 * @throws {DistributionAllocationError} when rules over-allocate the total.
 * @throws {InvalidDistributionConditionError} when a condition is malformed.
 */
export function planConditionalDistribution(
  options: ConditionalDistributionOptions,
): ConditionalDistributionPlan {
  const { totalStroops, beneficiaries, rules, context = {} } = options;

  if (typeof totalStroops !== 'bigint' || totalStroops < 0n) {
    throw new DistributionAllocationError('totalStroops must be a non-negative bigint');
  }

  const known = new Set(beneficiaries.map((b) => b.address));
  const allocated = new Map<string, { amountStroops: bigint; ruleIndex: number }>();
  let conditionalStroops = 0n;

  rules.forEach((rule, index) => {
    const path = `rules[${index}]`;
    if (!known.has(rule.beneficiary)) {
      throw new DistributionAllocationError(
        `Rule ${index} targets unknown beneficiary ${rule.beneficiary}`,
      );
    }
    if (allocated.has(rule.beneficiary)) {
      return;
    }
    if (rule.percentage !== undefined && rule.amountStroops !== undefined) {
      throw new InvalidDistributionConditionError(
        'percentage and amountStroops are mutually exclusive',
        path,
      );
    }
    if (rule.when !== undefined && !evaluateDistributionCondition(rule.when, context, `${path}.when`)) {
      return;
    }

    let amount: bigint;
    if (rule.amountStroops !== undefined) {
      if (rule.amountStroops < 0n) {
        throw new InvalidDistributionConditionError('amountStroops must be non-negative', path);
      }
      amount = rule.amountStroops;
    } else if (rule.percentage !== undefined) {
      if (!Number.isFinite(rule.percentage) || rule.percentage < 0 || rule.percentage > 100) {
        throw new InvalidDistributionConditionError('percentage must be within 0-100', path);
      }
      amount = (totalStroops * BigInt(Math.round(rule.percentage * 100))) / 10_000n;
    } else {
      throw new InvalidDistributionConditionError(
        'rule must specify percentage or amountStroops',
        path,
      );
    }

    if (conditionalStroops + amount > totalStroops) {
      throw new DistributionAllocationError(
        'Conditional rules allocate more than the distributable total',
        { requestedStroops: conditionalStroops + amount, availableStroops: totalStroops },
      );
    }

    allocated.set(rule.beneficiary, { amountStroops: amount, ruleIndex: index });
    conditionalStroops += amount;
  });

  const fallbackStroops = totalStroops - conditionalStroops;
  const fallbackBeneficiaries = beneficiaries.filter((b) => !allocated.has(b.address));
  const fallbackWeight = fallbackBeneficiaries.reduce((sum, b) => sum + b.percentage, 0);

  const allocations: ConditionalDistributionAllocation[] = [];
  let distributed = 0n;

  for (const beneficiary of beneficiaries) {
    const fixed = allocated.get(beneficiary.address);
    if (fixed) {
      allocations.push({
        beneficiary: beneficiary.address,
        amountStroops: fixed.amountStroops,
        ruleIndex: fixed.ruleIndex,
      });
      distributed += fixed.amountStroops;
      continue;
    }
    const share =
      fallbackWeight > 0
        ? (fallbackStroops * BigInt(Math.round(beneficiary.percentage * 100))) /
          BigInt(Math.round(fallbackWeight * 100))
        : 0n;
    allocations.push({
      beneficiary: beneficiary.address,
      amountStroops: share,
      ruleIndex: null,
    });
    distributed += share;
  }

  return {
    allocations,
    conditionalStroops,
    fallbackStroops,
    unallocatedStroops: totalStroops - distributed,
  };
}
