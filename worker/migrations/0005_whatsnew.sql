-- What's New: new features and improvements, shown on the site (#whats-new) and in the weekly My List email.
-- Written by the admin in Admin → What's New. Public, so nothing personal goes here.
CREATE TABLE IF NOT EXISTS whatsnew (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  day        TEXT NOT NULL,          -- YYYY-MM-DD, shown as the entry's date
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  link       TEXT,                   -- optional "Try it" link on our own site: #view or /path
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS whatsnew_day ON whatsnew (day DESC, id DESC);

INSERT INTO whatsnew (day, title, body, link, created_at, updated_at) VALUES
 ('2026-11-16', 'Report a problem on any card', 'Spotted a dead link or out-of-date details? Tap the red flag on any card and we''ll fix it.', '#library', '2026-11-27T15:00:00Z', '2026-11-27T15:00:00Z'),
 ('2026-11-16', 'Sort podcasts by latest episode', 'See which shows have just published, newest first.', '#podcasts', '2026-11-27T15:00:00Z', '2026-11-27T15:00:00Z'),
 ('2026-11-17', 'Easier book suggestions', 'Paste an ISBN in any format and we fill in the title, author and publisher for you.', '#books', '2026-11-27T15:00:00Z', '2026-11-27T15:00:00Z'),
 ('2026-11-18', 'A 2-minute site tour', 'A short narrated video showing how to find, filter, save and stay up to date. Share it with mycyberlearning.co.uk/video/.', '#tour', '2026-11-27T15:00:00Z', '2026-11-27T15:00:00Z'),
 ('2026-11-18', 'Your learning map', 'My List now shows what you''ve saved by type, the security topics you cover, and MCL Picks to fill the gaps.', '#mylist', '2026-11-27T15:00:00Z', '2026-11-27T15:00:00Z'),
 ('2026-11-25', 'Daily Briefing links that open on our site', 'Every link in the briefing email now opens that day''s briefing on My Cyber Learning, so it''s more likely to reach work inboxes.', '#news', '2026-11-27T15:00:00Z', '2026-11-27T15:00:00Z');
