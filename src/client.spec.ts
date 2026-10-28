import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BATCH_MAX_ITEMS, BatchWireSchema, MAX_ID_LENGTH } from '../test/wire.js';
import { memoryStorage } from './context.js';
import { type ClientOptions, type FetchResponseLike, MaqetinClient, SDK_VERSION } from './index.js';
import { MAX_USER_ID_LENGTH } from './limits.js';

const PUBLIC_KEY = 'mq_live_SECRETwriteKEY0123456789abcdefghijklmnop';

type Sent = {
  url: string;
  headers: Record<string, string>;
  body: { batch: Array<Record<string, unknown>>; sentAt: string };
};

function fakeFetch(statuses: Array<number | 'network'> = []) {
  const sent: Sent[] = [];
  const queue = [...statuses];
  const fetch = vi.fn(
    async (
      url: string,
      init: { method: string; headers: Record<string, string>; body: string },
    ): Promise<FetchResponseLike> => {
      sent.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      const next = queue.shift() ?? 202;
      if (next === 'network') throw new TypeError('fetch failed');
      return { status: next, headers: { get: () => null } };
    },
  );
  return { fetch, sent };
}

function client(opts: Partial<ClientOptions> = {}, statuses: Array<number | 'network'> = []) {
  const f = fakeFetch(statuses);
  const onError = vi.fn();
  const c = new MaqetinClient({
    publicKey: PUBLIC_KEY,
    endpoint: 'https://ingest.example.test',
    fetch: f.fetch,
    onError,
    random: () => 1, // full jitter at its ceiling: the delays are the exact caps
    storage: memoryStorage(),
    ...opts,
  });
  return { c, ...f, onError };
}

beforeEach(() => vi.useFakeTimers({ now: new Date('2026-10-01T10:00:00.000Z') }));
afterEach(() => vi.useRealTimers());

