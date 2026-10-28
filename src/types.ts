/** Same shape as the G2.1 wire schemas (`identify.wire.json`, `track.wire.json`, `batch.wire.json`). */
export type Channel = 'web' | 'node';

/** The page a web event is made on: `url` and `referrer` never hold a query string or a fragment. */
export interface PageContext {
  url?: string;
  path?: string;
  referrer?: string;
  title?: string;
}

/** The UTM parameters of the page's URL. */
export interface CampaignContext {
  source?: string;
  medium?: string;
  name?: string;
  term?: string;
  content?: string;
}

export interface EventContext {
  timezone?: string;
  locale?: string;
  deviceId?: string;
  library?: { name: string; version: string };
  userAgent?: string;
  page?: PageContext;
  campaign?: CampaignContext;
}

interface BaseItem {
  messageId: string;
  anonymousId: string;
  timestamp: string;
  channel: Channel;
  context?: EventContext;
}

export interface IdentifyItem extends BaseItem {
  type: 'identify';
  userId: string;
  traits: Record<string, unknown>;
}

export interface TrackItem extends BaseItem {
  type: 'track';
  /** Absent for a track before identify: the event is then about the `anonymousId` alone. */
  userId?: string;
  event: string;
  properties: Record<string, unknown>;
}

export type QueueItem = IdentifyItem | TrackItem;

/** Everything the SDK drops is reported here: it never drops silently. */
export interface MaqetinError {
  kind: 'rejected' | 'retries_exhausted' | 'queue_full' | 'invalid_call' | 'closed';
  message: string;
  /** HTTP status, when the gateway answered. */
  status?: number;
  /** How many calls were dropped. */
  dropped: number;
}
