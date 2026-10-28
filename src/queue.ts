import { MAX_BATCH_BYTES } from './limits.js';
import { clearTimer, setTimer, sleep } from './runtime.js';
import type { MaqetinError } from './types.js';

/**
 * One call as it is sent: serialized once when it is queued, so the size that was checked is the size on the wire and a
 * caller who changes the object afterwards cannot change the event.
 */
export interface QueuedCall {
  json: string;
  bytes: number;
}

/** The gateway's limit per `POST /v1/batch` (G2.1 `BATCH_MAX_ITEMS`). */
export const MAX_BATCH_ITEMS = 100;

export type SendResult =
  | { kind: 'ok' }
  | { kind: 'retry'; status?: number; retryAfterMs?: number }
  | { kind: 'reject'; status: number };

export interface QueueOptions {
  send(calls: readonly QueuedCall[]): Promise<SendResult>;
  flushAt: number;
  flushIntervalMs: number;
  maxQueueSize: number;
  maxRetries: number;
  retryBaseMs: number;
  retryMaxMs: number;
  random(): number;
  onError(err: MaqetinError): void;
}

/**
 * Batches calls (by count or after an interval) and sends one batch at a time, in order. A batch is retried on
 * 5xx, 429 and network errors with capped exponential backoff and full jitter, keeping its items (so their
 * `messageId`s); any other 4xx drops it. Every drop is reported through `onError`, never silent.
 */
export class EventQueue {
  readonly #o: QueueOptions;
  readonly #items: QueuedCall[] = [];
  #inFlight: Promise<void> | undefined;
  #timer: unknown;
  #closed = false;

  constructor(options: QueueOptions) {
    this.#o = { ...options, flushAt: Math.max(1, Math.min(options.flushAt, MAX_BATCH_ITEMS)) };
  }

  get size(): number {
    return this.#items.length;
  }

  push(item: QueuedCall): boolean {
    if (this.#closed) {
      this.#o.onError({ kind: 'closed', message: 'the client is closed', dropped: 1 });
      return false;
    }
    if (this.#items.length >= this.#o.maxQueueSize) {
      this.#o.onError({
        kind: 'queue_full',
        message: `queue full (${this.#o.maxQueueSize} calls)`,
        dropped: 1,
      });
      return false;
    }
    this.#items.push(item);
    if (this.#items.length >= this.#o.flushAt) this.#pump();
    else
      this.#timer ??= setTimer(() => {
        this.#timer = undefined;
        this.#pump();
      }, this.#o.flushIntervalMs);
    return true;
  }

  /** Sends everything queued; resolves when the queue is empty and nothing is in flight. */
  async flush(): Promise<void> {
    while (this.#items.length > 0 || this.#inFlight) {
      if (!this.#inFlight) this.#pump();
      await this.#inFlight;
    }
  }

  /** Flushes, then refuses new calls. */
  async close(): Promise<void> {
    await this.flush();
    this.#closed = true;
    clearTimer(this.#timer);
    this.#timer = undefined;
  }

  #pump(): void {
    if (this.#inFlight || this.#items.length === 0) return;
    clearTimer(this.#timer);
    this.#timer = undefined;
    // at most MAX_BATCH_ITEMS calls and MAX_BATCH_BYTES bytes, and always at least one call
    let take = 0;
    let bytes = 0;
    while (take < this.#items.length && take < MAX_BATCH_ITEMS) {
      const next = (this.#items[take] as QueuedCall).bytes;
      if (take > 0 && bytes + next > MAX_BATCH_BYTES) break;
      bytes += next;
      take += 1;
    }
    const batch = this.#items.splice(0, take);
    this.#inFlight = this.#deliver(batch).finally(() => {
      this.#inFlight = undefined;
      if (this.#items.length >= this.#o.flushAt) this.#pump();
      else if (this.#items.length > 0 && !this.#closed) {
        this.#timer ??= setTimer(() => {
          this.#timer = undefined;
          this.#pump();
        }, this.#o.flushIntervalMs);
      }
    });
  }

  async #deliver(batch: readonly QueuedCall[]): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      let result: SendResult;
      try {
        result = await this.#o.send(batch);
      } catch {
        // a network error or a timeout: the request may or may not have arrived. Retrying the same calls is safe because
        // each keeps its messageId, which the gateway makes the eventId the consumers dedupe on: never mint a new one here
        result = { kind: 'retry' };
      }
      if (result.kind === 'ok') return;
      if (result.kind === 'reject') {
        this.#o.onError({
          kind: 'rejected',
          message: `the gateway rejected a batch (HTTP ${result.status}); not retried`,
          status: result.status,
          dropped: batch.length,
        });
        return;
      }
      if (attempt >= this.#o.maxRetries) {
        this.#o.onError({
          kind: 'retries_exhausted',
          message: `a batch failed ${attempt + 1} times; dropped`,
          ...(result.status === undefined ? {} : { status: result.status }),
          dropped: batch.length,
        });
        return;
      }
      const cap = Math.min(this.#o.retryMaxMs, this.#o.retryBaseMs * 2 ** attempt);
      const jittered = Math.floor(this.#o.random() * cap);
      // Retry-After is honoured up to the cap: a huge value must not hold the one in-flight batch for hours (F9)
      await sleep(Math.max(jittered, Math.min(result.retryAfterMs ?? 0, this.#o.retryMaxMs)));
    }
  }
}
