import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

type Schema = {
  properties: {
    batch: {
      maxItems: number;
      items: { oneOf: { properties: { userId: { maxLength: number } } }[] };
    };
  };
};

const schema = JSON.parse(
  readFileSync(new URL('../conformance/batch.wire.json', import.meta.url), 'utf8'),
) as Schema;

const ajv = new Ajv2020();
addFormats.default(ajv);
const validate = ajv.compile(schema);

/** The gateway's batch limit and id length cap, read from the vendored wire schema. */
export const BATCH_MAX_ITEMS = schema.properties.batch.maxItems;
export const MAX_ID_LENGTH = schema.properties.batch.items.oneOf[0]?.properties.userId.maxLength;

/** The gateway's batch wire schema (`conformance/batch.wire.json`, exported from `libs/events` in maqetin-backend). */
export const BatchWireSchema = {
  safeParse: (body: unknown) => ({ success: validate(body) }),
};
