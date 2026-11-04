# CLAUDE.md — My Cyber Learning

Public site: https://mycyberlearning.co.uk · Owner/admin: Ian Moore

## What this is
A curated library of cybersecurity podcasts, books and learning platforms (labs, CTFs, courses, certifications, events and communities that are free or low-cost and not tied to one vendor). Visitors filter by security domain (multi-select, any/all), frequency and level; see official platform ratings and separate community votes; and suggest new resources. One admin approves, edits, hides and deletes.

## Layout
- `frontend/index.template.html` — the whole UI (vanilla HTML/CSS/JS, no framework). `/*__SEED__*/` is replaced at build time with the catalogue for offline/demo fallback.
- `scripts/build-frontend.mjs` — builds `frontend/dist/` (and syncs `data/taxonomy.json` into `worker/src/lib/`). `scripts/d1.mjs` — D1 over HTTPS for scripts, or local SQLite (`D1_LOCAL_FILE`) for tests.
- `worker/` — Cloudflare Worker (ESM, no runtime npm deps): `src/index.js` routes `/api/*`, `/auth/*`, `/admin`; everything else is static assets from `frontend/dist`. `src/lib/` has D1 helpers, email/tokens, validation and Claude tagging. Schema in `worker/migrations/`; config in `wrangler.jsonc`.
- `data/taxonomy.json` — the domain, frequency, level, platform-kind and cost lists. Single source of truth; never hard-code domains elsewhere.
- `data/catalogue.json` — seed + weekly snapshot of the live catalogue (the live source of truth is the D1 `items` table).
- `scripts/refresh.mjs` + `enrich.mjs` — weekly enrichment; pure helpers in `scripts/pure.mjs` with tests in `scripts/test/`.
- `.github/workflows/` — deploy on push (wrangler), weekly refresh, daily briefing.

## Conventions
- Keep it free and card-free: Cloudflare Workers Free + D1, Resend free, GitHub Actions. Never add a service that needs a payment method without asking. Watch the free limits (10 ms CPU per request, D1 daily reads/writes).
- No frontend framework or build toolchain; keep the page a single file. Fonts from Google Fonts only.
- Item schema: `id, type (podcast|book|platform), name, by, desc, domains[], level[], freq, launched (YYYY or YYYY-MM), status, web, apple, spotify, amazon (Amazon Music podcast page; optional, hand-entered, host-checked), youtube, rss, logo, rating {v,n,asOf}, curator (shown as "MCL Pick"), isbn (13 digits, no hyphens), isbnVerified, publisher, published, bundle {name,url}, kind and cost (platforms only; taxonomy `platformKinds` / `costs`), sources[], verified, hidden, tagsLocked`. Platforms have no official rating source: only community votes show.
- Descriptions are written in our own words (never copied from the show's or a list article's text).
- Official ratings and community votes are never combined into one number.
- Admin endpoints must be wrapped in `guard()` (worker/src/auth.js): signed session cookie (SESSION_SECRET, Worker-only) + allow-listed GitHub id + same-origin JSON for writes. All SQL uses bound parameters.
- Claude prompts treat resource text as data inside `<resource>` tags and use forced tool output constrained to the taxonomy enum.
- Daily briefing: `scripts/news.mjs` writes `frontend/news/<date>.json`; `scripts/send-digest.mjs` emails it; shared email/token code is in `worker/src/lib/mail.js`. Never republish show notes verbatim; only our summaries.
- Personal data rules (see SECURITY.md): consent-only, minimum fields, no IPs or identifiers stored, escape everything in emails, GET never changes state, keep the privacy notice in the page in step with any change.

## Commands
- `npm test` — unit tests (must pass before deploy)
- `npm run build` — build the site
- `npm run refresh:dry` — preview enrichment without writing
- `npm run seed` / `npm run export` — push catalogue to / pull it from D1 (need `CLOUDFLARE_ACCOUNT_ID`, `D1_DATABASE_ID`, `CLOUDFLARE_API_TOKEN`, or `D1_LOCAL_FILE`)
- `npm run dev` — local site + Worker with wrangler; `npm run deploy` — manual deploy

## Workflow for changes
Make changes on a branch and open a PR; the Deploy workflow tests every PR but only deploys `main`. Run `npm test` and `npm run build` before proposing changes.
