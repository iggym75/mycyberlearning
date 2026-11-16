-- Quick reports from visitors: a broken or wrong link, or out-of-date details, on one catalogue item.
-- Nothing that identifies the reporter is stored (no IP, account or email); repeat reports of the same
-- problem add to `count` instead of making new rows. Closed reports are deleted after 90 days (scripts/cleanup.mjs).
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL,
  reason TEXT NOT NULL,          -- dead | wrong | details | other
  link TEXT,                     -- which link: web, apple, spotify, … (catalogue field name), or NULL
  note TEXT,                     -- optional, up to 500 characters
  count INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'open',   -- open | fixed | dismissed
  created TEXT NOT NULL,
  updated TEXT NOT NULL,
  closed_at TEXT
);
CREATE INDEX IF NOT EXISTS reports_open ON reports (status, item_id);
