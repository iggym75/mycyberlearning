#!/usr/bin/env bash
# My Cyber Learning: automated Cloudflare setup (runbook Phases 3 to 5) for macOS or Linux.
#
#   cd ~/Projects/mycyberlearning && ./scripts/deploy/cloudflare-setup.sh
#
# Safe to re-run: every step checks what's already done and skips it.
# It pauses only for things that must be you: browser sign-in approvals, and pasting API tokens
# at hidden prompts. Secrets are generated here, piped straight to Cloudflare/GitHub, and never printed.
set -euo pipefail

ADMIN_GITHUB_ID="${ADMIN_GITHUB_ID:-281173996}"
DB_NAME="mycyberlearning"
WORKER="mycyberlearning"
STATE_DIR="$HOME/.mycyberlearning"
SECRETS="$STATE_DIR/secrets.env"
TOTAL=10
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
export CI=1   # wrangler: no interactive confirmations

step() { printf '\n\033[1;36m[%s/%s] %s\033[0m\n' "$1" "$TOTAL" "$2"; }
ok()   { printf '  \033[1;32m✓\033[0m %s\n' "$*"; }
info() { printf '  · %s\n' "$*"; }
warn() { printf '  \033[1;33m!\033[0m %s\n' "$*"; }
die()  { printf '  \033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
pause(){ printf '\n  \033[1m%s\033[0m\n  Press Enter when done... ' "$1"; read -r _; }
hidden(){ local v; read -rs -p "  $1: " v; echo >&2; printf %s "$v"; }
wr()   { npx --no-install wrangler "$@"; }
# Edit a value in wrangler.jsonc without sed differences between macOS and Linux.
setcfg() { node -e '
  const fs=require("fs"),[k,v]=process.argv.slice(1),f="wrangler.jsonc";let s=fs.readFileSync(f,"utf8");
  const re=new RegExp(`("${k}"\\s*:\\s*)("[^"]*"|true|false)`); if(!re.test(s)) { console.error("no "+k); process.exit(1); }
  s=s.replace(re,(m,a)=>a+(v==="true"||v==="false"?v:JSON.stringify(v))); fs.writeFileSync(f,s);' "$1" "$2"; }
getcfg() { node -e 'const s=require("fs").readFileSync("wrangler.jsonc","utf8");const m=s.match(new RegExp(`"${process.argv[1]}"\\s*:\\s*"([^"]*)"`));process.stdout.write(m?m[1]:"")' "$1"; }

mkdir -p "$STATE_DIR"; chmod 700 "$STATE_DIR"; touch "$SECRETS"; chmod 600 "$SECRETS"
# shellcheck disable=SC1090
set -a; . "$SECRETS"; set +a
save() { grep -v "^$1=" "$SECRETS" > "$SECRETS.tmp" || true; printf '%s=%s\n' "$1" "$2" >> "$SECRETS.tmp"; mv "$SECRETS.tmp" "$SECRETS"; chmod 600 "$SECRETS"; }

# ------------------------------------------------------------------------------------------------
step 1 "Checking tools and getting the latest code"
for c in git node npm gh openssl curl; do command -v "$c" >/dev/null || die "$c is missing. On a Mac: brew install git node@22 gh openssl"; done
node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=5)?0:1)' || die "Node 22.5 or later is needed (you have $(node -v)). Run: brew install node@22 && brew link --overwrite node@22"
gh auth status >/dev/null 2>&1 || gh auth login --web --git-protocol https
REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null)" || die "This folder isn't linked to your GitHub repo. Run: git remote add origin https://github.com/iggym75/mycyberlearning.git"
git fetch -q origin main && { git merge -q --ff-only origin/main 2>/dev/null || warn "Local changes differ from GitHub; continuing with your local copy."; }
ok "Tools present, GitHub repo $REPO, code up to date"

