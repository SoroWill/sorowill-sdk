/**
 * Client-side will state machine (#805).
 *
 * Defines the lifecycle states a will can be in and the transitions the
 * SoroWill contract permits between them, so callers can validate an intended
 * operation locally before submitting a transaction.
 *
 * @example
 * ```ts
 * import { assertValidWillTransition, canTransitionWill } from '@sorowill/sdk';
 *
 * if (!canTransitionWill(will.status, WillStatus.Released)) {
 *   // surface a friendly message instead of a failed transaction
 * }
 * assertValidWillTransition(will.status, WillStatus.Released);
 * ```
 */

import { InvalidWillStateTransitionError } from './errors';
import { WillStatus } from './types';

/** All valid will lifecycle states. */
export const WILL_STATES: readonly WillStatus[] = Object.freeze([
  WillStatus.PendingConfirmation,
  WillStatus.Active,
  WillStatus.Triggered,
  WillStatus.Released,
  WillStatus.Cancelled,
  WillStatus.Settled,
]);

/**
 * The transition table: for each state, the set of states it may move to.
 * Terminal states (`Released`, `Cancelled`, `Settled`) have no outgoing
 * transitions.
 */
export const WILL_STATE_TRANSITIONS: Readonly<Record<WillStatus, readonly WillStatus[]>> =
  Object.freeze({
    [WillStatus.PendingConfirmation]: Object.freeze([WillStatus.Active, WillStatus.Cancelled]),
    [WillStatus.Active]: Object.freeze([
      WillStatus.Triggered,
      WillStatus.Cancelled,
      WillStatus.Released,
    ]),
    [WillStatus.Triggered]: Object.freeze([
      WillStatus.Active,
      WillStatus.Released,
      WillStatus.Cancelled,
    ]),
    [WillStatus.Released]: Object.freeze([WillStatus.Settled]),
    [WillStatus.Cancelled]: Object.freeze([WillStatus.Settled]),
    [WillStatus.Settled]: Object.freeze([]),
  });

/** Returns `true` when `value` is a known {@link WillStatus}. */
export function isWillState(value: unknown): value is WillStatus {
  return typeof value === 'string' && (WILL_STATES as readonly string[]).includes(value);
}

/** Returns `true` when the will is in a terminal state with no outgoing transitions. */
export function isTerminalWillState(state: WillStatus): boolean {
  return WILL_STATE_TRANSITIONS[state].length === 0;
}

/** Returns the states reachable from `state` in a single transition. */
export function getValidNextStates(state: WillStatus): readonly WillStatus[] {
  return WILL_STATE_TRANSITIONS[state];
}

/**
 * Returns `true` when moving from `from` to `to` is a valid transition.
 * Unknown states are never valid.
 */
export function canTransitionWill(from: WillStatus, to: WillStatus): boolean {
  if (!isWillState(from) || !isWillState(to)) return false;
  return WILL_STATE_TRANSITIONS[from].includes(to);
}

/**
 * Validates a will state transition.
 *
 * @throws {InvalidWillStateTransitionError} when the transition is not allowed.
 */
export function assertValidWillTransition(
  from: WillStatus,
  to: WillStatus,
): asserts from is WillStatus {
  if (!canTransitionWill(from, to)) {
    throw new InvalidWillStateTransitionError(String(from), String(to));
  }
}
