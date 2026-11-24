# Book service

A Cloudflare Worker that fetches a Project Gutenberg book once, converts it to
the app's `Book` shape, caches it in KV, and serves the cached copy afterwards.

Routes: `GET /books/:id`, `GET /search?q=...`, `GET /health`.

Still placeholders:
- The upstream fetch and catalogue search (`src/upstream.ts`) throw "upstream
  not configured" until Gutenberg's robot-access rules have been read.
- The KV namespace id in `wrangler.jsonc` must be replaced with a real one.

`src/service.ts` has no Cloudflare imports and is tested by the root `pnpm test`.

To run locally later: `cd worker && pnpm dlx wrangler dev`.
