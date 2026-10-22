import { InvalidEventTypeFilterError } from './errors';
import { SOROBAN_EVENT_TYPES, type SorobanEventType } from './types';

export interface WillEvent {
  type: string;
  willId: string;
  payload?: unknown;
}

export type WillEventListener = (event: WillEvent) => void;
export type WillEventSubscription = (() => void) | { unsubscribe(): void };

export interface WillEventSource {
  subscribe(listener: WillEventListener): WillEventSubscription;
}

/**
 * Compound event filter supporting AND/OR logical operators (#627).
 *
 * Allows combining multiple conditions with AND (all must match) or OR (any can match).
 * Filters can be nested for complex logic.
 *
 * @example
 * ```ts
 * // Match either willCreated OR willUpdated events
 * const filter: EventFilter = {
 *   OR: [
 *     { eventType: 'willCreated' },
 *     { eventType: 'willUpdated' },
 *   ],
 * };
 *
 * // Match willCreated events WITH willId = '123' (AND logic)
 * const filter: EventFilter = {
 *   AND: [
 *     { eventType: 'willCreated' },
 *     { willId: '123' },
 *   ],
 * };
 *
 * // Complex: (willCreated OR willUpdated) AND hasPayload
 * const filter: EventFilter = {
 *   AND: [
 *     {
 *       OR: [
 *         { eventType: 'willCreated' },
 *         { eventType: 'willUpdated' },
 *       ],
 *     },
 *     { hasPayload: true },
 *   ],
 * };
 * ```
 */
export interface EventFilter {
  /** All conditions must match (logical AND). */
  AND?: EventFilter[];
  /** Any condition can match (logical OR). */
  OR?: EventFilter[];
  /** Match events of this type. */
  eventType?: SorobanEventType;
  /** Match events with this willId. */
  willId?: string;
  /** Match events with/without a payload. */
  hasPayload?: boolean;
}

/**
 * Evaluates an event against a compound filter (AND/OR logic).
 *
 * @param event - The event to test.
 * @param filter - The filter to apply.
 * @returns true when the event matches the filter.
 *
 * @internal Used by event subscription handlers to apply compound filters.
 */
export function matchesEventFilter(event: WillEvent, filter: EventFilter): boolean {
  // AND: all sub-filters must match
  if (filter.AND) {
    return filter.AND.every((subFilter) => matchesEventFilter(event, subFilter));
  }

  // OR: any sub-filter can match
  if (filter.OR) {
    return filter.OR.some((subFilter) => matchesEventFilter(event, subFilter));
  }

  // Atomic conditions
  if (filter.eventType !== undefined && event.type !== filter.eventType) {
    return false;
  }

  if (filter.willId !== undefined && event.willId !== filter.willId) {
    return false;
  }

  if (filter.hasPayload !== undefined) {
    const hasPayload = event.payload !== undefined && event.payload !== null;
    if (hasPayload !== filter.hasPayload) {
      return false;
    }
  }

  return true;
}

/**
 * Known SoroWill event types that can be subscribed to.
 */
export const SORO_WILL_EVENT_TYPES = [
  'willCreated',
  'willUpdated',
  'willClaimed',
  'willCancelled',
  'willExecuted',
] as const;

export type SoroWillEventType = (typeof SORO_WILL_EVENT_TYPES)[number];

/**
 * Error thrown when an unknown event type is passed to addEventListener.
 */
export class EventTypeError extends Error {
  readonly eventType: string;

  constructor(eventType: string) {
    super(
      `Unknown event type: "${eventType}". Supported event types are: ${SORO_WILL_EVENT_TYPES.join(
        ', ',
      )}.`,
    );
    this.name = 'EventTypeError';
    this.eventType = eventType;
  }
}

function isKnownEventType(eventType: string): eventType is SoroWillEventType {
  return (SORO_WILL_EVENT_TYPES as readonly string[]).includes(eventType);
}

