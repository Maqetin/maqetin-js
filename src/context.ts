import { campaignContext, pageContext } from './page.js';
import { g, uuid } from './runtime.js';
import type { Channel, EventContext } from './types.js';
import { SDK_NAME, SDK_VERSION } from './version.js';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const DEVICE_ID_KEY = 'maqetin.deviceId';
export const ANONYMOUS_ID_KEY = 'maqetin.anonymousId';
/** The identified user, kept so a page load does not turn their events anonymous. Removed by `reset()`. */
export const USER_ID_KEY = 'maqetin.userId';

export function memoryStorage(): StorageLike {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
}

/** `localStorage` when the page may use it (it throws in some private modes), else undefined. */
export function browserStorage(): StorageLike | undefined {
  try {
    const s = g.localStorage;
    if (!s) return undefined;
    s.getItem(DEVICE_ID_KEY);
    return s;
  } catch {
    return undefined;
  }
}

/** An install-scoped id: generated once, kept in storage. Never an advertising id (IDFA, GAID). */
export function persistentId(storage: StorageLike, key: string): string {
  try {
    const existing = storage.getItem(key);
    if (existing && existing.length <= 64) return existing;
  } catch {
    // unreadable storage: a session-only id below
  }
  const id = uuid();
  try {
    storage.setItem(key, id);
  } catch {
    // unwritable storage: the id lasts this session
  }
  return id;
}

export function detectChannel(): Channel {
  return g.window !== undefined && g.document !== undefined ? 'web' : 'node';
}

/**
 * Scope §4.2: IANA `timezone`, `locale`, install-scoped `deviceId`, `library`, and on the web `userAgent`, the `page`
 * and the `campaign` of its URL. Nothing else. The shape is fixed because events are immutable.
 */
export function collectContext(storage: StorageLike): EventContext {
  const resolved = Intl.DateTimeFormat().resolvedOptions();
  const ctx: EventContext = {};
  if (typeof resolved.timeZone === 'string' && resolved.timeZone.length > 0)
    ctx.timezone = resolved.timeZone;
  const locale = g.navigator?.language ?? resolved.locale;
  if (locale) ctx.locale = locale.slice(0, 35);
  ctx.deviceId = persistentId(storage, DEVICE_ID_KEY);
  ctx.library = { name: SDK_NAME, version: SDK_VERSION };
  const ua = g.navigator?.userAgent;
  if (typeof ua === 'string' && ua.length > 0) ctx.userAgent = ua.slice(0, 512);
  const page = pageContext();
  if (page !== undefined) ctx.page = page;
  const campaign = campaignContext();
  if (campaign !== undefined) ctx.campaign = campaign;
  return ctx;
}
