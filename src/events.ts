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