describe('the public key', () => {
  // random-looking on purpose: the message below must hold no run of these characters
  const BODY = 'Zq8Xv3LmP0wRt6YhN2cBd9KjF4sGa7UeOi1HpTx5VyMk';
  const refused = [
    ['a secret key', `mq_sec_${BODY}`],
    ['a secret key with a space in front', ` mq_sec_${BODY}`],
    ['a secret key with a newline behind', `mq_sec_${BODY}\n`],
    ['a secret key in upper case', `MQ_SEC_${BODY}`],
    ['a secret key pasted with its scheme', `Bearer mq_sec_${BODY}`],
    ['a secret key with a short body', 'mq_sec_abc'],
    ['only the secret prefix', 'mq_sec_'],
  ] as const;

  it.each(refused)('refuses %s, and the message holds no key text', (_name, publicKey) => {
    const f = fakeFetch();
    let message = '';
    try {
      new MaqetinClient({
        publicKey,
        endpoint: 'https://ingest.example.test',
        fetch: f.fetch,
        storage: memoryStorage(),
      });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toMatch(/^maqetin-js: /);
    expect(message).not.toMatch(/mq_/i);
    expect(message).not.toContain(BODY);
    for (let i = 0; i + 6 <= BODY.length; i++) expect(message).not.toContain(BODY.slice(i, i + 6));
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it('accepts a publishable key, and sends it as the Bearer header', async () => {
    const { c, sent } = client({ flushAt: 1 });
    c.identify('u_1', {});
    await vi.runAllTimersAsync();
    expect(sent[0]?.headers.Authorization).toBe(`Bearer ${PUBLIC_KEY}`);
  });

  it('accepts any other string that is not a secret key (the gateway decides if it is a key)', () => {
    for (const publicKey of ['mq_live_short', 'not-a-key', 'mq_test_abc']) {
      expect(
        () =>
          new MaqetinClient({
            publicKey,
            endpoint: 'https://ingest.example.test',
            fetch: fakeFetch().fetch,
            storage: memoryStorage(),
          }),
        publicKey,
      ).not.toThrow();
    }
  });
});

describe('batching', () => {
  it('sends one batch when flushAt calls are queued, not before', async () => {
    const { c, sent } = client({ flushAt: 20, flushIntervalMs: 10_000 });
    c.identify('u_1');
    for (let i = 0; i < 18; i++) c.track('cart.viewed', { i });
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(0);
    c.track('cart.viewed', { i: 19 });
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body.batch).toHaveLength(20);
    expect(sent[0]?.url).toBe('https://ingest.example.test/v1/batch');
  });

  it('sends what is queued after flushIntervalMs', async () => {
    const { c, sent } = client({ flushAt: 20, flushIntervalMs: 500 });
    c.identify('u_1');
    await vi.advanceTimersByTimeAsync(499);
    expect(sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toHaveLength(1);
  });

  it('by default sends what is queued 100 ms after the first call (events land in near real time)', async () => {
    const { c, sent } = client();
    c.identify('u_1');
    await vi.advanceTimersByTimeAsync(99);
    expect(sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toHaveLength(1);
  });

  it(`never sends more than ${BATCH_MAX_ITEMS} items in one batch (the gateway limit)`, async () => {
    const { c, sent } = client({ flushAt: 1_000, flushIntervalMs: 60_000, maxQueueSize: 1_000 });
    c.identify('u_1');
    for (let i = 0; i < 250; i++) c.track('x');
    await c.flush();
    expect(sent.map((s) => s.body.batch.length)).toEqual([100, 100, 51]);
  });

  it('every payload passes the G2.1 batch wire schema; messageId on every call, sentAt on every batch', async () => {
    const { c, sent } = client();
    c.identify('u_1', { email: 'ada@example.com', plan: 'pro' });
    c.track('cart.viewed', { items: 2 });
    await c.flush();
    const body = sent[0]?.body;
    expect(BatchWireSchema.safeParse(body).success).toBe(true);
    const ids = body?.batch.map((b) => b.messageId);
    expect(new Set(ids).size).toBe(2);
    expect(body?.sentAt).toBe('2026-10-01T10:00:00.000Z');
    expect(body?.batch[0]).toMatchObject({ type: 'identify', userId: 'u_1', channel: 'node' });
    expect(body?.batch[1]).toMatchObject({ type: 'track', event: 'cart.viewed', userId: 'u_1' });
    expect(body?.batch.every((b) => typeof b.anonymousId === 'string')).toBe(true);
  });

  it('sends the public key as a Bearer token', async () => {
    const { c, sent } = client();
    c.identify('u_1');
    await c.flush();
    expect(sent[0]?.headers.Authorization).toBe(`Bearer ${PUBLIC_KEY}`);
    expect(sent[0]?.headers['Content-Type']).toBe('application/json');
  });
});

describe('retry (5xx, 429 and network errors; never another 4xx)', () => {
  it('retries a 503 with capped exponential backoff and full jitter', async () => {
    const { c, sent } = client(
      { retryBaseMs: 500, retryMaxMs: 4_000 },
      [503, 503, 503, 503, 503, 202],
    );
    c.identify('u_1');
    void c.flush();
    await vi.advanceTimersByTimeAsync(0);
    const times = [0];
    for (const expected of [500, 1_000, 2_000, 4_000, 4_000]) {
      await vi.advanceTimersByTimeAsync(expected - 1);
      expect(sent).toHaveLength(times.length);
      await vi.advanceTimersByTimeAsync(1);
      times.push(expected);
      expect(sent).toHaveLength(times.length);
    }
    expect(sent).toHaveLength(6);
  });

  it('jitter: the delay is a random fraction of the cap', async () => {
    const { c, sent } = client({ retryBaseMs: 1_000, random: () => 0.25 }, [500, 202]);
    c.identify('u_1');
    void c.flush();
    await vi.advanceTimersByTimeAsync(249);
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toHaveLength(2);
  });

  it('a retried batch keeps its messageIds and items; sentAt is the new send time', async () => {
    const { c, sent } = client({ retryBaseMs: 1_000 }, [503, 202]);
    c.identify('u_1');
    c.track('x');
    void c.flush();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sent).toHaveLength(2);
    expect(sent[1]?.body.batch).toEqual(sent[0]?.body.batch);
    expect(sent[1]?.body.sentAt).toBe('2026-10-01T10:00:01.000Z');
    expect(sent[0]?.body.sentAt).toBe('2026-10-01T10:00:00.000Z');
  });

  it('retries a network error', async () => {
    const { c, sent } = client({ retryBaseMs: 100 }, ['network', 202]);
    c.identify('u_1');
    await Promise.all([c.flush(), vi.advanceTimersByTimeAsync(100)]);
    expect(sent).toHaveLength(2);
  });

  it('retries a 429 (rate limited), honouring Retry-After when it is longer', async () => {
    const f = fakeFetch();
    let calls = 0;
    f.fetch.mockImplementation(async (url, init) => {
      f.sent.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      calls += 1;
      return calls === 1
        ? {
            status: 429,
            headers: { get: (h: string) => (h.toLowerCase() === 'retry-after' ? '3' : null) },
          }
        : { status: 202, headers: { get: () => null } };
    });
    const c = new MaqetinClient({
      publicKey: PUBLIC_KEY,
      endpoint: 'https://ingest.example.test',
      fetch: f.fetch,
      random: () => 1,
      retryBaseMs: 100,
      storage: memoryStorage(),
    });
    c.identify('u_1');
    void c.flush();
    await vi.advanceTimersByTimeAsync(2_999);
    expect(f.sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.sent).toHaveLength(2);
  });

  it.each([400, 401, 403, 413, 422])(
    'a %i is dropped, not retried, and reported',
    async (status) => {
      const { c, sent, onError } = client({}, [status]);
      c.identify('u_1');
      await c.flush();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(sent).toHaveLength(1);
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'rejected', status, dropped: 1 }),
      );
    },
  );

  it('gives up after maxRetries, reports the drop (never silent), and moves on', async () => {
    const { c, sent, onError } = client(
      { maxRetries: 2, retryBaseMs: 10, retryMaxMs: 10 },
      [503, 503, 503, 202],
    );
    c.identify('u_1');
    void c.flush();
    await vi.advanceTimersByTimeAsync(100);
    expect(sent).toHaveLength(3);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'retries_exhausted', dropped: 1 }),
    );
    c.track('after');
    await c.flush();
    expect(sent).toHaveLength(4);
  });

  it('one batch in flight at a time: order is kept', async () => {
    const { c, sent } = client({ flushAt: 1, retryBaseMs: 100 }, [503, 202, 202]);
    c.identify('u_1');
    c.track('second');
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(100);
    await c.flush();
    expect(sent.map((s) => s.body.batch.map((b) => b.type))).toEqual([
      ['identify'],
      ['identify'],
      ['track'],
    ]);
  });
});

