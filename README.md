# My Cyber Learning

**mycyberlearning.co.uk** — a curated, filterable library of cybersecurity podcasts and books for people starting out in security and practitioners keeping their skills current.

- Filter by one or more security domains (match any / match all), release frequency, level, and Ian's picks
- Official ratings (aggregated from Apple Podcasts, Spotify, Podchaser and Podcast Addict) shown separately from community up/down votes
- Sort by official rating, community votes, most-rated, newest or longest-running
- Links to Apple Podcasts, Spotify, YouTube and the official site; logos, cadence and launch date for every show
- Visitors suggest podcasts and books; Claude pre-tags and sanity-checks each suggestion; an admin approves, edits, hides or deletes anything
- A weekly automated job keeps logos, links, cadence, launch dates, ratings and tags current

---

## Architecture

```
            ┌────────────────────────── GitHub repo (source of truth for code + catalogue snapshot) ─────┐
            │  frontend/  api/  scripts/  data/catalogue.json  .github/workflows/                       │
            └──────┬───────────────────────────────────────────────┬────────────────────────────────────┘
       push to main│                                                │ every Monday 05:17 UTC
                   ▼                                                ▼
   ┌──────────────────────────────────┐              ┌─────────────────────────────────────────────────┐
   │ Azure Static Web Apps (Free)     │              │ GitHub Action: scripts/refresh.mjs              │
   │  • static page on global CDN     │              │  Apple directory → artwork, links, RSS feed     │
   │  • free SSL + custom domain      │              │  RSS → cadence, launch date, active/ended       │
   │  • GitHub login, "admin" role    │              │  Podnews → aggregated listener rating           │
   │  • managed Functions API  /api/* │◄────────────►│  Open Library → book covers & ratings           │
   └──────────────┬───────────────────┘              │  Claude (Haiku) → domain tags + level           │
                  │                                  │  export → commits data/catalogue.json           │
                  ▼                                  └─────────────────────┬───────────────────────────┘
   ┌──────────────────────────────────┐                                    │
   │ Azure Table Storage              │◄───────────────────────────────────┘
   │  items · votes · submissions     │
   └──────────────────────────────────┘
```

| Endpoint | Who | Purpose |
|---|---|---|
| `GET /api/items` | public | Catalogue + community tallies (60 s cache) |
| `POST /api/vote` | public | One vote per item per browser; salted-hash voter id; rate-limited |
| `POST /api/submissions` | public | Validated suggestion → review queue (Claude pre-tags and flags spam) |
| `GET /api/admin/submissions` | admin | Review queue |
| `POST /api/admin/submissions/{id}` | admin | Approve / reject |
| `PATCH /api/admin/items/{id}` | admin | Edit fields, hide/unhide, change tags (locks them from auto-retagging) |
| `DELETE /api/admin/items/{id}` | admin | Delete item and its votes |

Admin routes are protected twice: `staticwebapp.config.json` restricts `/api/admin/*` to the `admin` role, and each handler re-checks the role.

### Why this stack

| Option | Monthly cost | Verdict |
|---|---|---|
| **Azure Static Web Apps Free + Table Storage + GitHub Actions** | **≈ £0–1** | Chosen. Free hosting, SSL, custom domain, auth and serverless API in one resource; storage costs pennies; Actions are free for public repos. |
| GitHub Pages + GitHub Issues for submissions/votes | £0 | Cheapest, but votes via Issues are clunky and there is no real admin UI. |
| Azure App Service / Container Apps | £10+ | Unnecessary for a mostly static site. |
| Cosmos DB free tier | £0 (one per subscription) | Works, but Table Storage is simpler and has no free-tier ceiling to watch. |

Expected running costs: Static Web Apps Free £0 · Table Storage < £0.50 · Claude Haiku tagging a few pence per weekly run · domain ≈ £5–10/year. Free-plan limits worth knowing: 100 GB bandwidth per month, 2 custom domains, 250 MB app size, up to 25 users with custom roles via invitation (plenty for one admin).

### Automation: which approach for which job

| Job | Tool | Why |
|---|---|---|
| Building and changing the site | **Claude Code** in this repo | Reads `CLAUDE.md`, edits code, runs tests, opens PRs. You review and merge. |
| Keeping metadata, ratings and tags current | **Scheduled GitHub Action** (`refresh.yml`) | Deterministic, free, logged; calls Claude only for the judgement part (tagging). |
| Triaging visitor submissions | **Serverless function + Claude** | Instant pre-tagging and spam check at submit time; a human always approves. |
| Discovering new podcasts (optional, later) | **Agentic run** (Claude Code on a schedule, or a monthly Action) | Reads source lists such as the Goodpods leaderboard, compares with the catalogue, and opens a PR of candidates for you to accept. |

A fully agentic pipeline that publishes without review is not recommended: the value of the site is curation, so the agent proposes and you approve.

---

## Setup (about an hour)

Prerequisites: an Azure subscription, a GitHub account, Node 20+, the Azure CLI (`az`), and optionally an Anthropic API key for auto-tagging.

