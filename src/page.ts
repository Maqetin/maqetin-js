import { g } from './runtime.js';
import type { CampaignContext, PageContext } from './types.js';

/** The caps of the backend's `PageContextSchema` and `CampaignContextSchema`: a longer value is cut, never refused. */
const CAP = { url: 768, path: 256, referrer: 512, title: 200, campaign: 100 } as const;

/** A URL without its query string and fragment: they hold tokens, reset links and addresses, and are never sent. */
export function withoutQuery(href: string): string {
  return href.split(/[?#]/, 1)[0] ?? '';
}

function pathOf(url: string): string {
  const path = url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '');
  return path === '' ? '/' : path;
}

/** The page the browser is on, or nothing outside a browser. */
export function pageContext(): PageContext | undefined {
  const href = g.location?.href;
  if (typeof href !== 'string' || href === '') return undefined;
  const url = withoutQuery(href);
  const page: PageContext = { url: url.slice(0, CAP.url), path: pathOf(url).slice(0, CAP.path) };
  const referrer = g.document?.referrer;
  if (typeof referrer === 'string' && referrer !== '')
    page.referrer = withoutQuery(referrer).slice(0, CAP.referrer);
  const title = g.document?.title;
  if (typeof title === 'string' && title !== '') page.title = title.slice(0, CAP.title);
  return page;
}

const UTM = {
  utm_source: 'source',
  utm_medium: 'medium',
  utm_campaign: 'name',
  utm_term: 'term',
  utm_content: 'content',
} as const;

function decode(value: string): string | undefined {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    return undefined; // a bad escape: that one value is left out
  }
}

/** The `utm_*` parameters of the URL's query (never of its fragment), or nothing when it has none. */
export function campaignContext(): CampaignContext | undefined {
  const href = g.location?.href;
  if (typeof href !== 'string') return undefined;
  const query = href.split('#', 1)[0]?.split('?')[1];
  if (query === undefined || query === '') return undefined;
  const campaign: CampaignContext = {};
  for (const pair of query.split('&')) {
    const at = pair.indexOf('=');
    const key = at < 0 ? pair : pair.slice(0, at);
    if (!Object.hasOwn(UTM, key)) continue;
    const value = decode(at < 0 ? '' : pair.slice(at + 1));
    if (value === undefined || value === '') continue;
    campaign[UTM[key as keyof typeof UTM]] = value.slice(0, CAP.campaign);
  }
  return Object.keys(campaign).length > 0 ? campaign : undefined;
}
