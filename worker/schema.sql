CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  year INTEGER NOT NULL,
  exchange_date TEXT NOT NULL,
  budget TEXT,
  admin_token TEXT NOT NULL UNIQUE,
  reveal_all_at TEXT,
  rules TEXT,                       -- JSON {couples, no_repeat}, reused by redraw
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id),
  name TEXT NOT NULL,
  phone TEXT,
  token TEXT NOT NULL UNIQUE,
  sort INTEGER NOT NULL,
  confirmed_at TEXT,
  link_opened_at TEXT,
  revealed_at TEXT,
  bought_wish_id TEXT,              -- the list item this Santa marked "I bought it" (wishes.id)
  bought_note TEXT                  -- or free text when they got something not on the list
);
CREATE TABLE IF NOT EXISTS assignments (
  group_id TEXT NOT NULL,
  giver_id TEXT NOT NULL,
  receiver_id TEXT NOT NULL,
  PRIMARY KEY (group_id, giver_id)
);
CREATE TABLE IF NOT EXISTS history (
  year INTEGER NOT NULL,
  giver TEXT NOT NULL,
  receiver TEXT NOT NULL,
  PRIMARY KEY (year, giver)
);
CREATE TABLE IF NOT EXISTS wishes (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id),
  text TEXT NOT NULL,
  url TEXT,
  created_at TEXT NOT NULL,
  deleted_at TEXT,
  added_by TEXT,                    -- members.id of someone else who added it (Santa note / extra gift); NULL = the owner's own wish
  bought_by TEXT,                   -- members.id
  bought_at TEXT,
  bought_kind TEXT CHECK (bought_kind IN ('santa','extra')),
  preview_title TEXT,
  preview_image TEXT,
  preview_site TEXT,
  preview_status TEXT,              -- 'pending' | 'ok' | 'failed' | NULL when no url
  preview_tried INTEGER NOT NULL DEFAULT 0  -- fetch attempts so far (Worker + Banjo)
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('question','answer')),
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_at TEXT
);
CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  due_at TEXT NOT NULL,
  due_date TEXT,                    -- "YYYY-MM-DD" for scheduled kinds (reminder, wish_nudge); NULL for event texts
  sent_at TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS outbox_once ON outbox (member_id, kind, due_date);
