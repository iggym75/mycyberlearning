-- My Cyber Learning: Cloudflare D1 schema.
-- Apply with:  npx wrangler d1 migrations apply mycyberlearning --remote

-- Catalogue entries. `data` is the item JSON (without id, hidden or vote tallies).
CREATE TABLE IF NOT EXISTS items (
  id         TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  hidden     INTEGER NOT NULL DEFAULT 0,
  up         INTEGER NOT NULL DEFAULT 0,
  down       INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT
);

-- One vote per item per browser. `voter` is a salted SHA-256 of a random browser id.
CREATE TABLE IF NOT EXISTS votes (
  item_id TEXT NOT NULL,
  voter   TEXT NOT NULL,
  dir     INTEGER NOT NULL,
  at      TEXT NOT NULL,
  PRIMARY KEY (item_id, voter)
);

-- Visitor suggestions: pending, approved or rejected. Email and IP hash are cleared on decision or after 90 days.
CREATE TABLE IF NOT EXISTS submissions (
  id                TEXT PRIMARY KEY,
  status            TEXT NOT NULL DEFAULT 'pending',
  data              TEXT NOT NULL,
  suggested_domains TEXT,
  suggested_level   TEXT,
  review            TEXT,
  ip_hash           TEXT,
  submitted         TEXT NOT NULL,
  decided_at        TEXT
);
CREATE INDEX IF NOT EXISTS submissions_status ON submissions (status, submitted);

-- Briefing subscribers. `id` is an HMAC of the email address, never the address itself.
-- status: pending (awaiting confirmation) | active | suppressed (unsubscribed/erased: no personal data kept).
CREATE TABLE IF NOT EXISTS subscribers (
  id              TEXT PRIMARY KEY,
  status          TEXT NOT NULL,
  email           TEXT,
  name            TEXT,
  country         TEXT,
  interests       TEXT,
  token_hash      TEXT,
  token_expires   TEXT,
  consent_version TEXT,
  consent_text    TEXT,
  requested_at    TEXT,
  window_start    TEXT,
  sends           INTEGER NOT NULL DEFAULT 0,
  confirmed_at    TEXT,
  last_sent       TEXT,
  suppressed_at   TEXT,
  reason          TEXT
);
CREATE INDEX IF NOT EXISTS subscribers_status ON subscribers (status);

-- Aggregate visit counters only: no IPs, cookies or identifiers.
CREATE TABLE IF NOT EXISTS stats (
  day TEXT NOT NULL,
  dim TEXT NOT NULL,
  val TEXT NOT NULL,
  n   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, dim, val)
);

-- One row per day's briefing send, so an interrupted send can resume without double-sending.
CREATE TABLE IF NOT EXISTS digestlog (
  date        TEXT PRIMARY KEY,
  status      TEXT NOT NULL,
  sent        INTEGER NOT NULL DEFAULT 0,
  failed      INTEGER NOT NULL DEFAULT 0,
  started_at  TEXT,
  finished_at TEXT
);
