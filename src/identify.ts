import { MAX_USER_ID_LENGTH, withinUserIdLength } from './limits.js';
import type { IdentifyItem } from './types.js';

export function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** The traits the gateway types: each is a string when given. */
const STRING_TRAITS = ['phone', 'firstName', 'lastName', 'plan', 'country'] as const;
/** An ISO date-time in UTC, as the gateway accepts it (`2026-01-01T00:00:00Z`, seconds and fractions optional). */
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z$/;

/** A `createdAt` the gateway accepts: a valid `Date` (sent as its ISO string) or such a string. */
function isCreatedAt(v: unknown): boolean {
  if (v instanceof Date) return !Number.isNaN(v.getTime());
  return typeof v === 'string' && ISO_UTC.test(v);
}

/**
 * The checks the SDK can make cheaply; the gateway validates the full wire schema. The typed traits are checked here
 * because the gateway refuses a whole batch for one of them.
 */
export function identifyProblem(userId: unknown, traits: unknown): string | undefined {
  if (!isNonEmptyString(userId)) return 'identify needs a non-empty userId';
  if (!withinUserIdLength(userId))
    return `identify userId is longer than ${MAX_USER_ID_LENGTH} characters`;
  if (!isPlainObject(traits)) return 'identify traits must be an object';
  if (
    traits.email !== undefined &&
    (typeof traits.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(traits.email))
  ) {
    return 'identify traits.email is not an email address';
  }
  for (const name of STRING_TRAITS) {
    if (traits[name] !== undefined && typeof traits[name] !== 'string')
      return `identify traits.${name} must be a string`;
  }
  if (traits.createdAt !== undefined && !isCreatedAt(traits.createdAt))
    return 'identify traits.createdAt must be a Date or an ISO date-time in UTC';
  return undefined;
}

export type { IdentifyItem };
