/**
 * The most characters a `userId` may have. The same number as `MAX_ID_LENGTH` in `@maqetin/events`, written here
 * because the SDK has no runtime dependency on it; `client.spec.ts` fails if the two differ. The gateway answers 400
 * for a whole batch that holds one longer id, so the SDK refuses such a call itself and keeps the rest of the batch.
 */
export const MAX_USER_ID_LENGTH = 256;

/** True when `value` has at most `MAX_USER_ID_LENGTH` characters, counted by code point like the gateway does. */
export function withinUserIdLength(value: string): boolean {
  if (value.length <= MAX_USER_ID_LENGTH) return true;
  let count = 0;
  for (const _char of value) {
    count += 1;
    if (count > MAX_USER_ID_LENGTH) return false;
  }
  return true;
}

/**
 * The most bytes one call may take as JSON. The SDK's own rule, at the gateway's limit for a single event
 * (`SingleBodyLimit`, 32 KiB, `maqetin-ingestion/internal/handler/ingest.go`): an event that could not be sent alone is
 * refused, so it never makes a whole batch fail.
 */
export const MAX_CALL_BYTES = 32 * 1024;

/**
 * The most bytes the calls of one batch may take together. The gateway refuses a batch body over `BatchBodyLimit`
 * (512 KiB, the same file) with 413 for the whole batch; this leaves room for the envelope and the commas.
 */
export const MAX_BATCH_BYTES = 480_000;
