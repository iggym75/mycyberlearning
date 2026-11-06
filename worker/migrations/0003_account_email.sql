-- Optional name and email on My list accounts, consent to product-update emails, email sign-in links,
-- and the admin's update emails (announcements) with a per-recipient send log.
ALTER TABLE accounts ADD COLUMN name TEXT;                 -- optional first name
ALTER TABLE accounts ADD COLUMN email TEXT;                -- verified address only
ALTER TABLE accounts ADD COLUMN email_id TEXT;             -- HMAC of the verified address (same scheme as subscribers), for lookups
ALTER TABLE accounts ADD COLUMN email_verified_at TEXT;
ALTER TABLE accounts ADD COLUMN email_pending TEXT;        -- address waiting for its confirmation link
ALTER TABLE accounts ADD COLUMN email_token_hash TEXT;     -- SHA-256 of the confirmation token (48 h)
ALTER TABLE accounts ADD COLUMN email_token_expires TEXT;
ALTER TABLE accounts ADD COLUMN login_token_hash TEXT;     -- SHA-256 of an emailed sign-in link token (30 min, single use)
ALTER TABLE accounts ADD COLUMN login_token_expires TEXT;
ALTER TABLE accounts ADD COLUMN mail_window_start TEXT;    -- per-account email throttle
ALTER TABLE accounts ADD COLUMN mail_sends INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN mail_last TEXT;
ALTER TABLE accounts ADD COLUMN briefing_wanted INTEGER NOT NULL DEFAULT 0;  -- start the briefing once the email is confirmed
ALTER TABLE accounts ADD COLUMN updates_opt_in INTEGER NOT NULL DEFAULT 0;   -- consent to occasional new-feature emails
ALTER TABLE accounts ADD COLUMN updates_consent_at TEXT;
ALTER TABLE accounts ADD COLUMN updates_consent_text TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS accounts_email_id ON accounts(email_id);

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
  sent_at         TEXT NOT NULL,
  PRIMARY KEY (announcement_id, account_id)
);