describe('queue bound and misuse: reported, never silent', () => {
  it('reports an overflow and refuses the new call', async () => {
    const { c, onError, sent } = client({ maxQueueSize: 3, flushAt: 100, flushIntervalMs: 60_000 });
    c.identify('u_1');
    c.track('a');
    c.track('b');
    expect(c.track('c')).toBe(false);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'queue_full', dropped: 1 }),
    );
    await c.flush();
    expect(sent[0]?.body.batch).toHaveLength(3);
  });

  it('track takes an explicit userId', async () => {
    const { c, sent } = client();
    c.track('x', {}, { userId: 'u_9' });
    await c.flush();
    expect(sent[0]?.body.batch[0]?.userId).toBe('u_9');
  });
});

describe('the id length cap', () => {
  const ok = 'a'.repeat(256);
  const over = 'a'.repeat(257);

  it('is the same number as the event schemas', () => {
    expect(MAX_USER_ID_LENGTH).toBe(MAX_ID_LENGTH);
  });

  it('identify takes 256 characters and refuses 257, reporting it and queueing nothing', async () => {
    const { c, onError, sent } = client();
    expect(c.identify(ok)).toBe(true);
    expect(c.identify(over)).toBe(false);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'invalid_call', dropped: 1 }),
    );
    await c.flush();
    expect(sent[0]?.body.batch).toHaveLength(1);
  });

  it('track takes 256 characters of options.userId and refuses 257', async () => {
    const { c, onError, sent } = client();
    expect(c.track('x', {}, { userId: ok })).toBe(true);
    expect(c.track('x', {}, { userId: over })).toBe(false);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'invalid_call', dropped: 1 }),
    );
    await c.flush();
    expect(sent[0]?.body.batch).toHaveLength(1);
  });

  it('counts characters, not UTF-16 units: 256 emoji pass, 257 do not', () => {
    const { c } = client();
    expect(c.identify('😀'.repeat(256))).toBe(true);
    expect(c.identify('😀'.repeat(257))).toBe(false);
    expect(c.track('x', {}, { userId: '😀'.repeat(256) })).toBe(true);
    expect(c.track('x', {}, { userId: '😀'.repeat(257) })).toBe(false);
  });

  it('refuses a huge id, and a refused call does not drop the calls around it', async () => {
    const { c, sent } = client();
    c.track('before');
    expect(c.identify('x'.repeat(505_000))).toBe(false);
    c.track('after');
    await c.flush();
    expect(sent[0]?.body.batch.map((i) => i.event)).toEqual(['before', 'after']);
  });

  it('reports the refusal without any part of the id', () => {
    const { c, onError } = client();
    const secret = `secret-${'z'.repeat(300)}`;
    c.identify(secret);
    c.track('x', {}, { userId: secret });
    const reported = JSON.stringify(onError.mock.calls);
    expect(onError).toHaveBeenCalledTimes(2);
    expect(reported).not.toContain('secret-');
    expect(reported).not.toContain('zzzzzz');
  });

  it('a refused identify does not make that user the remembered one', async () => {
    const { c, sent } = client();
    c.identify('u_1');
    expect(c.identify(over)).toBe(false);
    c.track('after');
    await c.flush();
    expect(sent[0]?.body.batch[1]).toMatchObject({ type: 'track', userId: 'u_1' });
    const { c: fresh, sent: freshSent } = client();
    expect(fresh.identify(over)).toBe(false);
    fresh.track('after');
    await fresh.flush();
    expect(freshSent[0]?.body.batch[0]).not.toHaveProperty('userId');
  });

  it('an identified user is not asked again: a track after identify carries it', async () => {
    const { c, sent } = client();
    c.identify(ok);
    c.track('x');
    await c.flush();
    expect(sent[0]?.body.batch[1]).toMatchObject({ userId: ok });
  });
});

