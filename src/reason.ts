import type { FetchResponseLike } from './runtime.js';

/** What the gateway said when it refused a batch: its `error`, and for a payload problem where it is (`at`). */
export interface GatewayReason {
  error?: string;
  at?: string[];
}

const MAX_BODY_CHARS = 8_192;
const MAX_TEXT = 200;
const MAX_AT = 20;
const KEY_TEXT = /mq_[a-z]+_/i;

/** Any key prefix, or any run of 16 characters of the key (it may be echoed cut, or without its prefix). */
function holdsKey(value: string, key: string): boolean {
  if (KEY_TEXT.test(value)) return true;
  const run = Math.min(16, key.length);
  for (let i = 0; i + run <= key.length; i++)
    if (value.includes(key.slice(i, i + run))) return true;
  return false;
}

/** A string the SDK may repeat: never one that holds key text (a proxy may echo the Authorization header). */
function clean(value: unknown, key: string): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  if (holdsKey(value, key)) return undefined;
  return value.length > MAX_TEXT ? value.slice(0, MAX_TEXT) : value;
}

/**
 * Reads the gateway's answer to a refused batch. A fetch without `text()`, a body that is large or not JSON, or one
 * without the expected fields gives no reason: the error then holds the status alone. Never throws.
 */
export async function readReason(res: FetchResponseLike, key: string): Promise<GatewayReason> {
  if (typeof res.text !== 'function') return {};
  let body: unknown;
  try {
    const text = await res.text();
    if (typeof text !== 'string' || text.length > MAX_BODY_CHARS) return {};
    body = JSON.parse(text);
  } catch {
    return {};
  }
  if (typeof body !== 'object' || body === null) return {};
  const fields = body as Record<string, unknown>;
  const reason: GatewayReason = {};
  const error = clean(fields.error, key);
  if (error !== undefined) reason.error = error;
  if (Array.isArray(fields.at)) {
    const at = fields.at
      .slice(0, MAX_AT)
      .map((x) => clean(x, key))
      .filter((x): x is string => x !== undefined);
    if (at.length > 0) reason.at = at;
  }
  return reason;
}
