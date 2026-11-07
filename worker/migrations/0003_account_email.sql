-- Optional name and email on My list accounts, consent to product-update emails, email sign-in links,
-- and the admin's update emails (announcements) with a per-recipient send log.
ALTER TABLE accounts ADD COLUMN name TEXT;                 -- optional first name
ALTER TABLE accounts ADD COLUMN email TEXT;                -- verified address only
ALTER TABLE accounts ADD COLUMN email_id TEXT;             -- HMAC of the verified address (same scheme as subscribers), for lookups
ALTER TABLE accounts ADD COLUMN email_verified_at TEXT;
ALTER TABLE accounts ADD COLUMN email_pending TEXT;        -- address waiting for its confirmation link
ALTER TABLE accounts ADD COLUMN email_token_hash TEXT;     -- SHA-256 of the confirmation token (48 h)
ALTER TABLE accounts ADD COLUMN email_token_expires TEXT;
ALTER TABLE accounts ADD COLUMN mail_window_start TEXT;    -- per-account throttle for confirmation emails
ALTER TABLE accounts ADD COLUMN mail_sends INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN mail_last TEXT;
ALTER TABLE accounts ADD COLUMN login_window_start TEXT;   -- separate per-account throttle for sign-in links
ALTER TABLE accounts ADD COLUMN login_sends INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN login_last TEXT;
ALTER TABLE accounts ADD COLUMN briefing_wanted INTEGER NOT NULL DEFAULT 0;  -- account holder asked for it; the address owner confirms it on the confirm page
ALTER TABLE accounts ADD COLUMN updates_wanted INTEGER NOT NULL DEFAULT 0;   -- same, for new-feature emails
ALTER TABLE accounts ADD COLUMN updates_opt_in INTEGER NOT NULL DEFAULT 0;   -- consent to occasional new-feature emails, given by the confirmed address owner
ALTER TABLE accounts ADD COLUMN updates_consent_at TEXT;
ALTER TABLE accounts ADD COLUMN updates_consent_text TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS accounts_email_id ON accounts(email_id);

-- Emailed sign-in links (30 minutes, single use). Several can be live at once, so a new request never cancels
-- a link the person is about to use.
CREATE TABLE IF NOT EXISTS login_links (
  token_hash  TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL,
  expires     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS login_links_account ON login_links(account_id);

CREATE TABLE IF NOT EXISTS announcements (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  subject     TEXT NOT NULL,
  body        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'draft',  -- draft | queued | done
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  queued_at   TEXT,
  finished_at TEXT,
  sent        INTEGER NOT NULL DEFAULT 0,
  failed      INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS announce_log (
  announcement_id INTEGER NOT NULL,
  account_id      TEXT NOT NULL,
  status          TEXT NOT NULL,             -- sending | sent | failed
  attempts        INTEGER NOT NULL DEFAULT 1,
  sent_at         TEXT NOT NULL,
  PRIMARY KEY (announcement_id, account_id)
);
