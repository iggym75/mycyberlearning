-- Weekly My List update (Mondays 08:00 UK): a separate, unticked opt-in for account holders with a confirmed email.
ALTER TABLE accounts ADD COLUMN weekly_wanted INTEGER NOT NULL DEFAULT 0;   -- asked for it before confirming the address; the owner confirms
ALTER TABLE accounts ADD COLUMN weekly_opt_in INTEGER NOT NULL DEFAULT 0;   -- consent given by the confirmed address owner
ALTER TABLE accounts ADD COLUMN weekly_consent_at TEXT;
ALTER TABLE accounts ADD COLUMN weekly_consent_text TEXT;
ALTER TABLE accounts ADD COLUMN weekly_last_sent TEXT;                      -- London date of the last weekly email, so a re-run never sends twice

INSERT INTO whatsnew (day, title, body, link, created_at, updated_at) VALUES
 ('2026-11-27', 'This week in My List', 'A weekly round-up at the top of My List: new episodes from your podcasts, this week''s briefing stories in your topics, and a podcast to fill a gap. Tick "Weekly My List update" under Manage account to get it by email on Monday mornings.', '#mylist', '2026-11-27T18:00:00Z', '2026-11-27T18:00:00Z'),
 ('2026-11-27', 'What''s New', 'This page: new features and improvements, newest first. A dot on the menu tells you when there''s something new.', '#whats-new', '2026-11-27T18:00:00Z', '2026-11-27T18:00:00Z');