describe('who a track is about', () => {
  it('a track before any identify sends only its anonymousId, with no userId key', async () => {
    const { c, onError, sent } = client();
    expect(c.track('page.viewed', { path: '/' })).toBe(true);
    await c.flush();
    const item = sent[0]?.body.batch[0];
    expect(item).toMatchObject({ type: 'track', event: 'page.viewed' });
    expect(typeof item?.anonymousId).toBe('string');
    expect(item?.anonymousId).not.toBe('');
    expect(item).not.toHaveProperty('userId');
    expect(onError).not.toHaveBeenCalled();
    expect(BatchWireSchema.safeParse(sent[0]?.body).success).toBe(true);
  });

  it('after identify a track carries both ids, the same anonymousId as the identify', async () => {
    const { c, sent } = client();
    c.track('before');
    c.identify('u_1');
    c.track('after');
    await c.flush();
    const [before, identify, after] = sent[0]?.body.batch ?? [];
    expect(before).not.toHaveProperty('userId');
    expect(after).toMatchObject({ userId: 'u_1', anonymousId: identify?.anonymousId });
    expect(before?.anonymousId).toBe(identify?.anonymousId);
    expect(BatchWireSchema.safeParse(sent[0]?.body).success).toBe(true);
  });

  it('an explicit userId on one track does not stick to the next', async () => {
    const { c, sent } = client();
    c.track('a', {}, { userId: 'u_9' });
    c.track('b');
    await c.flush();
    const [a, b] = sent[0]?.body.batch ?? [];
    expect(a).toMatchObject({ userId: 'u_9' });
    expect(b).not.toHaveProperty('userId');
  });

  it('after reset() a track is anonymous again, under a new anonymousId', async () => {
    const { c, sent } = client();
    c.identify('u_1');
    c.track('x');
    c.reset();
    c.track('y');
    await c.flush();
    const [, tracked, anonymous] = sent[0]?.body.batch ?? [];
    expect(tracked).toMatchObject({ userId: 'u_1' });
    expect(anonymous).not.toHaveProperty('userId');
    expect(anonymous?.anonymousId).toEqual(expect.any(String));
    expect(anonymous?.anonymousId).not.toBe(tracked?.anonymousId);
  });

  it.each([
    ['an empty userId', ''],
    ['a userId that is not a string', 42],
    ['a null userId', null],
  ])('refuses %s, reports it, and does not send the event as anonymous', async (_name, userId) => {
    const { c, onError, sent } = client();
    expect(c.track('x', {}, { userId: userId as string })).toBe(false);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'invalid_call', dropped: 1 }),
    );
    await c.flush();
    expect(sent).toHaveLength(0);
  });

  it('a null userId is refused, not attributed to the identified user', async () => {
    const { c, onError, sent } = client();
    c.identify('u_1');
    expect(c.track('x', {}, { userId: null as unknown as string })).toBe(false);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'invalid_call', dropped: 1 }),
    );
    await c.flush();
    expect(sent[0]?.body.batch.map((i) => i.type)).toEqual(['identify']);
  });

  it('an explicit userId wins over the identified user for that call only', async () => {
    const { c, sent } = client();
    c.identify('u_1');
    c.track('a', {}, { userId: 'u_9' });
    c.track('b');
    await c.flush();
    const [, a, b] = sent[0]?.body.batch ?? [];
    expect(a).toMatchObject({ userId: 'u_9' });
    expect(b).toMatchObject({ userId: 'u_1' });
  });

  it.each([
    [
      'removing the stored id fails',
      {
        removeItem: () => {
          throw new Error('blocked');
        },
      },
    ],
    [
      'removing and writing the stored id both fail',
      {
        removeItem: () => {
          throw new Error('blocked');
        },
        setItem: () => {
          throw new Error('blocked');
        },
      },
    ],
  ])('reset() starts a new anonymousId even when %s', async (_name, broken) => {
    const { c, sent } = client({ storage: { ...memoryStorage(), ...broken } });
    c.track('before');
    c.reset();
    c.track('after');
    await c.flush();
    const [before, after] = sent[0]?.body.batch ?? [];
    expect(after?.anonymousId).toEqual(expect.any(String));
    expect(after?.anonymousId).not.toBe(before?.anonymousId);
  });

  it('identify still needs a userId', async () => {
    const { c, onError, sent } = client();
    expect(c.identify('')).toBe(false);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ kind: 'invalid_call' }));
    await c.flush();
    expect(sent).toHaveLength(0);
  });

  it('a retried anonymous batch keeps its messageIds and stays anonymous', async () => {
    const { c, sent } = client({ retryBaseMs: 10, retryMaxMs: 10 }, [503]);
    c.track('x');
    void c.flush();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sent).toHaveLength(2);
    const ids = sent.map((b) => b.body.batch.map((i) => i.messageId));
    expect(ids[1]).toEqual(ids[0]);
    expect(sent[1]?.body.batch[0]).not.toHaveProperty('userId');
  });
});

describe('the public key is never exposed', () => {
  it('not in errors, not in onError, not in the client object', async () => {
    const { c, onError } = client({ maxRetries: 0 }, [400, 'network', 503]);
    c.identify('u_1');
    await c.flush();
    c.track('x');
    await c.flush();
    await vi.advanceTimersByTimeAsync(60_000);
    const reported =
      JSON.stringify(onError.mock.calls) +
      String(onError.mock.calls.map((x) => String(x[0]?.message)));
    expect(onError).toHaveBeenCalled();
    expect(reported).not.toContain('SECRETwriteKEY');
    expect(JSON.stringify(c)).not.toContain('SECRETwriteKEY');
    expect(Object.values(c).join()).not.toContain('SECRETwriteKEY');
  });
});

