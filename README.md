# @maqetin/sdk-js

One package, two entries:

| Entry | Runs in | Key | Does |
|---|---|---|---|
| `@maqetin/sdk-js` | Browser, Node | Public key (`mq_live_…`) | `identify`, `track` (data in) |
| `@maqetin/sdk-js/server` | Node only | Secret key (`mq_sec_…`) | `messages.send` (transactional messages out) |

Both entries are the same version. A web bundle that imports the main entry never contains the server entry.

## Install

```sh
npm install @maqetin/sdk-js
```

Node 22.12 or later (`engines`). Both entries are ES modules. A CommonJS project loads them with `require()`; Node supports that from 22.12.

## Browser (or Node): data in

```ts
import { MaqetinClient } from '@maqetin/sdk-js';

const mq = new MaqetinClient({ publicKey: 'mq_live_…' });
mq.identify('u_42', { email: 'ada@example.com', firstName: 'Ada' });
mq.track('checkout.completed', { total: 12.5 });
```

> **Required: call `reset()` when a user logs out.**
>
> ```ts
> async function logout() {
>   await signOut();
>   mq.reset();
> }
> ```
>
> The SDK keeps the identified user in the browser's storage, so the user stays identified after a page load. It also keeps the anonymous id that the user's earlier visits are linked to. `reset()` forgets the user and starts a new anonymous id. If your site does not call it, the next person who uses the same browser is tracked as the previous user: their events go on the previous user's profile, and can start journeys that email the previous user.

