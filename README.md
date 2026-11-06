# My Cyber Learning

**mycyberlearning.co.uk**: a curated, filterable library of cybersecurity podcasts and books for people starting out in security and practitioners keeping their skills current.

- Filter by one or more security domains (match any / match all), release frequency, level, book publisher, and MCL Picks
- Official ratings (aggregated from Apple Podcasts, Spotify, Podchaser and Podcast Addict) shown separately from community thumbs up/down
- Links to Apple Podcasts, Spotify, YouTube, Amazon Music (where added by hand) and the official site; logos, cadence and launch date for every show
- Visitors suggest podcasts and books; Claude pre-tags and sanity-checks each suggestion; an admin approves, edits, hides or deletes anything
- A weekly automated job keeps logos, links, cadence, launch dates, ratings and tags current
- **Daily briefing**: every morning at 08:30 UK time, the news podcasts' new episodes since the previous briefing are summarised on the site (`#news`, 30-day archive) and emailed to confirmed subscribers
- The five core news shows (`data/briefing.json`) are transcribed with an open-source speech model in the GitHub job, so the summaries reflect what was actually said, not just the show notes
- **My list**: anyone can save podcasts, books, platforms and experts with the heart button; a free account with a passkey (no password, no email) keeps the list on every device, with "New episode" badges for saved podcasts
- Privacy-first: double opt-in, one-click unsubscribe, no tracking pixels, cookieless aggregate analytics that honour Global Privacy Control / Do Not Track. See [SECURITY.md](SECURITY.md)

---

## Architecture

Everything runs on free plans with **no payment card on file**, so neither a leaked key nor a taken-over account can run up a bill: over-limit requests fail instead of being charged.

```
 GitHub (public repo, Actions)                         Cloudflare (Workers Free plan, no card)
 ┌────────────────────────────────────────┐            ┌──────────────────────────────────────────┐
 │ push to main → test → wrangler deploy  │──────────► │ Worker "mycyberlearning"                  │
 │ Mon 05:17  refresh.mjs (catalogue)     │            │  • static site (frontend/dist, _headers)  │
 │ 08:30 UK   news.mjs → send-digest.mjs  │──D1 API──► │  • /api/*  votes, suggestions, sign-ups   │
 │ daily      cleanup.mjs (retention)     │            │  • /auth/* GitHub sign-in for the admin   │
 └────────────────────────────────────────┘            │ D1 database (EU jurisdiction)             │
          │ Claude API (tagging, summaries)            └──────────────────┬───────────────────────┘
          │ Resend API (briefing emails)  ◄───────── confirmation emails ─┘
```

| Endpoint | Who | Purpose |
|---|---|---|
| `GET /api/items` | public | Catalogue + community tallies (60 s edge cache) |
| `POST /api/vote` | public | One vote per item per browser; salted-hash voter id; rate-limited |
| `POST /api/submissions` | public | Validated suggestion → review queue (Claude pre-tags and flags spam) |
| `POST /api/subscribe`, `/api/subscribe/confirm`, `/api/unsubscribe` | public | Double opt-in briefing sign-up; one-click unsubscribe |
| `POST /api/t` | public | Cookieless aggregate page counters |
| `GET /admin`, `/auth/callback`, `/auth/logout` | admin | GitHub sign-in; only ids in `ADMIN_GITHUB_IDS` |
| `/api/account/*` | visitor | Passkey sign-up/sign-in, recovery code, My list (save, remove, merge, seen), export, delete |
| `GET /api/admin/submissions`, `POST /api/admin/submissions/{id}` | admin | Review queue, approve / reject |
| `PATCH` / `DELETE /api/admin/items/{id}` | admin | Edit, hide, retag (locks tags), delete |
| `GET /api/admin/insights`, `/api/admin/subscribers/export`, `POST /api/admin/subscribers/erase` | admin | Aggregate stats, CSV export, erasure requests |

### Code layout
- `worker/src/` — the Worker: `index.js` (router), `public.js`, `news.js`, `admin.js`, `auth.js`; shared code in `worker/src/lib/` (`db.js`, `mail.js`, `shared.js`).
- `worker/migrations/` — D1 schema. `wrangler.jsonc` — Worker, assets and D1 configuration.
- `frontend/` — the single-page UI (`index.template.html`), `_headers` (security headers), covers, briefings.
- `scripts/` — build, seed/export, weekly refresh, daily briefing, email send, retention; `scripts/d1.mjs` talks to D1 over HTTPS (or a local SQLite file for tests).

### Cost and limits
£0 a month plus the domain (≈ £5–10 a year). Free-plan limits that matter: Workers 100,000 requests/day and 10 ms CPU per request; D1 5 million rows read and 100,000 rows written per day (enforced: queries fail until midnight UTC rather than bill); Resend free 100 emails/day and 3,000/month (switch `MAIL_PROVIDER` to `brevo` for 300/day). Claude usage is paid separately: use prepaid credits with auto-reload off for a hard cap.

### Automation
| Job | Where | Notes |
|---|---|---|
| Deploy on push | GitHub Actions `deploy.yml` | Tests, builds, applies D1 migrations, `wrangler deploy`. Pull requests are tested, never deployed. |
| Weekly catalogue refresh | `refresh.yml` (Mon 05:17 UTC) | Apple directory, RSS, Podnews, Open Library, Claude tags; commits `data/catalogue.json` and new artwork, then deploys. |
| Daily briefing | `news.yml` (08:30 UK, started by the Worker cron) | Builds `frontend/news/<date>.json`, deploys, emails subscribers, applies retention. |
| Code and content changes | Claude Code in this repo | Reads `CLAUDE.md`; proposes changes as PRs. |