describe('auto-collected context', () => {
  it('every call carries context (timezone, locale, deviceId, library) by default', async () => {
    const { c, sent } = client();
    c.identify('u_1');
    await c.flush();
    expect(sent[0]?.body.batch[0]?.context).toMatchObject({
      library: { name: 'maqetin-js', version: SDK_VERSION },
      deviceId: expect.any(String),
      timezone: expect.any(String),
    });
  });

  it('disableAutoCollection sends none', async () => {
    const { c, sent } = client({ disableAutoCollection: true });
    c.identify('u_1');
    await c.flush();
    expect(sent[0]?.body.batch[0]).not.toHaveProperty('context');
  });
});

describe('REVIEW G2 F8/F9', () => {
  afterEach(() => vi.unstubAllGlobals());

  function webClient(opts: Partial<ClientOptions> = {}) {
    const listeners: Record<string, () => void> = {};
    const doc = {
      visibilityState: 'visible',
      addEventListener: (type: string, fn: () => void) => {
        listeners[`document:${type}`] = fn;
      },
    };
    vi.stubGlobal('window', {});
    vi.stubGlobal('document', doc);
    vi.stubGlobal('addEventListener', (type: string, fn: () => void) => {
      listeners[type] = fn;
    });
    const inits: Array<{ keepalive?: boolean; body: string }> = [];
    const fetch = vi.fn(async (_url: string, init: { keepalive?: boolean; body: string }) => {
      inits.push(init);
      return { status: 202, headers: { get: () => null } };
    });
    const c = new MaqetinClient({
      publicKey: PUBLIC_KEY,
      endpoint: 'https://ingest.example.test',
      fetch,
      storage: memoryStorage(),
      autoPageViews: false,
      ...opts,
    });
    return { c, inits, listeners, doc };
  }

  it('F8: keepalive only for a body under 60 KB (browsers refuse larger keepalive requests)', async () => {
    const { c, inits } = webClient();
    c.identify('u_1');
    await c.flush();
    for (let i = 0; i < 3; i++) c.track('big', { blob: 'x'.repeat(25_000) });
    await c.flush();
    expect(inits[0]?.keepalive).toBe(true);
    expect(inits[1]?.keepalive).toBe(false);
  });

  it('F9: on pagehide the queue is flushed (no silent loss when the tab closes)', async () => {
    const { c, inits, listeners } = webClient({ flushIntervalMs: 60_000 });
    c.identify('u_1');
    expect(typeof listeners.pagehide).toBe('function');
    listeners.pagehide?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(inits).toHaveLength(1);
  });

  it('flushes when the page is hidden (mobile Safari often never fires pagehide), and not when it shows again', async () => {
    const { c, inits, listeners, doc } = webClient({ flushIntervalMs: 60_000 });
    c.identify('u_1');
    expect(typeof listeners['document:visibilitychange']).toBe('function');
    doc.visibilityState = 'visible';
    listeners['document:visibilitychange']?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(inits).toHaveLength(0);
    doc.visibilityState = 'hidden';
    listeners['document:visibilitychange']?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(inits).toHaveLength(1);
  });

  it('F9: Retry-After is capped by retryMaxMs', async () => {
    const f = fakeFetch();
    let n = 0;
    f.fetch.mockImplementation(async (url, init) => {
      f.sent.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      n += 1;
      return n === 1
        ? {
            status: 503,
            headers: { get: (h: string) => (h.toLowerCase() === 'retry-after' ? '86400' : null) },
          }
        : { status: 202, headers: { get: () => null } };
    });
    const c = new MaqetinClient({
      publicKey: PUBLIC_KEY,
      endpoint: 'https://ingest.example.test',
      fetch: f.fetch,
      random: () => 1,
      retryBaseMs: 100,
      retryMaxMs: 5_000,
      storage: memoryStorage(),
    });
    c.identify('u_1');
    void c.flush();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.sent).toHaveLength(2);
  });

  it.each([
    ['maxRetries', Number.NaN],
    ['maxRetries', -1],
    ['flushAt', 0],
    ['maxQueueSize', Number.POSITIVE_INFINITY],
    ['retryBaseMs', Number.NaN],
  ])('F9: refuses %s = %s (a NaN maxRetries would retry forever)', (key, value) => {
    expect(() => client({ [key]: value })).toThrow(new RegExp(key));
  });
});

