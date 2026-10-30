# CLAUDE.md — My Cyber Learning

Public site: https://mycyberlearning.co.uk · Owner/admin: Ian Moore

## What this is
A curated library of cybersecurity podcasts and books. Visitors filter by security domain (multi-select, any/all), frequency and level; see official platform ratings and separate community votes; and suggest new resources. One admin approves, edits, hides and deletes.

## Layout
- `frontend/index.template.html` — the whole UI (vanilla HTML/CSS/JS, no framework). `/*__SEED__*/` is replaced at build time with the catalogue for offline/demo fallback.
- `scripts/build-frontend.mjs` — builds `frontend/dist/` (and syncs `data/taxonomy.json` into `api/src/lib/`).
- `api/` — Azure Functions v4 (Node 20, ESM), deployed as the Static Web App's managed API. `src/lib/shared.js` has storage, auth, validation, Claude tagging.
- `data/taxonomy.json` — the domain, frequency and level lists. Single source of truth; never hard-code domains elsewhere.
- `data/catalogue.json` — seed + weekly snapshot of the live catalogue (the live source of truth is Azure Table `items`).
- `scripts/refresh.mjs` + `enrich.mjs` — weekly enrichment; pure helpers in `scripts/pure.mjs` with tests in `scripts/test/`.
- `infra/main.bicep` — Azure resources. `.github/workflows/` — deploy on push, weekly refresh.

## Conventions
- Keep it cheap: no new paid Azure services without asking. Static Web Apps Free + Table Storage only.
- No frontend framework or build toolchain; keep the page a single file. Fonts from Google Fonts only.
- Item schema: `id, type (podcast|book), name, by, desc, domains[], level[], freq, launched (YYYY or YYYY-MM), status, web, apple, spotify, youtube, rss, logo, rating {v,n,asOf}, curator (shown as "MCL Pick"), isbn (13 digits, no hyphens), isbnVerified, publisher, published, bundle {name,url}, sources[], verified, hidden, tagsLocked`.
- Descriptions are written in our own words (never copied from the show's or a list article's text).
- Official ratings and community votes are never combined into one number.
- Admin endpoints must check `isAdmin(req)` in the handler as well as relying on the SWA route rule.
- Claude prompts treat resource text as data inside `<resource>` tags and use forced tool output constrained to the taxonomy enum.

## Commands
- `npm test` — unit tests (must pass before deploy)
- `npm run build` — build the site
- `npm run refresh:dry` — preview enrichment without writing
- `npm run seed` / `npm run export` — push catalogue to / pull it from Azure Table storage (need `STORAGE_CONNECTION_STRING`)

## Workflow for changes
Make changes on a branch and open a PR; the Deploy workflow creates a preview environment for each PR. Run `npm test` and `npm run build` before proposing changes.