## Setup
Follow the deployment runbook (Cloudflare edition). In short:

1. **Accounts**: Cloudflare (free, no card), GitHub (public repo), Resend (free), Anthropic (prepaid credits). Two-factor on all of them.
2. **Database**: `npx wrangler login`, `npx wrangler d1 create mycyberlearning --jurisdiction eu`, paste the id into `wrangler.jsonc`, then `npm run db:migrate`.
3. **Admin sign-in**: create a GitHub OAuth app (callback `https://<your host>/auth/callback`), put its client id and your numeric GitHub user id in `wrangler.jsonc`.
4. **Worker secrets** (each prompts with hidden input): `npx wrangler secret put TOKEN_SECRET` (and `SESSION_SECRET`, `VOTE_SALT`, `MAIL_API_KEY`, `GITHUB_OAUTH_CLIENT_SECRET`, `ANTHROPIC_API_KEY`). Generate the first three with `openssl rand -hex 32`; `SESSION_SECRET` must never be given to GitHub.
5. **GitHub secrets**: `CLOUDFLARE_API_TOKEN` (Workers Scripts + D1 edit), `CLOUDFLARE_D1_TOKEN` (D1 edit only), `CLOUDFLARE_ACCOUNT_ID`, `TOKEN_SECRET` (same value as the Worker's), `MAIL_API_KEY`, `ANTHROPIC_API_KEY`; variable `D1_DATABASE_ID`.
6. **Load and deploy**: `npm run seed` with the D1 settings in your shell, then push to `main`.
7. **Domain and email**: add the domain to Cloudflare, attach it to the Worker as a custom domain, verify the sending domain in Resend (SPF, DKIM, DMARC).

Scripts that touch the database read `CLOUDFLARE_ACCOUNT_ID`, `D1_DATABASE_ID` and `CLOUDFLARE_API_TOKEN` from the environment, or `D1_LOCAL_FILE=./local.sqlite` to work against a local copy.

## Running locally
```bash
npm install && npm test && npm run build   # tests run the Worker against an in-memory SQLite copy of the schema
npm run dev                                 # wrangler dev: site + Worker + local D1 at http://localhost:8787
npm run refresh:dry                         # dry-run enrichment of 5 items
```
For `npm run dev`, put local-only values in `.dev.vars` (git-ignored), e.g. `TOKEN_SECRET=...`, `VOTE_SALT=...`, and run `npx wrangler d1 migrations apply mycyberlearning --local` once. Opening `frontend/dist/index.html` directly gives demo mode (votes and admin actions saved in your browser).

## Day-to-day maintenance
- **Approve suggestions**: sign in → Admin → Approve/Reject. Approved items are live immediately and get logos, ratings and cadence on the next Monday refresh.
- **Edit or remove anything**: Edit / Hide / Delete buttons on each card when signed in as admin. Editing tags locks them so automation won't overwrite your choice.
- **Add your own picks in bulk**: edit `data/catalogue.json`, then `npm run seed` (adds new items; `--overwrite` also updates existing ones but keeps votes and locked tags).
- **Import books in bulk (e.g. your Humble Bundle library)**: open humblebundle.com/home/library, filter to ebooks, copy the titles into `books.txt` (one per line; `Title | Author` or an ISBN also work), then:
  ```bash
  ANTHROPIC_API_KEY=... npm run import:books -- books.txt            # preview → data/import-preview.json
  ANTHROPIC_API_KEY=... npm run import:books -- books.txt --apply    # add to catalogue as MCL Picks
  npm run seed                                                        # publish (needs the D1 settings below)
  ```
  Open Library supplies ISBN, publisher and year; Claude writes a short description, assigns domains and level, and drops non-security titles. Duplicates are skipped.
- **Enrich books from your Calibre library**: fills exact ISBNs (your editions), publishers, years and optionally cover thumbnails. Read-only on your library.
  ```bash
  python3 scripts/import_calibre.py "/path/to/Calibre Library"                    # preview
  python3 scripts/import_calibre.py "/path/to/Calibre Library" --apply --covers   # write changes + thumbnails (pip install pillow to resize)
  npm run build && npm run seed -- --overwrite
  ```
  Add `--add-missing` to also list Calibre books not yet in the catalogue (the refresh job then tags them with Claude).
- **Change the domain list**: edit `data/taxonomy.json`, run `npm run build`, push, then run the refresh workflow with **retag** ticked.
- **With Claude Code**: open the repo and ask, e.g. "add a 'Digital Forensics' domain and retag", "add a books tab sorted by Goodreads rating", "show the last episode date on cards". `CLAUDE.md` gives it the context.

## Data sources and notes
- Books carry ISBN and publisher; the refresh job checks each ISBN against Open Library and flags any that belong to a different edition.
- Seed list: MCL Picks (the curator's 2026 recommendations) plus NordLayer, Global Cyber Security Network, Cycode, Splunk and Deepak Gupta lists, with a few editor gap-fillers for ICS/OT, offensive and books (marked `sources: ["editor"]`).
- Official ratings: Podnews (aggregate from Rephonic). Review Podnews' terms before relying on it at scale; set `RATINGS_SOURCE=none` to switch it off, or swap in the Podchaser API (has ratings, needs a free key) in `scripts/enrich.mjs`.
- Spotify's API does not expose show ratings; Apple's public directory API does not either, which is why an aggregator is used.
- Google Podcasts closed in 2024; YouTube and YouTube Music replace it in the platform links.
- Items marked `verified: false` have metadata from list articles; the first refresh run confirms or corrects them.