describe('client lifecycle', () => {
  it('close() flushes and stops the timer', async () => {
    const { c, sent } = client({ flushIntervalMs: 500 });
    c.identify('u_1');
    await c.close();
    expect(sent).toHaveLength(1);
    expect(c.track('x')).toBe(false);
  });

  it('reset() forgets the user and starts a new anonymous id', async () => {
    const { c, sent } = client();
    c.identify('u_1');
    c.reset();
    c.identify('u_2');
    await c.flush();
    const [a, b] = sent[0]?.body.batch ?? [];
    expect(a?.anonymousId).not.toBe(b?.anonymousId);
  });

  it('sends to the Maqetin ingestion host when no endpoint is given', async () => {
    const { c, sent } = client({ endpoint: undefined });
    c.identify('u_1');
    await c.flush();
    expect(sent[0]?.url).toBe('https://in.maqetin.com/v1/batch');
  });

  it('library version is the package version', async () => {
    const { readFileSync } = await import('node:fs');
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string;
    };
    expect(SDK_VERSION).toBe(pkg.version);
  });
});

describe('an endpoint on the customer’s own domain (first-party proxy)', () => {
  afterEach(() => vi.unstubAllGlobals());

  /** A page deep inside the site, so that a path that is only relative to the page would land in the wrong place. */
  function pageAt(href: string) {
    vi.stubGlobal('window', {});
    vi.stubGlobal('location', { href });
    vi.stubGlobal('document', {
      title: '',
      referrer: '',
      visibilityState: 'visible',
      addEventListener: () => undefined,
    });
    vi.stubGlobal('addEventListener', () => undefined);
  }

  async function sentWith(endpoint: string) {
    const { c, sent } = client({ endpoint, autoPageViews: false });
    c.identify('u_1');
    await c.flush();
    return sent;
  }

  it.each([
    ['a path on the site', '/relay', 'https://brand.example/relay/v1/batch'],
    ['a path with a trailing slash', '/relay/', 'https://brand.example/relay/v1/batch'],
    ['a path of two parts', '/a/relay', 'https://brand.example/a/relay/v1/batch'],
    ['the root of the site', '/', 'https://brand.example/v1/batch'],
    [
      'a full address on the site',
      'https://brand.example/relay',
      'https://brand.example/relay/v1/batch',
    ],
  ])(
    'sends the batch to the same origin when endpoint is %s',
    async (_name, endpoint, expected) => {
      pageAt('https://brand.example/shop/cart?step=2#pay');
      const sent = await sentWith(endpoint);
      expect(sent).toHaveLength(1);
      expect(sent[0]?.url).toBe(expected);
      expect(sent[0]?.headers).toEqual({
        Authorization: `Bearer ${PUBLIC_KEY}`,
        'Content-Type': 'application/json',
      });
      expect(sent[0]?.body.batch.map((call) => call.type)).toEqual(['identify']);
    },
  );

  it.each([
    ['a path without its first slash', 'relay'],
    ['an address without a scheme, which a page reads as a path', 'brand.example/relay'],
    ['a path that starts with two slashes, which names another host', '//other.example/relay'],
    ['a path with a backslash, which a browser reads as a slash', '/\\other.example/relay'],
    ['a path with a tab, which a browser drops', '/\t/other.example/relay'],
    ['an empty string', ''],
    ['a scheme that is not http', 'ftp://brand.example/relay'],
  ])('refuses %s', (_name, endpoint) => {
    pageAt('https://brand.example/shop');
    expect(() => client({ endpoint })).toThrow(/http\(s\) endpoint/);
  });

  it('refuses a path on a page that is not served over http(s), such as a file', () => {
    pageAt('file:///Users/ada/site/index.html');
    expect(() => client({ endpoint: '/relay' })).toThrow(/http\(s\) endpoint/);
  });

  it('refuses a path outside a web page, where fetch cannot resolve it', () => {
    expect(() => client({ endpoint: '/relay' })).toThrow(/web page/);
  });
});

describe('a request that never answers', () => {
  it('is given up after requestTimeoutMs and retried with the same messageIds, even when fetch ignores the abort', async () => {
    const f = fakeFetch();
    let n = 0;
    const signals: unknown[] = [];
    f.fetch.mockImplementation(async (url, init) => {
      f.sent.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      signals.push((init as { signal?: unknown }).signal);
      n += 1;
      // the first request hangs for good, whatever the signal says
      return n === 1
        ? new Promise<FetchResponseLike>(() => undefined)
        : { status: 202, headers: { get: () => null } };
    });
    const onError = vi.fn();
    const c = new MaqetinClient({
      publicKey: PUBLIC_KEY,
      endpoint: 'https://ingest.example.test',
      fetch: f.fetch,
      onError,
      random: () => 1,
      retryBaseMs: 100,
      requestTimeoutMs: 2_000,
      storage: memoryStorage(),
    });
    c.identify('u_1');
    const done = c.flush();
    await vi.advanceTimersByTimeAsync(2_000 + 100);
    await done;
    expect(f.sent).toHaveLength(2);
    expect(f.sent[1]?.body.batch[0]?.messageId).toBe(f.sent[0]?.body.batch[0]?.messageId);
    expect((signals[0] as { aborted?: boolean } | undefined)?.aborted).toBe(true);
    expect(onError).not.toHaveBeenCalled();
  });

  it('refuses a timeout that is not a positive integer', () => {
    expect(() => client({ requestTimeoutMs: 0 })).toThrow(/requestTimeoutMs/);
  });
});

