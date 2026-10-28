import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SDK_VERSION as BROWSER_SDK_VERSION } from '../index.js';
import { MaqetinRequestError, MaqetinServer, SDK_VERSION, type ServerFetchLike } from './index.js';

const SECRET = 'mq_sec_0123456789abcdefghijklmnopqrstuvwxyzABCDEFG';
const MESSAGE = {
  channel: 'email',
  templateId: 'tpl_1',
  to: { userId: 'u_42' },
  from: 'Zara <hello@mail.zara.example>',
  data: { order: { id: 'o_42' } },
} as const;

type Answer = number | 'network' | { status: number; body?: unknown; retryAfter?: string };

function fakeFetch(answers: Answer[]) {
  const sent: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
  const queue = [...answers];
  const fetch: ServerFetchLike = vi.fn(async (url, init) => {
    sent.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const next = queue.shift() ?? 202;
    if (next === 'network') throw new TypeError('fetch failed');
    const a = typeof next === 'number' ? { status: next } : next;
    const body =
      a.body ??
      (a.status === 202
        ? { success: true, data: { messageId: 'm_1', status: 'queued' } }
        : { success: false, error: { code: 'X', message: 'x' } });
    return {
      status: a.status,
      headers: {
        get: (n: string) => (n.toLowerCase() === 'retry-after' ? (a.retryAfter ?? null) : null),
      },
      json: async () => body,
    };
  });
  return { fetch, sent };
}
const server = (fetch: ServerFetchLike, over: Record<string, unknown> = {}) =>
  new MaqetinServer({
    secretKey: SECRET,
    endpoint: 'https://api.maqetin.example/',
    fetch,
    retryBaseMs: 1,
    retryMaxMs: 2,
    ...over,
  });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MaqetinServer', () => {
  it('posts the message to /v1/public/messages with the secret key and answers the message id', async () => {
    const f = fakeFetch([202]);
    expect(await server(f.fetch).messages.send(MESSAGE)).toEqual({
      messageId: 'm_1',
      status: 'queued',
    });
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]?.url).toBe('https://api.maqetin.example/v1/public/messages');
    expect(f.sent[0]?.headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(f.sent[0]?.body).toEqual(MESSAGE);
  });

  it('sends to the Maqetin API host when no endpoint is given', async () => {
    const f = fakeFetch([202]);
    await server(f.fetch, { endpoint: undefined }).messages.send(MESSAGE);
    expect(f.sent[0]?.url).toBe('https://api.maqetin.com/v1/public/messages');
  });

  it('is the same SDK version as the browser entry, and says so on every request', async () => {
    expect(SDK_VERSION).toBe(BROWSER_SDK_VERSION);
    const f = fakeFetch([202]);
    await server(f.fetch).messages.send(MESSAGE);
    expect(f.sent[0]?.headers['user-agent']).toBe(`maqetin-js/${SDK_VERSION}`);
  });

  it('sends the caller’s idempotency key as the header, not in the body', async () => {
    const f = fakeFetch([202]);
    await server(f.fetch).messages.send({ ...MESSAGE, idempotencyKey: 'order-42:receipt' });
    expect(f.sent[0]?.headers['idempotency-key']).toBe('order-42:receipt');
    expect(f.sent[0]?.body).toEqual(MESSAGE);
  });

  it('retries a 5xx, a 429 and a network error with one idempotency key, so a retry is the same message', async () => {
    const f = fakeFetch([503, { status: 429, retryAfter: '0' }, 'network', 202]);
    expect(await server(f.fetch).messages.send(MESSAGE)).toEqual({
      messageId: 'm_1',
      status: 'queued',
    });
    expect(f.sent).toHaveLength(4);
    const keys = new Set(f.sent.map((s) => s.headers['idempotency-key']));
    expect(keys.size).toBe(1);
    expect([...keys][0]).toMatch(/^[A-Za-z0-9_.:-]{1,100}$/);
  });

  it('gives up on a request that never answers and retries it with the same idempotency key', async () => {
    const sent: Array<Record<string, string>> = [];
    let n = 0;
    const fetch: ServerFetchLike = async (_url, init) => {
      sent.push(init.headers);
      n += 1;
      if (n === 1) return new Promise(() => undefined); // hangs for good, abort or not
      return {
        status: 202,
        headers: { get: () => null },
        json: async () => ({ success: true, data: { messageId: 'm_1', status: 'queued' } }),
      };
    };
    const result = await server(fetch, { requestTimeoutMs: 20 }).messages.send(MESSAGE);
    expect(result).toEqual({ messageId: 'm_1', status: 'queued' });
    expect(sent).toHaveLength(2);
    expect(sent[1]?.['idempotency-key']).toBe(sent[0]?.['idempotency-key']);
  });

  it('two sends without a key are two keys', async () => {
    const f = fakeFetch([202, 202]);
    const s = server(f.fetch);
    await s.messages.send(MESSAGE);
    await s.messages.send(MESSAGE);
    expect(f.sent[0]?.headers['idempotency-key']).not.toBe(f.sent[1]?.headers['idempotency-key']);
  });

  it.each([400, 401, 404, 409])(
    'does not retry a %s and throws it with the code and message',
    async (status) => {
      const f = fakeFetch([
        {
          status,
          body: {
            success: false,
            error: {
              code: 'CONFLICT',
              message: 'Sending is not available: sender_domain_invalid.',
            },
          },
        },
      ]);
      const err = await server(f.fetch)
        .messages.send(MESSAGE)
        .catch((e: unknown) => e);
      expect(f.sent).toHaveLength(1);
      expect(err).toBeInstanceOf(MaqetinRequestError);
      expect(err).toMatchObject({
        status,
        code: 'CONFLICT',
        message: 'Sending is not available: sender_domain_invalid.',
      });
    },
  );

  it('throws after its retries, with the last status', async () => {
    const f = fakeFetch([503, 503, 503]);
    const err = await server(f.fetch, { maxRetries: 2 })
      .messages.send(MESSAGE)
      .catch((e: unknown) => e);
    expect(f.sent).toHaveLength(3);
    expect(err).toMatchObject({ status: 503 });
  });

  it.each([
    ['a publishable key', 'mq_live_0123456789abcdefghijklmnopqrstuvwxyzABCDEFG'],
    ['no key', ''],
  ])('refuses %s', (_label, secretKey) => {
    expect(() => server(fakeFetch([]).fetch, { secretKey })).toThrow(/secret key/);
  });

  it('refuses to run in a web page, where the secret key would be public', () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('document', {});
    expect(() => server(fakeFetch([]).fetch)).toThrow(/server/);
  });

  it('refuses an idempotency key the API would refuse, before sending', async () => {
    const f = fakeFetch([]);
    await expect(
      server(f.fetch).messages.send({ ...MESSAGE, idempotencyKey: 'has space' }),
    ).rejects.toThrow(/idempotency/i);
    expect(f.sent).toHaveLength(0);
  });

  it('is never imported by the browser entry', () => {
    const entry = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    const client = readFileSync(new URL('../client.ts', import.meta.url), 'utf8');
    expect(entry).not.toMatch(/server/);
    expect(client).not.toMatch(/from '\.\/server/);
  });
});
