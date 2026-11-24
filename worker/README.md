# tomlin-draw Worker

Cloudflare Worker + D1 backend for Tomlin Draw v2 (see ../SPEC.md). One file: `src/index.js`, no deps.

Deploy (from `worker/`):

    wrangler d1 create tomlin-draw            # paste database_id into wrangler.toml
    wrangler d1 execute tomlin-draw --remote --file schema.sql
    wrangler d1 execute tomlin-draw --remote --file seed.sql
    wrangler secret put BANJO_KEY
    wrangler deploy                            # then: curl https://tomlin-draw.<account>.workers.dev/health

Env: `DB` (D1 binding), `PAGES_ORIGIN` (var in wrangler.toml, the only allowed CORS origin besides localhost), `BANJO_KEY` (secret, sent by Banjo as `X-Banjo-Key`).

Tests: `node worker/test.mjs` (Node 20+; the API flow test uses built-in `node:sqlite`, Node 22.5+).

Migrations (the live DB was created from an older schema.sql; fresh installs already have these columns). Apply each once, in order:

    wrangler d1 execute tomlin-draw --remote --file migrations/001-bought-family-previews.sql   # "I bought it" picks, extra gifts, /family, link previews

D1 has no `ADD COLUMN IF NOT EXISTS`, so a second run fails on the first ALTER and changes nothing. 001 also queues every existing link for Banjo's preview pass (`preview_tried = 1`).

Link previews: on `PUT /me/wishes` (and `POST /wish/extra` with a url) the Worker tries up to 3 new links in `ctx.waitUntil`. Whatever it can't read (Amazon often blocks datacenter IPs) shows up in `GET /banjo/previews` for Banjo to fetch from the Mac Mini and post back to `POST /banjo/previews`. A link gets 4 tries total (1 Worker + 3 Banjo), then `preview_status = 'failed'`.
