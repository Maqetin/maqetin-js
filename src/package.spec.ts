import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  engines?: { node?: string };
};

describe('the published package', () => {
  // Node loads an ES module with require() from 22.12 on; that is how a CommonJS project uses the SDK, and fetch is there.
  it('names the Node versions it runs on', () => {
    expect(pkg.engines?.node).toBe('>=22.12.0');
  });

  // The built package, as a CommonJS project sees it (this reads dist/, so it runs after the build).
  it('can be required from CommonJS, both entries, at one version', () => {
    const out = execFileSync(
      process.execPath,
      [
        '-e',
        `const a = require('@maqetin/sdk-js'); const b = require('@maqetin/sdk-js/server');
         process.stdout.write([typeof a.MaqetinClient, typeof b.MaqetinServer, a.SDK_VERSION === b.SDK_VERSION].join());`,
      ],
      { cwd: root, encoding: 'utf8' },
    );
    expect(out).toBe('function,function,true');
  });
});