The client refuses a secret key. Calls are batched to `https://in.maqetin.com/v1/batch` and retried on 5xx, 429 and network errors. Set `endpoint` to use another host, or to send through your own domain ([Send from your own domain](#send-from-your-own-domain)).

- **The identified user is kept.** `identify` stores the user id with the anonymous id, so the user stays identified after a page load. `reset()` (logout) forgets the user and starts a new anonymous id; see the box above.
- **A request that does not answer is given up** after `requestTimeoutMs` (default 10 s) and sent again with the same message ids, so an event is stored once.
- **One bad call never costs its batch.** A call is refused alone, and reported to `onError`, when it holds a value JSON cannot hold (a cycle, a `BigInt`), when it is over 32 KiB as JSON, when a typed trait has the wrong type (`phone`, `firstName`, `lastName`, `plan`, `country` are strings; `createdAt` is a `Date` or an ISO date-time in UTC), or when `timestamp` is not a valid `Date`. Batches stay under 100 calls and about 480 KB.
- **A call is fixed when you make it.** Changing the `properties` object after `track` does not change the event.
- **Queued calls are sent when the page closes or goes to the background** (`pagehide` and `visibilitychange`).

### Page views

The client sends a page view (`page.viewed`) when it starts and when a single-page app moves to a new path (`pushState`, `replaceState`, back and forward). A change of the query string or the fragment alone is not a new page. Set `autoPageViews: false` to send them yourself:

```ts
mq.page();                        // the current page
mq.page({ section: 'pricing' });  // with your own properties
```

The page (`path`, `url`, `title`, `referrer`) is in the event's properties, so a journey can start on a path. Your properties never replace those four.

Two things to know: the first view is sent when the client starts, so if you load the SDK in `<head>` its `title` can be empty; and `referrer` is the page the visitor came from when the site loaded, not the previous route of a single-page app (the browser does not change it).

### What the SDK collects

Tell your users about these fields in your privacy notice. Set `disableAutoCollection: true` to leave them out of `context`. Two still go out: `anonymousId`, which every call carries, and the page, which page views carry in their properties until you set `autoPageViews: false`.

| Field | What it holds |
|---|---|
| `timezone`, `locale` | The browser's IANA time zone and language |
| `deviceId`, `anonymousId` | Random ids the SDK makes and keeps in the browser's storage. Never an advertising id |
| `userAgent` | The browser's user-agent string |
| `page.url`, `page.path`, `page.referrer` | The address of the page and of the page before it, **without the query string or the fragment** (they can hold tokens, reset links and email addresses) |
| `page.title` | The page title as your page sets it. If your titles hold a name, so does this field |
| `campaign` | The `utm_source`, `utm_medium`, `utm_campaign`, `utm_term` and `utm_content` of the address, only when it has them |

### What the SDK reads and writes on the device

Every read and write the client makes on the visitor's device, with the version that started it. None of them asks the browser for a permission. The server entry runs in Node and touches no visitor's device. Each release's README holds the table for that version.

| Since | What | Read or write | When | Why | How to stop it |
|---|---|---|---|---|---|
| 0.1.0 | `localStorage` key `maqetin.anonymousId` | Read and write | When the client starts; written again by `reset()` | Links a visitor's events before and after they sign in | `storage: memoryStorage()`: the id lasts until the page closes |
| 0.1.0 | `localStorage` key `maqetin.userId` | Read, write and remove | Read when the client starts, written by `identify`, removed by `reset()` | Keeps the visitor identified after a page load | `storage: memoryStorage()`: the visitor is identified on that page only |
| 0.1.0 | `localStorage` key `maqetin.deviceId` | Read and write | Read when the client starts, to learn whether the page may use storage; then read with each call, and written the first time | `context.deviceId`: tells one browser of a person from another | `disableAutoCollection: true` stops it with each call; `storage: memoryStorage()` stops the read at start as well |
| 0.1.0 | Time zone (`Intl.DateTimeFormat().resolvedOptions().timeZone`) | Read | With each call | `context.timezone`, kept on the person's profile | `disableAutoCollection: true` |
| 0.1.0 | Language (`navigator.language`) | Read | With each call | `context.locale`, kept on the person's profile | `disableAutoCollection: true` |
| 0.1.0 | User agent (`navigator.userAgent`) | Read | With each call | `context.userAgent` | `disableAutoCollection: true` |
| 0.1.0 | Page address (`location.href`) | Read | With each call, and with each page view | `context.page`, `context.campaign` and the page view's properties. The query string and the fragment are dropped; only the `utm_*` values are taken from the query | `disableAutoCollection: true`, `autoPageViews: false`, and no `page()` call |
| 0.1.0 | Page address (`location.href`) | Read | When the client starts, only if `endpoint` is a path | Makes the full address of your endpoint; nothing is sent | Give `endpoint` as a full `https://` address |
| 0.1.0 | Referring page (`document.referrer`) | Read | With each call, and with each page view | `context.page.referrer` and the page view's `referrer`, without the query string or the fragment | `disableAutoCollection: true`, `autoPageViews: false`, and no `page()` call |
| 0.1.0 | Page title (`document.title`) | Read | With each call, and with each page view | `context.page.title` and the page view's `title` | `disableAutoCollection: true`, `autoPageViews: false`, and no `page()` call |

If the browser refuses storage, the three ids last until the page closes. The client also listens for `pagehide`, `visibilitychange` and `popstate`, and wraps `history.pushState` and `history.replaceState`, to send queued calls before the page closes and to see a new path. These read only whether the page is hidden. The SDK sets no cookie.

### Send from your own domain

Ad blockers and tracker lists block known analytics hosts. If a list names `in.maqetin.com`, a visitor who uses that blocker sends nothing: no events reach the profile and no journey starts for that visitor. Server-side calls are not affected. To avoid this on a web page, send through a path on your own site and let your server forward it to Maqetin.

1. Choose a path your site does not use. This page uses `/relay`.
2. Forward `POST /relay/v1/batch` to `https://in.maqetin.com/v1/batch` (recipes below).
3. Give the path as `endpoint`:

```ts
const mq = new MaqetinClient({ publicKey: 'mq_live_…', endpoint: '/relay' });
```

The SDK adds `/v1/batch` to `endpoint`, so you cannot change that part of the request path. A full address on the page's own origin (`https://brand.example/relay` for a page on `https://brand.example`) works the same way. A path works on a web page only. In Node, give the full address. The page sends to its own origin, so the browser makes no cross-origin request and no CORS preflight.

**The proxy must:**

- Forward `POST <path>/v1/batch` as `POST /v1/batch` on `in.maqetin.com`. The gateway matches `/v1/batch` exactly: lower case, no trailing slash.
- Send `Host: in.maqetin.com`, and the TLS name `in.maqetin.com` when it connects over HTTPS.
- Keep the `Authorization` and `Content-Type` headers and the body unchanged. The key is in the header. Do not log the body: it holds your visitors' data.
- Return the status, the `Retry-After` header and the body of the gateway's answer unchanged. The SDK retries on 5xx, 429 and network errors, and waits for `Retry-After`. If the proxy answers 200 for a batch that Maqetin did not accept, the SDK takes the events as sent and reports nothing. If it turns a 429 into another 4xx, the SDK drops the events and reports them to `onError`.
- Accept a request body of 512 KiB or more. The SDK keeps a batch under about 480 KB, and the gateway refuses more than 512 KiB.

**The proxy must not:**

- Cache the answer.
- Retry on its own. The SDK already retries with backoff and with the same message ids. A second layer of retries multiplies the load while Maqetin is slow, and it hides the 429 from the SDK.

**The proxy does not need to** add the visitor's IP address (`X-Forwarded-For` and similar). The gateway does not read it, and it limits requests per key.

**Choose the path with care.** Blocker lists also match paths. Do not put `track`, `analytics`, `collect` or `pixel` in the path, and do not name it after an analytics product, Maqetin included. Use a short word that says nothing about what the path does.

#### Next.js

```js
// next.config.js
module.exports = {
  async rewrites() {
    return [{ source: '/relay/:path*', destination: 'https://in.maqetin.com/:path*' }];
  },
};
```

Next.js documents a rewrite to an external URL as a URL proxy. Its documentation does not list which request headers it forwards, so check that `Authorization` arrives (see "Check it works"). If you set `trailingSlash: true`, check that the forwarded path is `/v1/batch` without a trailing slash.

#### Cloudflare Worker

Add a route for `brand.example/relay/*` to this Worker:

```js
const GATEWAY = 'https://in.maqetin.com';
const PREFIX = '/relay';

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(`${PREFIX}/`)) return new Response('Not found', { status: 404 });
    return fetch(new Request(GATEWAY + url.pathname.slice(PREFIX.length) + url.search, request));
  },
};
```

The Worker sends the method, the headers and the body on to the gateway and returns the gateway's response as it is, with its status and `Retry-After`.

#### nginx

```nginx
location /relay/ {
    proxy_pass https://in.maqetin.com/;
    proxy_ssl_server_name on;
    proxy_set_header Host in.maqetin.com;
    proxy_cache off;
    client_max_body_size 1m;
}
```

- `proxy_pass` with the URI `/` replaces the matched prefix `/relay/`, so `/relay/v1/batch` becomes `/v1/batch`.
- `proxy_ssl_server_name` is off by default, and then nginx does not send the server name when it connects. Without the name the TLS handshake can fail.
- Set `Host` here, so a `proxy_set_header Host $host` in a parent block does not apply.
- Leave `proxy_next_upstream` at its default. The option `non_idempotent` makes nginx retry `POST` requests.

#### Check it works

Open your site and cause one event. In the browser's network tab, find the `POST` to `/relay/v1/batch`. The request must go to your own domain, and the status must be `202`. A `401` means the gateway saw no active key: check that the proxy forwards `Authorization`, and that the key is active. A `404` means the path did not become `/v1/batch`. A `202` means Maqetin accepted the batch.

## Server: messages out

```ts
import { MaqetinServer } from '@maqetin/sdk-js/server';

const mq = new MaqetinServer({ secretKey: process.env.MAQETIN_SECRET_KEY });
const { messageId } = await mq.messages.send({
  channel: 'email',
  templateId: 'tpl_receipt',
  to: { userId: 'u_42' }, // or { email: 'guest@example.com' }
  from: 'Zara <receipts@mail.zara.com>',
  data: { order: { id: 'o_42', total: 12.5 } },
  idempotencyKey: 'order-42:receipt',
});
```

- The secret key needs the `messages:send` scope (chosen when the key is made; a key without it gets `403`). Sends are limited to 300 a minute per key.
- The client refuses a public key and refuses to run in a web page.
- Messages go to `https://api.maqetin.com/v1/public/messages`. Set `endpoint` to use another host.
- `from` must be on a verified sending domain of the workspace.
- A retry after a 5xx, a 429 or a network error carries the same `Idempotency-Key`, so a retry never sends a second message. If you give no key, the SDK makes one.
- A request that does not answer is given up after `requestTimeoutMs` (default 15 s) and retried under the same key.
- A 4xx is thrown at once as `MaqetinRequestError` with `status`, `code` and `message`.

A message sent this way is transactional. It reaches a contact who unsubscribed from marketing, it never reaches a suppressed address, and it has no unsubscribe link.
