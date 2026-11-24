import { SoroWillError } from './errors';
import type { WillEvent } from './events';
import { computeBackoffDelay } from './requestQueue';

/** Default number of delivery attempts (initial attempt + retries). */
export const DEFAULT_WEBHOOK_MAX_ATTEMPTS = 5;
/** Default base delay for exponential retry backoff (250 ms). */
export const DEFAULT_WEBHOOK_RETRY_BASE_DELAY_MS = 250;
/** Default cap applied to a single retry delay (30 seconds). */
export const DEFAULT_WEBHOOK_MAX_RETRY_DELAY_MS = 30_000;
/** Default per-delivery HTTP timeout (10 seconds). */
export const DEFAULT_WEBHOOK_TIMEOUT_MS = 10_000;
/** Header carrying the hex HMAC-SHA256 signature of the raw request body. */
export const WEBHOOK_SIGNATURE_HEADER = 'x-sorowill-signature';
/** Header carrying the delivery attempt number (1-based). */
export const WEBHOOK_ATTEMPT_HEADER = 'x-sorowill-attempt';
/** Header carrying the delivery ID, stable across retries of the same event. */
export const WEBHOOK_DELIVERY_ID_HEADER = 'x-sorowill-delivery-id';

/** Raised when a webhook URL is not a valid absolute http(s) URL. */
export class InvalidWebhookUrlError extends SoroWillError {
  /** The rejected URL. */
  readonly url: string;

  constructor(url: string, options?: ErrorOptions) {
    super(
      'Invalid webhook URL: must be an absolute http(s) URL.',
      options,
    );
    this.url = url;
  }
}

/** Raised when a webhook delivery fails after all retry attempts. */
export class WebhookDeliveryError extends SoroWillError {
  /** The webhook URL that could not be reached. */
  readonly url: string;
  /** Number of attempts made. */
  readonly attempts: number;
  /** HTTP status of the last attempt, when a response was received. */
  readonly status: number | undefined;

  constructor(url: string, attempts: number, status?: number, options?: ErrorOptions) {
    super(
      `Webhook delivery failed after ${attempts} attempt(s)` +
        (status !== undefined ? ` (last status ${status}).` : '.'),
      options,
    );
    this.url = url;
    this.attempts = attempts;
    this.status = status;
  }
}

/** A registered webhook endpoint. */
export interface WebhookRegistration {
  /** Absolute http(s) URL that receives POSTed event payloads. */
  url: string;
  /** Optional shared secret used to sign deliveries (HMAC-SHA256). */
  secret?: string;
  /** Optional event-type allowlist; when omitted every event is delivered. */
  eventTypes?: readonly string[];
  /** Optional willId allowlist; when omitted every will is delivered. */
  willIds?: readonly string[];
}

/** Result of a single delivery attempt. */
export interface WebhookDeliveryResult {
  url: string;
  deliveryId: string;
  attempts: number;
  ok: boolean;
  status?: number;
  error?: unknown;
}

/** Options for {@link WebhookManager}. */
export interface WebhookManagerOptions {
  /** Maximum delivery attempts per event. Defaults to 5. */
  maxAttempts?: number;
  /** Base delay for exponential retry backoff. Defaults to 250 ms. */
  retryBaseDelayMs?: number;
  /** Cap applied to a single retry delay. Defaults to 30 s. */
  maxRetryDelayMs?: number;
  /** Per-delivery HTTP timeout. Defaults to 10 s. */
  timeoutMs?: number;
  /** Injectable fetch implementation (defaults to `globalThis.fetch`). */
  fetch?: typeof fetch;
  /** Injectable sleep implementation (defaults to `setTimeout`). */
  sleep?: (ms: number) => Promise<void>;
}

/** Envelope POSTed to webhook endpoints. */
export interface WebhookPayload {
  deliveryId: string;
  attempt: number;
  sentAt: string;
  event: WillEvent;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex: string): Uint8Array | undefined {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) return undefined;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function getSubtle(): SubtleCrypto {
  const subtle = (globalThis as { crypto?: Crypto }).crypto?.subtle;
  if (!subtle) {
    throw new SoroWillError(
      'Webhook signature verification requires the Web Crypto API (crypto.subtle).',
    );
  }
  return subtle;
}

/**
 * Computes the hex HMAC-SHA256 signature of `body` using `secret`. This is the
 * value sent in the {@link WEBHOOK_SIGNATURE_HEADER} header.
 */
export async function computeWebhookSignature(secret: string, body: string): Promise<string> {
  const subtle = getSubtle();
  const encoder = new TextEncoder();
  const key = await subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await subtle.sign('HMAC', key, encoder.encode(body));
  return toHex(new Uint8Array(signature));
}

/**
 * Verifies a webhook signature in constant time. Returns `false` for malformed
 * signatures instead of throwing.
 */
