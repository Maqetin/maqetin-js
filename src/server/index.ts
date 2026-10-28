// The server half of the SDK: messages a backend sends with a secret key. A separate entry (`@maqetin/sdk-js/server`), so
// a web bundle that imports the SDK never holds this code, and a page can never be handed a secret key by it.
import { detectChannel } from '../context.js';
import { DEFAULT_API_ENDPOINT } from '../endpoints.js';
import { g, type SignalLike, sleep, uuid, withTimeout } from '../runtime.js';
import { SDK_NAME, SDK_VERSION } from '../version.js';

export { SDK_VERSION };

export interface ServerFetchResponseLike {
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}

export type ServerFetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: SignalLike },
) => Promise<ServerFetchResponseLike>;

export interface ServerOptions {
  /** A secret key (`mq_sec_…`). It stays on your server. */
  secretKey: string;
  /** The API gateway. Default `https://api.maqetin.com`. */
  endpoint?: string;
  fetch?: ServerFetchLike;
  /** Retries after the first try, on 5xx, 429 and network errors. Default 3. */
  maxRetries?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  /** Gives up on a request after this long and retries it under the same idempotency key. Default 15 000 ms. */
  requestTimeoutMs?: number;
}

/** One email. `to` is a contact by your own user id, or an address with no contact. */
export interface EmailMessage {
  channel: 'email';
  templateId: string;
  to: { userId: string } | { email: string };
  /** `Name <local@domain>` or `local@domain`, on a verified sending domain of the workspace. */
  from: string;
  subject?: string;
  /** Merge data for the template, at most 16 KB as JSON. */
  data?: Record<string, unknown>;
}

/** A message by its channel. Email is the only channel today. */
export type OutboundMessage = EmailMessage;

export interface SendOptions {
  /** The same key on a retry is the same message, sent once. Made for you when absent, and kept across the SDK's own retries. */
  idempotencyKey?: string;
}

export interface SendResult {
  messageId: string;
  status: 'queued';
}

/** The API refused the message, or did not answer after the retries. `code` and `message` are the API's. */
export class MaqetinRequestError extends Error {
  override readonly name = 'MaqetinRequestError';
  constructor(
    readonly status: number | undefined,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_.:-]{1,100}$/;

/**
 * Sends transactional messages from your server: `new MaqetinServer({ secretKey, endpoint }).messages.send(message)`. A
 * retry (5xx, 429, a network error) carries the same `Idempotency-Key`, so it is never a second mail; a 4xx is thrown at once.
 */
export class MaqetinServer {
  readonly messages: { send(message: OutboundMessage & SendOptions): Promise<SendResult> };
  readonly #key: string;
  readonly #endpoint: string;
  readonly #fetch: ServerFetchLike;
  readonly #maxRetries: number;
  readonly #baseMs: number;
  readonly #maxMs: number;
  readonly #timeoutMs: number;

  constructor(options: ServerOptions) {
    if (typeof options.secretKey !== 'string' || !/^mq_sec_/.test(options.secretKey))
      throw new Error('maqetin-js/server needs a secret key (mq_sec_…)');
    // a secret key in a web page is a key anyone can read: this half of the SDK runs on a server only
    if (detectChannel() === 'web')
      throw new Error(
        'maqetin-js/server runs on a server only; a web page uses the publishable SDK',
      );
    const endpoint = options.endpoint ?? DEFAULT_API_ENDPOINT;
    if (typeof endpoint !== 'string' || !/^https?:\/\//.test(endpoint))
      throw new Error('maqetin-js/server needs an http(s) endpoint');
    const fetchImpl =
      options.fetch ?? (g.fetch?.bind(globalThis) as unknown as ServerFetchLike | undefined);
    if (!fetchImpl) throw new Error('maqetin-js/server needs fetch (pass options.fetch)');
    this.#key = options.secretKey;
    this.#endpoint = endpoint.replace(/\/+$/, '');
    this.#fetch = fetchImpl;
    this.#maxRetries = Math.max(0, options.maxRetries ?? 3);
    this.#baseMs = Math.max(0, options.retryBaseMs ?? 500);
    this.#maxMs = Math.max(0, options.retryMaxMs ?? 10_000);
    this.#timeoutMs = options.requestTimeoutMs ?? 15_000;
    if (!Number.isInteger(this.#timeoutMs) || this.#timeoutMs < 1)
      throw new Error('maqetin-js/server: requestTimeoutMs must be an integer >= 1');
    this.messages = { send: (message) => this.#send(message) };
  }

  async #send({ idempotencyKey, ...message }: OutboundMessage & SendOptions): Promise<SendResult> {
    const key = idempotencyKey ?? uuid();
    if (!IDEMPOTENCY_KEY.test(key))
      throw new MaqetinRequestError(
        undefined,
        'VALIDATION_FAILED',
        'idempotencyKey: letters, digits, _ . : -, at most 100',
      );
    const body = JSON.stringify(message);
    let last: MaqetinRequestError | undefined;
    for (let attempt = 0; attempt <= this.#maxRetries; attempt++) {
      if (attempt > 0) await sleep(this.#delay(attempt - 1, last));
      let res: ServerFetchResponseLike;
      try {
        res = await withTimeout(this.#timeoutMs, (signal) =>
          this.#fetch(`${this.#endpoint}/v1/public/messages`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${this.#key}`,
              'idempotency-key': key,
              'user-agent': `${SDK_NAME}/${SDK_VERSION}`,
            },
            body,
            ...(signal === undefined ? {} : { signal }),
          }),
        );
      } catch {
        // a network error or a timeout: the request may have arrived, so the retry keeps the same idempotency key and
        // the API sends the message once; never mint a new key here
        last = new MaqetinRequestError(
          undefined,
          'NETWORK_ERROR',
          'the API could not be reached in time',
        );
        continue;
      }
      const answer = (await res.json().catch(() => undefined)) as Envelope | undefined;
      if (res.status === 202 && answer?.data !== undefined) return answer.data;
      const error = new MaqetinRequestError(
        res.status,
        answer?.error?.code ?? 'UNEXPECTED_RESPONSE',
        answer?.error?.message ?? `the API answered ${res.status}`,
      );
      if (res.status !== 429 && res.status < 500) throw error;
      last = Object.assign(error, { retryAfterMs: retryAfterMs(res.headers.get('retry-after')) });
    }
    throw (
      last ?? new MaqetinRequestError(undefined, 'NETWORK_ERROR', 'the API could not be reached')
    );
  }

  /** Capped exponential backoff with full jitter, and never sooner than the API's `Retry-After`. */
  #delay(
    retry: number,
    last: (MaqetinRequestError & { retryAfterMs?: number }) | undefined,
  ): number {
    const cap = Math.min(this.#maxMs, this.#baseMs * 2 ** retry);
    return Math.max(
      Math.floor(Math.random() * cap),
      Math.min(last?.retryAfterMs ?? 0, this.#maxMs),
    );
  }
}

interface Envelope {
  data?: SendResult;
  error?: { code?: string; message?: string };
}

function retryAfterMs(value: string | null): number {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
}
