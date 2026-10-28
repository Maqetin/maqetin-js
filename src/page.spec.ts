import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectContext, memoryStorage } from './context.js';
import { campaignContext, pageContext } from './page.js';

afterEach(() => vi.unstubAllGlobals());

function onPage(href: string, over: { title?: string; referrer?: string } = {}) {
  vi.stubGlobal('window', {});
  vi.stubGlobal('location', { href });
  vi.stubGlobal('document', { title: over.title ?? 'Pricing', referrer: over.referrer ?? '' });
}

describe('pageContext: the page a web event is made on', () => {
  it('holds the url without its query or fragment, the path, the referrer and the title', () => {
    onPage('https://brand.example/reset?token=s3cret&email=a%40b.example#step-2', {
      title: 'Reset your password',
      referrer: 'https://mail.example/inbox?id=42#x',
    });
    expect(pageContext()).toEqual({
      url: 'https://brand.example/reset',
      path: '/reset',
      referrer: 'https://mail.example/inbox',
      title: 'Reset your password',
    });
  });

  it('leaves out an empty referrer and an empty title', () => {
    onPage('https://brand.example/', { title: '', referrer: '' });
    expect(pageContext()).toEqual({ url: 'https://brand.example/', path: '/' });
  });

  it('cuts each field to its cap', () => {
    onPage(`https://brand.example/${'p'.repeat(1_000)}`, {
      title: 't'.repeat(500),
      referrer: `https://r.example/${'r'.repeat(1_000)}`,
    });
    const page = pageContext();
    expect(page?.url).toHaveLength(768);
    expect(page?.path).toHaveLength(256);
    expect(page?.referrer).toHaveLength(512);
    expect(page?.title).toHaveLength(200);
  });

  it('is nothing outside a browser', () => {
    vi.stubGlobal('location', undefined);
    expect(pageContext()).toBeUndefined();
  });
});

describe('campaignContext: the UTM parameters of the URL', () => {
  it('reads the five utm_ parameters, decoded', () => {
    onPage(
      'https://brand.example/?utm_source=google&utm_medium=cpc&utm_campaign=spring%20sale&utm_term=crm&utm_content=ad_1&x=1',
    );
    expect(campaignContext()).toEqual({
      source: 'google',
      medium: 'cpc',
      name: 'spring sale',
      term: 'crm',
      content: 'ad_1',
    });
  });

  it('is nothing when the URL has no utm_ parameter, or only empty ones', () => {
    onPage('https://brand.example/pricing?plan=pro');
    expect(campaignContext()).toBeUndefined();
    onPage('https://brand.example/pricing?utm_source=');
    expect(campaignContext()).toBeUndefined();
  });

  it('never reads utm_ parameters from the fragment, and survives a bad escape', () => {
    onPage('https://brand.example/#utm_source=google');
    expect(campaignContext()).toBeUndefined();
    onPage('https://brand.example/?utm_source=%E0%A4%A&utm_medium=email');
    expect(campaignContext()).toEqual({ medium: 'email' });
  });

  it('cuts each value to 100 characters', () => {
    onPage(`https://brand.example/?utm_source=${'s'.repeat(300)}`);
    expect(campaignContext()?.source).toHaveLength(100);
  });
});

describe('collectContext on a web page', () => {
  it('adds the page to every event, and the campaign when the URL has one', () => {
    onPage('https://brand.example/landing?utm_source=newsletter');
    const ctx = collectContext(memoryStorage());
    expect(ctx.page).toEqual({
      url: 'https://brand.example/landing',
      path: '/landing',
      title: 'Pricing',
    });
    expect(ctx.campaign).toEqual({ source: 'newsletter' });
  });
});