export async function verifyWebhookSignature(
  secret: string,
  body: string,
  signature: string,
): Promise<boolean> {
  const provided = fromHex(signature.trim());
  if (!provided) return false;
  const expected = fromHex(await computeWebhookSignature(secret, body));
  if (!expected || expected.length !== provided.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) {
    diff |= expected[i]! ^ provided[i]!;
  }
  return diff === 0;
}

function assertValidUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new InvalidWebhookUrlError(url);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new InvalidWebhookUrlError(url);
  }
}

function matchesRegistration(registration: WebhookRegistration, event: WillEvent): boolean {
  if (registration.eventTypes && !registration.eventTypes.includes(event.type)) return false;
  if (registration.willIds && !registration.willIds.includes(event.willId)) return false;
  return true;
}

/**
 * Registers webhook endpoints and delivers will events to them (#779).
 *
 * Deliveries are POSTed as JSON, signed with HMAC-SHA256 when a secret is
 * configured, and retried with exponential backoff on network errors and
 * non-2xx responses.
 *
 * @example
 * ```ts
 * const webhooks = new WebhookManager();
 * webhooks.register({ url: 'https://example.com/hooks/wills', secret: 'whsec_...' });
 * await webhooks.deliver({ type: 'willCreated', willId: '42' });
 * ```
 */
export class WebhookManager {
  private readonly registrations = new Map<string, WebhookRegistration>();
  private readonly maxAttempts: number;
  private readonly retryBaseDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: WebhookManagerOptions = {}) {
    this.maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? DEFAULT_WEBHOOK_MAX_ATTEMPTS));
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? DEFAULT_WEBHOOK_RETRY_BASE_DELAY_MS;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? DEFAULT_WEBHOOK_MAX_RETRY_DELAY_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_WEBHOOK_TIMEOUT_MS;
    this.fetchImpl = options.fetch;
    this.sleep =
      options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  /** Registers (or replaces) a webhook endpoint. Returns the registration. */
  register(registration: WebhookRegistration): WebhookRegistration {
    assertValidUrl(registration.url);
    const stored: WebhookRegistration = { ...registration };
    this.registrations.set(registration.url, stored);
    return stored;
  }

  /** Removes a webhook endpoint. Returns true when it was registered. */
  unregister(url: string): boolean {
    return this.registrations.delete(url);
  }

  /** Lists the currently registered endpoints. */
  list(): WebhookRegistration[] {
    return Array.from(this.registrations.values(), (r) => ({ ...r }));
  }

  /** Removes all registered endpoints. */
  clear(): void {
    this.registrations.clear();
  }

  /**
   * Delivers `event` to every matching endpoint. Never rejects: failures are
   * reported per endpoint in the returned results.
   */
  async deliver(event: WillEvent): Promise<WebhookDeliveryResult[]> {
    const targets = Array.from(this.registrations.values()).filter((r) =>
      matchesRegistration(r, event),
    );
    return Promise.all(targets.map((registration) => this.deliverTo(registration, event)));
  }

  /** Delivers `event` to a single endpoint, retrying failed attempts. */
  async deliverTo(
    registration: WebhookRegistration,
    event: WillEvent,
  ): Promise<WebhookDeliveryResult> {
    const deliveryId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    let lastStatus: number | undefined;
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const payload: WebhookPayload = {
        deliveryId,
        attempt,
        sentAt: new Date().toISOString(),
        event,
      };
      const body = JSON.stringify(payload);
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        [WEBHOOK_ATTEMPT_HEADER]: String(attempt),
        [WEBHOOK_DELIVERY_ID_HEADER]: deliveryId,
      };
      if (registration.secret) {
        headers[WEBHOOK_SIGNATURE_HEADER] = await computeWebhookSignature(registration.secret, body);
      }

      try {
        const response = await this.post(registration.url, body, headers);
        lastStatus = response.status;
        if (response.ok) {
          return { url: registration.url, deliveryId, attempts: attempt, ok: true, status: response.status };
        }
        lastError = new WebhookDeliveryError(registration.url, attempt, response.status);
      } catch (error) {
        lastError = error;
      }

      if (attempt < this.maxAttempts) {
        await this.sleep(
          computeBackoffDelay(attempt - 1, this.retryBaseDelayMs, this.maxRetryDelayMs, true),
        );
      }
    }

    return {
      url: registration.url,
      deliveryId,
      attempts: this.maxAttempts,
      ok: false,
      ...(lastStatus !== undefined ? { status: lastStatus } : {}),
      error: lastError,
    };
  }

  private async post(
    url: string,
    body: string,
    headers: Record<string, string>,
  ): Promise<Response> {
    const fetchFn = this.fetchImpl ?? (globalThis as { fetch?: typeof fetch }).fetch;
    if (!fetchFn) {
      throw new SoroWillError('Webhook delivery requires a fetch implementation.');
    }
    const controller = typeof AbortController === 'function' ? new AbortController() : undefined;
    const timer = controller
      ? setTimeout(() => controller.abort(), this.timeoutMs)
      : undefined;
    try {
      return await fetchFn(url, {
        method: 'POST',
        headers,
        body,
        ...(controller ? { signal: controller.signal } : {}),
      });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
