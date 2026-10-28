import { isNonEmptyString, isPlainObject } from './identify.js';
import { MAX_USER_ID_LENGTH, withinUserIdLength } from './limits.js';
import type { TrackItem } from './types.js';

/**
 * The checks the SDK can make cheaply. `userId` is the user the call names, or `undefined` for a track about the
 * anonymous visitor; a userId that is given must be a non-empty string, so a cleared form field is reported and not
 * sent on as an anonymous event.
 */
export function trackProblem(
  event: unknown,
  properties: unknown,
  userId: unknown,
): string | undefined {
  if (!isNonEmptyString(event)) return 'track needs a non-empty event name';
  if (!isPlainObject(properties)) return 'track properties must be an object';
  if (userId !== undefined && !isNonEmptyString(userId))
    return 'track userId must be a non-empty string when given';
  if (userId !== undefined && !withinUserIdLength(userId as string))
    return `track userId is longer than ${MAX_USER_ID_LENGTH} characters`;
  return undefined;
}

export type { TrackItem };