# ------------------------------------------------------------------------------------------------
step 2 "Installing dependencies and running the tests"
npm install --no-audit --no-fund --ignore-scripts >/dev/null
npm rebuild esbuild workerd >/dev/null 2>&1 || true   # these two need their own setup step to run wrangler
TEST_OUT="$(npm test 2>&1)" || { printf '%s\n' "$TEST_OUT" | tail -30; die "Tests failed; stopping before anything is deployed."; }
printf '%s\n' "$TEST_OUT" | grep -E "^# (pass|fail)" | sed 's/^/  /' 
ok "Tests pass; wrangler $(wr --version 2>/dev/null | tail -1)"

# ------------------------------------------------------------------------------------------------
step 3 "Signing in to Cloudflare"
if ! wr whoami 2>/dev/null | grep -qiE "logged in|associated with the email"; then
  info "A browser window will open: sign in to Cloudflare and press Allow."
  wr login
fi
IDS="$(wr whoami 2>/dev/null | grep -oE '[0-9a-f]{32}' | sort -u || true)"
if [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  if [ "$(printf '%s\n' "$IDS" | grep -c .)" -eq 1 ]; then CLOUDFLARE_ACCOUNT_ID="$IDS"
  else wr whoami; read -r -p "  Several Cloudflare accounts: paste the Account ID to use: " CLOUDFLARE_ACCOUNT_ID; fi
  save CLOUDFLARE_ACCOUNT_ID "$CLOUDFLARE_ACCOUNT_ID"
fi
export CLOUDFLARE_ACCOUNT_ID
ok "Signed in; account $CLOUDFLARE_ACCOUNT_ID"

# ------------------------------------------------------------------------------------------------
step 4 "Creating the database (EU jurisdiction) and its tables"
DB_ID="$(getcfg database_id)"
if [ -z "$DB_ID" ] || [ "$DB_ID" = "REPLACE_WITH_D1_DATABASE_ID" ]; then
  DB_ID="$(wr d1 list --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const d=JSON.parse(s).find(x=>x.name===process.argv[1]);process.stdout.write(d?d.uuid:"")}catch{}})' "$DB_NAME")"
  if [ -z "$DB_ID" ]; then wr d1 create "$DB_NAME" --jurisdiction eu >/dev/null; info "Created database $DB_NAME"
    DB_ID="$(wr d1 list --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const d=JSON.parse(s).find(x=>x.name===process.argv[1]);process.stdout.write(d?d.uuid:"")})' "$DB_NAME")"; fi
  [ -n "$DB_ID" ] || die "Couldn't find the database id."
  setcfg database_id "$DB_ID"
fi
save D1_DATABASE_ID "$DB_ID"
wr d1 migrations apply "$DB_NAME" --remote 2>&1 | grep -E "✅|No migrations|Migrations to be applied" | sed 's/^/  /' || true
TABLES="$(wr d1 execute "$DB_NAME" --remote --json --command "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('items','votes','submissions','subscribers','stats','digestlog')" 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s)[0].results.map(r=>r.name).sort().join(", "))}catch{console.log("?")}})')"
ok "Database $DB_ID; tables: $TABLES"

# ------------------------------------------------------------------------------------------------
step 5 "First deploy (to get the site's address)"
setcfg ADMIN_GITHUB_IDS "$ADMIN_GITHUB_ID"
npm run --silent build >/dev/null
OUT="$(wr deploy 2>&1)" || { printf '%s\n' "$OUT" | tail -20; die "Deploy failed (see above)."; }
SITE="$(printf '%s\n' "$OUT" | grep -oE 'https://[a-z0-9.-]+\.workers\.dev' | head -1)"
[ -n "$SITE" ] || SITE="$(getcfg SITE_URL)"
case "$(getcfg SITE_URL)" in https://mycyberlearning.co.uk) setcfg SITE_URL "$SITE";; esac
save SITE_URL "$SITE"
ok "Live at $SITE (temporary address until the domain is connected)"

# ------------------------------------------------------------------------------------------------
step 6 "Admin sign-in: GitHub OAuth app"
CID="$(getcfg GITHUB_OAUTH_CLIENT_ID)"
if [ -z "$CID" ] || [ "$CID" = "REPLACE_WITH_GITHUB_OAUTH_CLIENT_ID" ]; then
  info "GitHub doesn't allow creating these by script, so this one is in your browser."
  info "Opening github.com/settings/applications/new. Fill in exactly:"
  info "  Application name:            My Cyber Learning"
  info "  Homepage URL:                $SITE"
  info "  Authorization callback URL:  $SITE/auth/callback"
  info "Then: Register application → copy the Client ID → Generate a new client secret → copy it."
  (command -v open >/dev/null && open "https://github.com/settings/applications/new") || true
  read -r -p "  Client ID (not secret): " CID
  setcfg GITHUB_OAUTH_CLIENT_ID "$CID"
  hidden "Client secret (hidden)" | wr secret put GITHUB_OAUTH_CLIENT_SECRET >/dev/null
  ok "OAuth app recorded; client secret stored in Cloudflare"
else ok "Already set (client id $CID)"; fi

# ------------------------------------------------------------------------------------------------
step 7 "Worker secrets (generated here, never shown)"
EXISTING="$(wr secret list 2>/dev/null || true)"
have() { printf '%s' "$EXISTING" | grep -q "\"$1\""; }
if ! have TOKEN_SECRET; then [ -n "${TOKEN_SECRET:-}" ] || { TOKEN_SECRET="$(openssl rand -hex 32)"; save TOKEN_SECRET "$TOKEN_SECRET"; }
  printf %s "$TOKEN_SECRET" | wr secret put TOKEN_SECRET >/dev/null; fi
if ! have SESSION_SECRET; then openssl rand -hex 32 | wr secret put SESSION_SECRET >/dev/null; fi   # Worker only, not saved anywhere else
if ! have VOTE_SALT; then [ -n "${VOTE_SALT:-}" ] || { VOTE_SALT="$(openssl rand -hex 32)"; save VOTE_SALT "$VOTE_SALT"; }
  printf %s "$VOTE_SALT" | wr secret put VOTE_SALT >/dev/null; fi
if ! have ANTHROPIC_API_KEY; then
  K="$(hidden "Anthropic API key (hidden; press Enter to skip for now)")"
  if [ -n "$K" ]; then printf %s "$K" | wr secret put ANTHROPIC_API_KEY >/dev/null; printf %s "$K" | gh secret set ANTHROPIC_API_KEY -R "$REPO"; fi; unset K
fi
ok "Secrets in Cloudflare: $(wr secret list 2>/dev/null | grep -oE '"name": *"[A-Z_]+"' | sed 's/.*"\([A-Z_]*\)"/\1/' | tr '\n' ' ')"
warn "Back up $SECRETS in your password manager (TOKEN_SECRET and VOTE_SALT are needed to rebuild the site)."

# ------------------------------------------------------------------------------------------------
step 8 "Cloudflare API tokens for GitHub Actions"
verify() { curl -s -H "Authorization: Bearer $1" https://api.cloudflare.com/client/v4/user/tokens/verify | grep -q '"status":"active"'; }
if ! gh secret list -R "$REPO" | grep -q CLOUDFLARE_D1_TOKEN; then
  info "Opening dash.cloudflare.com/profile/api-tokens. Create two Custom tokens, limited to your account:"
  info "  mcl-deploy : Account > Workers Scripts > Edit, and Account > D1 > Edit"
  info "  mcl-data   : Account > D1 > Edit"
  (command -v open >/dev/null && open "https://dash.cloudflare.com/profile/api-tokens") || true
  T1="$(hidden "mcl-deploy token (hidden)")"; verify "$T1" || die "That deploy token isn't active. Re-run when ready."
  D1_TOKEN="$(hidden "mcl-data token (hidden)")"; verify "$D1_TOKEN" || die "That data token isn't active. Re-run when ready."
  printf %s "$T1" | gh secret set CLOUDFLARE_API_TOKEN -R "$REPO"; unset T1
  printf %s "$D1_TOKEN" | gh secret set CLOUDFLARE_D1_TOKEN -R "$REPO"
else
  info "GitHub already has the tokens. For loading the catalogue, paste the mcl-data token once more."
  D1_TOKEN="$(hidden "mcl-data token (hidden)")"; verify "$D1_TOKEN" || die "That data token isn't active."
fi
printf %s "$CLOUDFLARE_ACCOUNT_ID" | gh secret set CLOUDFLARE_ACCOUNT_ID -R "$REPO"
printf %s "$TOKEN_SECRET" | gh secret set TOKEN_SECRET -R "$REPO"
gh variable set D1_DATABASE_ID -R "$REPO" --body "$DB_ID"
gh variable set SITE_URL -R "$REPO" --body "$SITE"
gh api -X PUT "repos/$REPO/environments/production" >/dev/null
ok "GitHub secrets: $(gh secret list -R "$REPO" | awk '{print $1}' | tr '\n' ' ')"

# ------------------------------------------------------------------------------------------------
step 9 "Loading the catalogue into the database"
CLOUDFLARE_API_TOKEN="$D1_TOKEN" D1_DATABASE_ID="$DB_ID" npm run --silent seed | sed 's/^/  /'
unset D1_TOKEN
ok "Catalogue loaded"

# ------------------------------------------------------------------------------------------------
step 10 "Final deploy through GitHub and checks"
gh api -X PUT "repos/$REPO/actions/permissions" -F enabled=true >/dev/null 2>&1 && info "GitHub Actions enabled"
if ! git diff --quiet -- wrangler.jsonc; then
  git add wrangler.jsonc
  git commit -q -m "Configure Cloudflare (database, admin, site address)" || die "Couldn't commit wrangler.jsonc (is git user.name/user.email set?)."
  git push -q origin HEAD:main || die "Couldn't push to GitHub."
  info "Pushed configuration; the Deploy workflow is running (tests, migrations, deploy)."
  SHA="$(git rev-parse HEAD)"; RUN=""
  for _ in 1 2 3 4 5 6 7 8 9 10; do RUN="$(gh run list -R "$REPO" --workflow deploy.yml --limit 5 --json databaseId,headSha -q ".[] | select(.headSha==\"$SHA\") | .databaseId" | head -1)"; [ -n "$RUN" ] && break; sleep 3; done
  if [ -n "$RUN" ]; then gh run watch -R "$REPO" --exit-status "$RUN" >/dev/null && ok "Deploy workflow succeeded" || warn "Deploy workflow failed: open the Actions tab for details."
  else warn "Couldn't find the Deploy run; check the Actions tab."; fi
else
  npm run --silent build >/dev/null && wr deploy >/dev/null && info "Redeployed from this Mac"
fi
# These checks only warn: a new workers.dev name can take a while to resolve, and with pipefail a failed curl
# (or grep -c counting 0) would otherwise end the script before the refresh below is started.
N="$( (curl -s "$SITE/api/items" || true) | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).items.length)}catch{console.log(0)}})')"
[ "$N" -gt 0 ] && ok "API answers: $N items live" || warn "API returned no items yet; try again in a minute."
H="$( (curl -sI "$SITE/" || true) | grep -ciE '^(content-security-policy|strict-transport-security|x-frame-options):' || true)"
[ "$H" -ge 3 ] && ok "Security headers present" || warn "Only $H of 3 security headers seen."
[ "$(curl -s -o /dev/null -w '%{http_code}' "$SITE/api/admin/submissions" || true)" = "403" ] && ok "Admin API refuses signed-out requests" || warn "Couldn't confirm the admin API refuses signed-out requests."
gh workflow run refresh.yml -R "$REPO" >/dev/null 2>&1 && info "Started the catalogue refresh (logos, ratings, episodes) in GitHub Actions" || warn "Couldn't start the refresh; run it from the Actions tab (Weekly catalogue refresh → Run workflow)."

printf '\n\033[1;32mDone.\033[0m Site: %s\n' "$SITE"
printf 'Now: open %s/admin and sign in with GitHub; you should see "Admin · 0 pending".\n' "$SITE"
printf 'Later: runbook Phase 6 (connect mycyberlearning.co.uk) and Phase 7 (Resend email).\n'
