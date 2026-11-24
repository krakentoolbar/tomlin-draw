-- 001: "I bought it" picks, extra gifts, family view, link previews. Apply once to the live DB:
--   wrangler d1 execute tomlin-draw --remote --file migrations/001-bought-family-previews.sql
-- (schema.sql already has these columns for fresh installs; ALTER fails if a column exists, so don't re-run.)
ALTER TABLE wishes ADD COLUMN added_by TEXT;
ALTER TABLE wishes ADD COLUMN bought_by TEXT;
ALTER TABLE wishes ADD COLUMN bought_at TEXT;
ALTER TABLE wishes ADD COLUMN bought_kind TEXT CHECK (bought_kind IN ('santa','extra'));
ALTER TABLE wishes ADD COLUMN preview_title TEXT;
ALTER TABLE wishes ADD COLUMN preview_image TEXT;
ALTER TABLE wishes ADD COLUMN preview_site TEXT;
ALTER TABLE wishes ADD COLUMN preview_status TEXT;
ALTER TABLE wishes ADD COLUMN preview_tried INTEGER NOT NULL DEFAULT 0;
ALTER TABLE members ADD COLUMN bought_wish_id TEXT;
ALTER TABLE members ADD COLUMN bought_note TEXT;
-- Existing links skip the Worker's first try and go straight to Banjo's /banjo/previews queue.
UPDATE wishes SET preview_status = 'pending', preview_tried = 1 WHERE url IS NOT NULL AND preview_status IS NULL;
