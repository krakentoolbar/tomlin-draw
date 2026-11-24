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