describe('the identified user across page loads', () => {
  it('a new client on the same storage keeps the user identified, and reset forgets them for the next one', async () => {
    const storage = memoryStorage();
    const first = client({ storage });
    first.c.identify('u_42');
    await first.c.flush();
    const second = client({ storage });
    second.c.track('page.viewed');
    await second.c.flush();
    expect(second.sent[0]?.body.batch[0]).toMatchObject({ type: 'track', userId: 'u_42' });
    second.c.reset();
    const third = client({ storage });
    third.c.track('page.viewed');
    await third.c.flush();
    expect(third.sent[0]?.body.batch[0]).not.toHaveProperty('userId');
  });

  it.each([
    ['empty', ''],
    ['too long', 'u'.repeat(MAX_USER_ID_LENGTH + 1)],
  ])('ignores a stored user id that is %s', async (_label, stored) => {
    const storage = memoryStorage();
    storage.setItem('maqetin.userId', stored);
    const { c, sent } = client({ storage });
    c.track('page.viewed');
    await c.flush();
    expect(sent[0]?.body.batch[0]).not.toHaveProperty('userId');
  });
});

describe('one bad call never costs the batch it would have joined', () => {
  const circular = () => {
    const o: Record<string, unknown> = { a: 1 };
    o.self = o;
    return o;
  };

  it.each([
    ['a circular property', () => ({ loop: circular() })],
    ['a BigInt property', () => ({ amount: BigInt(1) })],
    ['an event over 32 KiB', () => ({ blob: 'x'.repeat(33 * 1024) })],
  ])('refuses %s alone and reports it; the calls around it are sent', async (_label, props) => {
    const { c, sent, onError } = client();
    c.track('before');
    expect(c.track('bad', props())).toBe(false);
    c.track('after');
    await c.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body.batch.map((i) => i.event)).toEqual(['before', 'after']);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'invalid_call', dropped: 1 }),
    );
  });

  it('refuses a timestamp option that is not a valid Date, without throwing', () => {
    const { c, onError } = client();
    expect(c.track('x', {}, { timestamp: '2026-10-17' as never })).toBe(false);
    expect(c.track('x', {}, { timestamp: new Date('nope') })).toBe(false);
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it('a caller who changes the properties after track cannot change the queued event', async () => {
    const { c, sent } = client();
    const props: Record<string, unknown> = { plan: 'free' };
    c.track('upgraded', props);
    props.plan = 'pro';
    await c.flush();
    expect(sent[0]?.body.batch[0]?.properties).toEqual({ plan: 'free' });
  });

  it('cuts batches by bytes as well as count, under the gateway body limit', async () => {
    const { c, sent } = client({ flushAt: 100 });
    for (let i = 0; i < 40; i++) c.track('chunky', { blob: 'x'.repeat(30_000) });
    await c.flush();
    expect(sent.length).toBeGreaterThan(1);
    expect(sent.flatMap((b) => b.body.batch)).toHaveLength(40);
    for (const b of sent) expect(JSON.stringify(b.body).length).toBeLessThanOrEqual(480_000);
  });

  describe('typed traits, checked the way the gateway checks them', () => {
    const traitCases: Array<[string, Record<string, unknown>]> = [
      ['a number as firstName', { firstName: 1 }],
      ['a number as createdAt', { createdAt: 123 }],
      ['a word as createdAt', { createdAt: 'yesterday' }],
      ['an object as phone', { phone: { n: 1 } }],
    ];

    it.each(traitCases)('refuses %s, and so does the gateway schema', async (_label, traits) => {
      const { c } = client();
      expect(c.identify('u_1', traits)).toBe(false);
      const wire = {
        batch: [
          {
            type: 'identify',
            userId: 'u_1',
            traits,
            timestamp: '2026-10-01T10:00:00.000Z',
            channel: 'node',
          },
        ],
      };
      expect(BatchWireSchema.safeParse(wire).success).toBe(false);
    });

    it('accepts typed traits of the right types, and the gateway schema accepts what it sends', async () => {
      const { c, sent } = client();
      expect(
        c.identify('u_1', {
          firstName: 'Ada',
          phone: '+2348000000000',
          createdAt: new Date('2026-01-01T00:00:00Z'),
          plan: 'pro',
        }),
      ).toBe(true);
      await c.flush();
      expect(BatchWireSchema.safeParse(sent[0]?.body).success).toBe(true);
    });
  });
});