/**
 * Validates that the provided event type is a recognized SoroWillEvent type.
 * Throws an EventTypeError for unknown event types.
 */
export function validateEventType(eventType: string): SoroWillEventType {
  if (!isKnownEventType(eventType)) {
    throw new EventTypeError(eventType);
  }

  return eventType;
}

/**
 * Subscribes a listener to a known SoroWill event type.
 * Rejects unknown event types with an EventTypeError instead of silently
 * subscribing to an event that will never fire.
 */
export function addEventListener(
  eventType: string,
  listener: WillEventListener,
  source: WillEventSource,
): WillEventSubscription {
  validateEventType(eventType);

  return source.subscribe((event) => {
    if (event.type === eventType) {
      listener(event);
    }
  });
}

/**
 * Validates an `eventTypes` subscription filter against
 * {@link SOROBAN_EVENT_TYPES}, returning the de-duplicated list of types, or
 * `undefined` when no filter was given (match every type).
 *
 * @throws {InvalidEventTypeFilterError} if the filter is not an array, is
 *   empty, or contains any value that is not a supported event type.
 */
export function validateEventTypeFilter(eventTypes: unknown): SorobanEventType[] | undefined {
  if (eventTypes === undefined) {
    return undefined;
  }
  if (!Array.isArray(eventTypes)) {
    throw new InvalidEventTypeFilterError([eventTypes], SOROBAN_EVENT_TYPES);
  }
  if (eventTypes.length === 0) {
    throw new InvalidEventTypeFilterError([], SOROBAN_EVENT_TYPES, {
      cause: new Error('eventTypes must contain at least one event type; omit it to match every type.'),
    });
  }

  const invalid = eventTypes.filter(
    (t) => typeof t !== 'string' || !(SOROBAN_EVENT_TYPES as readonly string[]).includes(t),
  );
  if (invalid.length > 0) {
    throw new InvalidEventTypeFilterError(invalid, SOROBAN_EVENT_TYPES);
  }

  return [...new Set(eventTypes as SorobanEventType[])];
}

export function unsubscribeFromWillEvents(subscription: WillEventSubscription): void {
  if (typeof subscription === 'function') {
    subscription();
    return;
  }

  subscription.unsubscribe();
}

/**
 * Tracks event subscriptions for a single client so they can all be released
 * when the client is destroyed. Subscriptions are stored in a WeakMap keyed by
 * the owning client, so if a client is garbage collected without calling
 * destroy(), its subscription set is collected with it instead of leaking.
 */
const clientSubscriptions = new WeakMap<object, Set<WillEventSubscription>>();

function getSubscriptionSet(owner: object): Set<WillEventSubscription> {
  let subscriptions = clientSubscriptions.get(owner);
  if (!subscriptions) {
    subscriptions = new Set<WillEventSubscription>();
    clientSubscriptions.set(owner, subscriptions);
  }
  return subscriptions;
}

/**
 * Registers a subscription against an owning client so it can be cleaned up
 * later via {@link cleanupWillEventSubscriptions}.
 */
export function trackWillEventSubscription(
  owner: object,
  subscription: WillEventSubscription,
): WillEventSubscription {
  getSubscriptionSet(owner).add(subscription);
  return subscription;
}

/**
 * Removes a previously tracked subscription from an owning client.
 */
export function untrackWillEventSubscription(
  owner: object,
  subscription: WillEventSubscription,
): void {
  clientSubscriptions.get(owner)?.delete(subscription);
}

/**
 * Unsubscribes every subscription tracked for the given owner and clears the
 * tracking set. Safe to call multiple times.
 */
export function cleanupWillEventSubscriptions(owner: object): void {
  const subscriptions = clientSubscriptions.get(owner);
  if (!subscriptions) {
    return;
  }

  for (const subscription of subscriptions) {
    unsubscribeFromWillEvents(subscription);
  }

  subscriptions.clear();
  clientSubscriptions.delete(owner);
}