### 1. Create the GitHub repository
```bash
git init && git add . && git commit -m "Initial commit"
gh repo create mycyberlearning --public --source . --push     # public = free Actions minutes
```

### 2. Create the Azure resources
```bash
az login
az group create -n rg-mycyberlearning -l uksouth
az deployment group create -g rg-mycyberlearning -f infra/main.bicep
```
Note the `siteName`, `defaultHostname` and `storageAccount` outputs.

Add your Anthropic key to the site (keeps it out of deployment history):
```bash
az staticwebapp appsettings set -n mycyberlearn-site --setting-names ANTHROPIC_API_KEY=sk-ant-...
```

### 3. Connect GitHub to Azure
```bash
# Deployment token for the GitHub Action
az staticwebapp secrets list -n mycyberlearn-site --query properties.apiKey -o tsv
# Storage connection string for the refresh job
az storage account show-connection-string -g rg-mycyberlearning -n <storageAccount> -o tsv
```
In GitHub → Settings → Secrets and variables → Actions, add:

| Secret | Value |
|---|---|
| `AZURE_STATIC_WEB_APPS_API_TOKEN` | deployment token |
| `STORAGE_CONNECTION_STRING` | storage connection string |
| `ANTHROPIC_API_KEY` | your Anthropic key (optional; tagging is skipped without it) |

Optional Actions variables: `CLAUDE_MODEL` (default `claude-haiku-5-5`), `RATINGS_SOURCE` (`podnews` or `none`).

### 4. Load the catalogue and deploy
```bash
npm install
STORAGE_CONNECTION_STRING="<conn>" npm run seed
git push            # the Deploy workflow builds and publishes the site
```
Then run **Actions → Weekly catalogue refresh → Run workflow** once to pull logos, launch dates, cadence and ratings for every entry.

### 5. Make yourself admin
Azure portal → your Static Web App → **Role management** → **Invite** → provider GitHub, your GitHub username, role `admin`, domain `mycyberlearning.co.uk`. Open the invite link and sign in. Visit `/admin` to sign in later; the Admin button then appears in the header.

### 6. Point mycyberlearning.co.uk at the site
1. Register the domain (any UK registrar; .co.uk is typically £5–10 a year).
2. **www**: Azure portal → Custom domains → Add → `www.mycyberlearning.co.uk`, type CNAME → at your registrar create `CNAME www → <defaultHostname>`.
3. **Apex** (`mycyberlearning.co.uk`): add it in Custom domains with TXT validation, then either
   - move DNS to **Azure DNS** (≈ £0.40/month per zone) and create an alias A record to the Static Web App, or
   - use a DNS host that supports ALIAS/ANAME or CNAME flattening (e.g. Cloudflare's free plan) pointing at `<defaultHostname>`.
4. SSL certificates are issued and renewed automatically.

---

## Running locally
```bash
npm install && npm test && npm run build      # builds frontend/dist/index.html
npm run refresh:dry                            # dry-run enrichment of 5 items, prints what would change
```
Open `frontend/dist/index.html` directly to use the demo mode (votes and admin actions saved in your browser). For the full stack use the [SWA CLI](https://github.com/Azure/static-web-apps-cli) with Azurite:
```bash
npm i -g @azure/static-web-apps-cli azure-functions-core-tools@4 azurite
azurite --silent &
cp api/local.settings.example.json api/local.settings.json && (cd api && npm install)
swa start frontend/dist --api-location api
```

## Day-to-day maintenance
- **Approve suggestions**: sign in → Admin → Approve/Reject. Approved items are live immediately and get logos, ratings and cadence on the next Monday refresh.
- **Edit or remove anything**: Edit / Hide / Delete buttons on each card when signed in as admin. Editing tags locks them so automation won't overwrite your choice.
- **Add your own picks in bulk**: edit `data/catalogue.json`, then `npm run seed` (adds new items; `--overwrite` also updates existing ones but keeps votes and locked tags).
- **Change the domain list**: edit `data/taxonomy.json`, run `npm run build`, push, then run the refresh workflow with **retag** ticked.
- **With Claude Code**: open the repo and ask, e.g. "add a 'Digital Forensics' domain and retag", "add a books tab sorted by Goodreads rating", "show the last episode date on cards". `CLAUDE.md` gives it the context.

## Data sources and notes
- Seed list: Ian Moore's 2026 recommendations plus NordLayer, Global Cyber Security Network, Cycode, Splunk and Deepak Gupta lists, with a few editor gap-fillers for ICS/OT, offensive and books (marked `sources: ["editor"]`).
- Official ratings: Podnews (aggregate from Rephonic). Review Podnews' terms before relying on it at scale; set `RATINGS_SOURCE=none` to switch it off, or swap in the Podchaser API (has ratings, needs a free key) in `scripts/enrich.mjs`.
- Spotify's API does not expose show ratings; Apple's public directory API does not either, which is why an aggregator is used.
- Google Podcasts closed in 2024; YouTube and YouTube Music replace it in the platform links.
- Items marked `verified: false` have metadata from list articles; the first refresh run confirms or corrects them.
