import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectContext, detectChannel, memoryStorage, persistentId } from './context.js';
import { SDK_VERSION } from './version.js';

afterEach(() => vi.unstubAllGlobals());

describe('collectContext (Scope §4.2: exactly these fields, no advertising ids)', () => {
  it('collects IANA timezone, locale, install-scoped deviceId, library and (web) userAgent', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 test', language: 'en-NG' });
    const storage = memoryStorage();
    const ctx = collectContext(storage);
    expect(Object.keys(ctx).sort()).toEqual([
      'deviceId',
      'library',
      'locale',
      'timezone',
      'userAgent',
    ]);
    expect(ctx.timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(ctx.timezone).not.toMatch(/^[+-]/);
    expect(ctx.locale).toBe('en-NG');
    expect(ctx.library).toEqual({ name: 'maqetin-js', version: SDK_VERSION });
    expect(ctx.userAgent).toBe('Mozilla/5.0 test');
    expect(collectContext(storage).deviceId).toBe(ctx.deviceId); // stable for the install
  });

  it('Node: no userAgent, locale from Intl', () => {
    vi.stubGlobal('navigator', undefined);
    const ctx = collectContext(memoryStorage());
    expect(ctx.userAgent).toBeUndefined();
    expect(ctx.locale).toBe(Intl.DateTimeFormat().resolvedOptions().locale);
  });

  it('never carries an advertising identifier', () => {
    const keys = Object.keys(collectContext(memoryStorage())).map((k) => k.toLowerCase());
    for (const banned of ['idfa', 'gaid', 'advertisingid', 'adid', 'idfv'])
      expect(keys).not.toContain(banned);
  });
});

describe('persistentId', () => {
  it('generates once and keeps it in storage', () => {
    const s = memoryStorage();
    const a = persistentId(s, 'maqetin.deviceId');
    expect(persistentId(s, 'maqetin.deviceId')).toBe(a);
    expect(a.length).toBeLessThanOrEqual(64);
  });

  it('a storage that throws (private mode) still gives an id for this session', () => {
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => undefined,
    };
    expect(persistentId(broken, 'k')).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('detectChannel', () => {
  it('web in a browser, node otherwise', () => {
    expect(detectChannel()).toBe('node');
    vi.stubGlobal('window', {});
    vi.stubGlobal('document', {});
    expect(detectChannel()).toBe('web');
  });
});
