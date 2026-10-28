import {
  ANONYMOUS_ID_KEY,
  browserStorage,
  collectContext,
  detectChannel,
  memoryStorage,
  persistentId,
  type StorageLike,
  USER_ID_KEY,
} from './context.js';
import { DEFAULT_INGEST_ENDPOINT } from './endpoints.js';
import { identifyProblem, isNonEmptyString } from './identify.js';
import { MAX_CALL_BYTES, withinUserIdLength } from './limits.js';
import { onNavigate } from './navigation.js';
import { pageContext } from './page.js';
import { EventQueue, type QueuedCall, type SendResult } from './queue.js';
import { type FetchLike, g, utf8Length, uuid, withTimeout } from './runtime.js';
import { trackProblem } from './track.js';
import type { Channel, EventContext, MaqetinError, QueueItem } from './types.js';

const KEEPALIVE_MAX_BYTES = 60_000;

/** The user a stored id names, if it is one the gateway accepts; otherwise nobody (the visitor is anonymous). */
function storedUserId(storage: StorageLike): string | undefined {
  try {
    const stored = storage.getItem(USER_ID_KEY);
    return isNonEmptyString(stored) && withinUserIdLength(stored) ? stored : undefined;
  } catch {
    return undefined;
  }
}

/** A `timestamp` option must be a valid Date: anything else would throw out of the call. */
function timestampProblem(at: unknown): string | undefined {
  if (at === undefined) return undefined;
  return at instanceof Date && !Number.isNaN(at.getTime())
    ? undefined
    : 'timestamp must be a valid Date';
}

/** A finite integer option, at least `min` (a NaN `maxRetries` would retry forever, F9). */
function count(name: string, value: number | undefined, fallback: number, min: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`maqetin-js: ${name} must be an integer >= ${min}`);
  }
  return value;
}

/**
 * Where the batches go: an http(s) address, or, on a web page, a path on the page's own origin (a first-party proxy,
 * see the README). A path is resolved here, once, against the page: Node's `fetch` cannot resolve one, so outside a
 * page it would fail inside every send and be retried. A path that a browser reads as another host (`//host`, a
 * backslash or a tab after the first slash) resolves to that host and is refused.
 */