describe('page views', () => {
  afterEach(() => vi.unstubAllGlobals());

  /** A browser page at `href`, with a history that moves `location` like a real one, and its window listeners. */
  function browser(href: string) {
    const location = { href };
    const listeners: Record<string, Array<() => void>> = {};
    const moves: string[] = [];
    const history = {
      pushState(_state: unknown, _title: string, url: string) {
        moves.push(url);
        location.href = new URL(url, location.href).href;
      },
      replaceState(_state: unknown, _title: string, url: string) {
        location.href = new URL(url, location.href).href;
      },
    };
    vi.stubGlobal('window', {});
    vi.stubGlobal('location', location);
    vi.stubGlobal('history', history);
    vi.stubGlobal('document', {
      title: 'Brand',
      referrer: 'https://www.google.com/search?q=brand',
      visibilityState: 'visible',
      addEventListener: () => undefined,
    });
    vi.stubGlobal('addEventListener', (type: string, fn: () => void) => {
      listeners[type] = [...(listeners[type] ?? []), fn];
    });
    vi.stubGlobal('removeEventListener', (type: string, fn: () => void) => {
      listeners[type] = (listeners[type] ?? []).filter((l) => l !== fn);
    });
    const back = (url: string) => {
      location.href = new URL(url, location.href).href;
      for (const fn of listeners.popstate ?? []) fn();
    };
    return { location, history, listeners, moves, back };
  }

  function webPageClient(opts: Partial<ClientOptions> = {}) {
    const f = fakeFetch();
    const c = new MaqetinClient({
      publicKey: PUBLIC_KEY,
      endpoint: 'https://ingest.example.test',
      fetch: f.fetch,
      storage: memoryStorage(),
      flushIntervalMs: 0,
      ...opts,
    });
    const views = async () => {
      await c.flush();
      return f.sent.flatMap((b) => b.body.batch).filter((i) => i.event === 'page.viewed') as Array<{
        properties?: Record<string, unknown>;
        context?: Record<string, unknown>;
      }>;
    };
    return { c, views, sent: f.sent };
  }

  it('page() sends page.viewed with the page as properties, which the caller cannot override, and the gateway accepts it', async () => {
    browser('https://brand.example/pricing?coupon=x#plans');
    const { c, views, sent } = webPageClient({ autoPageViews: false });
    c.page({ plan: 'pro', path: '/fake' });
    const [view] = await views();
    expect(view?.properties).toEqual({
      plan: 'pro',
      path: '/pricing',
      url: 'https://brand.example/pricing',
      title: 'Brand',
      referrer: 'https://www.google.com/search',
    });
    expect(view?.context?.page).toEqual({
      url: 'https://brand.example/pricing',
      path: '/pricing',
      title: 'Brand',
      referrer: 'https://www.google.com/search',
    });
    expect(BatchWireSchema.safeParse(sent[0]?.body).success).toBe(true);
  });

  it('records the first page by itself, and the campaign of a landing URL', async () => {
    browser('https://brand.example/?utm_source=newsletter&utm_campaign=launch');
    const { views } = webPageClient();
    const seen = await views();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.properties).toMatchObject({ path: '/' });
    expect(seen[0]?.context?.campaign).toEqual({
      source: 'newsletter',
      name: 'launch',
    });
  });

  it('records a new path of a single-page app, and not the same path again or a change of query only', async () => {
    const b = browser('https://brand.example/');
    const { views } = webPageClient();
    b.history.pushState({}, '', '/pricing');
    b.history.pushState({}, '', '/pricing');
    b.history.pushState({}, '', '/pricing?plan=pro');
    b.history.replaceState({}, '', '/signup');
    b.back('/pricing');
    expect((await views()).map((v) => v.properties?.path)).toEqual([
      '/',
      '/pricing',
      '/signup',
      '/pricing',
    ]);
  });

  it('records nothing by itself with autoPageViews off, and page() still works', async () => {
    const b = browser('https://brand.example/');
    const { c, views } = webPageClient({ autoPageViews: false });
    b.history.pushState({}, '', '/pricing');
    expect(await views()).toHaveLength(0);
    c.page();
    expect(await views()).toHaveLength(1);
  });

  it('patches the history once for two clients, each records its own view, and close() stops one', async () => {
    const b = browser('https://brand.example/');
    const first = webPageClient();
    const wrapped = b.history.pushState;
    const second = webPageClient();
    expect(b.history.pushState, 'a second client adds no second wrapper').toBe(wrapped);
    b.history.pushState({}, '', '/a');
    expect(b.moves).toEqual(['/a']); // the real pushState ran once, not once per client
    expect((await first.views()).map((v) => v.properties?.path)).toEqual(['/', '/a']);
    expect((await second.views()).map((v) => v.properties?.path)).toEqual(['/', '/a']);
    await first.c.close();
    b.history.pushState({}, '', '/b');
    expect((await second.views()).map((v) => v.properties?.path)).toEqual(['/', '/a', '/b']);
  });

  it('in Node, page() sends what the caller gives and nothing about a browser', async () => {
    const { c, sent } = client();
    c.page({ path: '/docs' });
    await c.flush();
    expect(sent[0]?.body.batch[0]).toMatchObject({
      event: 'page.viewed',
      properties: { path: '/docs' },
    });
    expect(
      (sent[0]?.body.batch[0]?.context as { page?: unknown } | undefined)?.page,
    ).toBeUndefined();
  });
});