function resolveEndpoint(endpoint: unknown): string {
  if (typeof endpoint !== 'string') throw new Error('maqetin-js needs an http(s) endpoint');
  if (/^https?:\/\//.test(endpoint)) return endpoint;
  if (!endpoint.startsWith('/')) throw new Error('maqetin-js needs an http(s) endpoint');
  const page = detectChannel() === 'web' ? g.location?.href : undefined;
  if (page === undefined)
    throw new Error(
      'maqetin-js: an endpoint that is a path works on a web page only; give the full https:// address',
    );
  try {
    const Url = g.URL;
    const home = Url && new Url(page);
    const resolved = Url && home && new Url(endpoint, home.href);
    if (home && resolved && /^https?:$/.test(resolved.protocol) && resolved.origin === home.origin)
      return resolved.href;
  } catch {
    // an address the platform cannot parse is refused below
  }
  throw new Error('maqetin-js needs an http(s) endpoint');
}

export interface ClientOptions {
  /**
   * The public key, `mq_live_...` (the publishable kind). Sent only as the `Authorization: Bearer` header; never logged or
   * reported. A secret key is refused: it belongs on a server, never in a client.
   */
  publicKey: string;
  /**
   * The ingestion gateway. Default `https://in.maqetin.com`. On a web page it may also be a path on your own site
   * (`/relay`) that your server forwards to the gateway, so the page sends to its own domain.
   */
  endpoint?: string;
  /** Send when this many calls are queued (at most 100, the gateway's batch limit). Default 20. */
  flushAt?: number;
  /** Send whatever is queued this long after the first call. Default 100 ms: events reach the profile and the event store in near real time. */
  flushIntervalMs?: number;
  /** Calls queued at most; a call beyond it is refused and reported. Default 1000. */
  maxQueueSize?: number;
  /** Retries of one batch on 5xx/429/network errors before it is dropped and reported. Default 10. */
  maxRetries?: number;
  /** Backoff: attempt n waits a random time up to min(retryMaxMs, retryBaseMs * 2^n). Defaults 500 ms and 30 s. */
  retryBaseMs?: number;
  retryMaxMs?: number;
  /** Gives up on a request after this long and retries it (same messageIds). Default 10 000 ms. */
  requestTimeoutMs?: number;
  /**
   * Records a page view (`page.viewed`) when the client starts and whenever a single-page app moves to a new path
   * (`pushState`, `replaceState`, back and forward). Web only. Default true.
   */
  autoPageViews?: boolean;
  /** Turns the auto-collected `context` off. */
  disableAutoCollection?: boolean;
  /** Every dropped call is reported here (never silent). Default: none. */
  onError?: (err: MaqetinError) => void;
  /** Where `deviceId` and `anonymousId` live. Default: `localStorage` in a browser, memory in Node. */
  storage?: StorageLike;
  fetch?: FetchLike;
  random?: () => number;
}

/**
 * Maqetin JS SDK (web and Node), Scope §4.2: `identify` and `track`, batched to `POST /v1/batch`, retried with
 * capped backoff and jitter, `messageId` on every call (the gateway's `eventId`, kept across retries) and `sentAt`
 * on every batch (clock-skew correction).
 */
export class MaqetinClient {
  readonly #publicKey: string;
  readonly #endpoint: string;
  readonly #fetch: FetchLike;
  readonly #queue: EventQueue;
  readonly #storage: StorageLike;
  readonly #channel: Channel;
  readonly #autoCollect: boolean;
  readonly #onError: (err: MaqetinError) => void;
  readonly #timeoutMs: number;
  #userId: string | undefined;
  #lastPath: string | undefined;
  #stopPageViews: () => void = () => undefined;
  #anonymousId: string;

  constructor(options: ClientOptions) {
    if (typeof options.publicKey !== 'string' || options.publicKey.length === 0)
      throw new Error('maqetin-js needs a publicKey');
    // A secret key reads every contact of the workspace and stays on a server. A page that held one would hand it to
    // anyone who opens the page source, so the SDK never accepts it, in any case, with a space or a scheme in front.
    // The message names no part of the key.
    if (/mq_sec_/i.test(options.publicKey))
      throw new Error(
        'maqetin-js: this is a secret key. A web page or an app holds a public key only; keep secret keys on your server',
      );
    const endpoint = resolveEndpoint(options.endpoint ?? DEFAULT_INGEST_ENDPOINT);
    const fetchImpl = options.fetch ?? g.fetch?.bind(globalThis);
    if (!fetchImpl) throw new Error('maqetin-js needs fetch (pass options.fetch)');
    this.#publicKey = options.publicKey;
    this.#endpoint = endpoint.replace(/\/+$/, '');
    this.#fetch = fetchImpl;
    this.#storage = options.storage ?? browserStorage() ?? memoryStorage();
    this.#channel = detectChannel();
    this.#autoCollect = options.disableAutoCollection !== true;
    this.#onError = options.onError ?? (() => undefined);
    this.#anonymousId = persistentId(this.#storage, ANONYMOUS_ID_KEY);
    this.#userId = storedUserId(this.#storage);
    this.#timeoutMs = count('requestTimeoutMs', options.requestTimeoutMs, 10_000, 1);
    this.#queue = new EventQueue({
      send: (items) => this.#send(items),
      flushAt: count('flushAt', options.flushAt, 20, 1),
      flushIntervalMs: count('flushIntervalMs', options.flushIntervalMs, 100, 0),
      maxQueueSize: count('maxQueueSize', options.maxQueueSize, 1_000, 1),
      maxRetries: count('maxRetries', options.maxRetries, 10, 0),
      retryBaseMs: count('retryBaseMs', options.retryBaseMs, 500, 0),
      retryMaxMs: count('retryMaxMs', options.retryMaxMs, 30_000, 0),
      random: options.random ?? Math.random,
      onError: (err) => this.#report(err),
    });
    // A closing tab would lose what is queued in memory: send it while the page is still there (F9).
    if (this.#channel === 'web' && typeof g.addEventListener === 'function') {
      g.addEventListener('pagehide', () => void this.flush());
    }
    if (this.#channel === 'web' && options.autoPageViews !== false) this.#startPageViews();
    // Mobile Safari often never fires pagehide: a page that goes to the background is the last sure moment to send.
    const doc = g.document;
    if (this.#channel === 'web' && typeof doc?.addEventListener === 'function') {
      doc.addEventListener('visibilitychange', () => {
        if (doc.visibilityState === 'hidden') void this.flush();
      });
    }
  }

  /** Identifies the user (and remembers them for `track`). Returns false if the call was refused (reported). */
  identify(
    userId: string,
    traits: Record<string, unknown> = {},
    options: { timestamp?: Date } = {},
  ): boolean {
    const problem = identifyProblem(userId, traits) ?? timestampProblem(options.timestamp);
    if (problem) return this.#invalid(problem);
    const call = this.#serialize({
      type: 'identify',
      userId,
      ...this.#base(options.timestamp),
      traits,
    });
    if (typeof call === 'string') return this.#invalid(call);
    this.#userId = userId;
    try {
      this.#storage.setItem(USER_ID_KEY, userId);
    } catch {
      // unwritable storage: the user stays identified for this page only
    }
    return this.#queue.push(call);
  }

  /**
   * Records an event for the identified user, or `options.userId`. Before any identify (and after `reset()`) the
   * event is about the anonymous visitor and carries only the `anonymousId`; a later identify of that visitor
   * links it to the user. Returns false if refused (reported).
   */
  track(
    event: string,
    properties: Record<string, unknown> = {},
    options: { userId?: string; timestamp?: Date } = {},
  ): boolean {
    // Only an absent userId falls back to the identified user: a null or empty one is a mistake to report.
    const userId = options.userId === undefined ? this.#userId : options.userId;
    const problem = trackProblem(event, properties, userId) ?? timestampProblem(options.timestamp);
    if (problem) return this.#invalid(problem);
    const call = this.#serialize({
      type: 'track',
      ...(userId === undefined ? {} : { userId }),
      ...this.#base(options.timestamp),
      event,
      properties,
    });
    if (typeof call === 'string') return this.#invalid(call);
    return this.#queue.push(call);
  }

  /**
   * Records a page view: `page.viewed`, with the page (`path`, `url`, `title`, `referrer`) as properties so a journey
   * can filter on it. The caller's properties are kept beside them and never replace them. In Node there is no page:
   * only the caller's properties are sent.
   */
  page(properties: Record<string, unknown> = {}, options: { timestamp?: Date } = {}): boolean {
    return this.track('page.viewed', { ...properties, ...pageContext() }, options);
  }

  /** The automatic page views: the first page now, then each new path (a change of query or fragment is not one). */
  #startPageViews(): void {
    this.#lastPath = pageContext()?.path;
    this.page();
    this.#stopPageViews = onNavigate(() => {
      const path = pageContext()?.path;
      if (path === undefined || path === this.#lastPath) return;
      this.#lastPath = path;
      this.page();
    });
  }

  /** Forgets the user (logout): later tracks are anonymous until a new identify; a new anonymous id starts. */
  reset(): void {
    this.#userId = undefined;
    // A new id in memory whatever the storage does: a storage that cannot forget the old id must not give it back.
    this.#anonymousId = uuid();
    try {
      this.#storage.removeItem(USER_ID_KEY);
      this.#storage.setItem(ANONYMOUS_ID_KEY, this.#anonymousId);
    } catch {
      // unwritable storage: the new id lasts this session
    }
  }

  /** Sends everything queued now. */
  flush(): Promise<void> {
    return this.#queue.flush();
  }

  /** Flushes and stops: later calls are refused. Call before a Node process exits. */
  close(): Promise<void> {
    this.#stopPageViews();
    return this.#queue.close();
  }

  #base(at?: Date) {
    const context: EventContext | undefined = this.#autoCollect
      ? collectContext(this.#storage)
      : undefined;
    return {
      messageId: uuid(),
      anonymousId: this.#anonymousId,
      timestamp: (at ?? new Date()).toISOString(),
      channel: this.#channel,
      ...(context ? { context } : {}),
    };
  }

  /**
   * The call as JSON, once, with its size: a value JSON cannot hold (a cycle, a BigInt) or a call over MAX_CALL_BYTES is
   * a reason to refuse this call alone, so it never makes the batch it would join fail.
   */
  #serialize(item: QueueItem): QueuedCall | string {
    let json: string;
    try {
      json = JSON.stringify(item);
    } catch {
      return `${item.type} has a value JSON cannot hold (a cycle or a BigInt)`;
    }
    const bytes = utf8Length(json);
    if (bytes > MAX_CALL_BYTES)
      return `${item.type} is ${bytes} bytes as JSON, over ${MAX_CALL_BYTES}`;
    return { json, bytes };
  }

  async #send(calls: readonly QueuedCall[]): Promise<SendResult> {
    const body = `{"batch":[${calls.map((c) => c.json).join(',')}],"sentAt":${JSON.stringify(new Date().toISOString())}}`;
    const size = calls.reduce((n, c) => n + c.bytes, 0);
    const res = await withTimeout(this.#timeoutMs, (signal) =>
      this.#fetch(`${this.#endpoint}/v1/batch`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.#publicKey}`, 'Content-Type': 'application/json' },
        body,
        // Browsers refuse keepalive bodies above 64 KiB (it would fail on every retry): only below 60 KB (F8).
        keepalive: this.#channel === 'web' && size < KEEPALIVE_MAX_BYTES,
        ...(signal === undefined ? {} : { signal }),
      }),
    );
    if (res.status >= 200 && res.status < 300) return { kind: 'ok' };
    if (res.status === 429 || res.status >= 500) {
      const retryAfter = Number(res.headers.get('retry-after'));
      return {
        kind: 'retry',
        status: res.status,
        ...(Number.isFinite(retryAfter) && retryAfter > 0
          ? { retryAfterMs: retryAfter * 1_000 }
          : {}),
      };
    }
    return { kind: 'reject', status: res.status };
  }

  #invalid(message: string): false {
    this.#report({ kind: 'invalid_call', message, dropped: 1 });
    return false;
  }

  #report(err: MaqetinError): void {
    try {
      this.#onError(err);
    } catch {
      // a throwing error handler must not break the queue
    }
  }
}
