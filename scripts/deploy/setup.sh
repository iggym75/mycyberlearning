#!/usr/bin/env bash
# My Cyber Learning — one-time setup from your own computer (macOS or Linux).
#
#   ./scripts/deploy/setup.sh            # stage 1: GitHub repo, Azure resources, secrets, first deploy
#   ./scripts/deploy/setup.sh domain     # stage 2: custom domain + email domain (after you own the domain)
#   ./scripts/deploy/setup.sh link-email # stage 3: connect the verified email domain so the briefing can send
#
# Safe to re-run. Secrets are generated on this computer, stored in ~/.mycyberlearning/secrets.env
# (readable only by you), and passed to Azure and GitHub without appearing on the command line or on screen.
set -euo pipefail

STAGE="${1:-setup}"
RG="${RG:-rg-mycyberlearning}"
LOCATION="${LOCATION:-uksouth}"
DOMAIN="${DOMAIN:-mycyberlearning.co.uk}"; export DOMAIN
PREFIX="mycyberlearn"
SITE="${PREFIX}-site"
SECRETS_DIR="$HOME/.mycyberlearning"
SECRETS="$SECRETS_DIR/secrets.env"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!  %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31mx  %s\033[0m\n' "$*" >&2; exit 1; }
ask()  { local q="$1" d="${2:-}" a; read -r -p "$q${d:+ [$d]}: " a; echo "${a:-$d}"; }

need() {
  local missing=""
  for c in git node npm az gh openssl; do command -v "$c" >/dev/null || missing="$missing $c"; done
  if [[ -n "$missing" ]]; then
    warn "Missing:$missing"
    echo "On a Mac with Homebrew:  brew install git node@20 azure-cli gh openssl"
    echo "Homebrew itself: https://brew.sh"
    exit 1
  fi
  node -e 'process.exit(+process.versions.node.split(".")[0] >= 20 ? 0 : 1)' || die "Node 20 or later is needed (node -v shows $(node -v))."
}

login() {
  say "Signing in (each opens your browser; you sign in there, nothing is typed here)"
  az account show >/dev/null 2>&1 || az login >/dev/null
  echo "Azure subscription: $(az account show --query name -o tsv) ($(az account show --query id -o tsv))"
  [[ "$(ask 'Use this subscription? (y/n)' y)" == y ]] || { az account list --query '[].{name:name,id:id}' -o table; az account set -s "$(ask 'Subscription id')"; }
  gh auth status >/dev/null 2>&1 || gh auth login --web --git-protocol https
  GH_USER="$(gh api user --jq .login)"
  echo "GitHub account: $GH_USER"
}

load_secrets() {
  mkdir -p "$SECRETS_DIR"; chmod 700 "$SECRETS_DIR"
  if [[ ! -f "$SECRETS" ]]; then
    say "Creating secrets (once) in $SECRETS"
    umask 077
    {
      echo "TOKEN_SECRET=$(openssl rand -hex 32)"
      echo "VOTE_SALT=$(openssl rand -hex 32)"
    } > "$SECRETS"
    read -r -s -p "Paste your Anthropic API key (input hidden; press Enter to skip for now): " k; echo
    echo "ANTHROPIC_API_KEY=$k" >> "$SECRETS"
    warn "Back up $SECRETS in your password manager. Every Azure redeploy must reuse these exact values."
  fi
  chmod 600 "$SECRETS"
  # shellcheck disable=SC1090
  set -a; . "$SECRETS"; set +a
}

deploy_infra() {   # $1 = linkEmailDomain true|false
  say "Deploying Azure resources to $RG ($LOCATION)"
  az provider register -n Microsoft.Web >/dev/null; az provider register -n Microsoft.Communication >/dev/null; az provider register -n Microsoft.Storage >/dev/null
  az group create -n "$RG" -l "$LOCATION" -o none
  local params; params="$(mktemp)"; chmod 600 "$params"
  node -e '
    const p = (v) => ({ value: v });
    process.stdout.write(JSON.stringify({ "$schema": "https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#", contentVersion: "1.0.0.0", parameters: {
      tokenSecret: p(process.env.TOKEN_SECRET), voteSalt: p(process.env.VOTE_SALT), anthropicApiKey: p(process.env.ANTHROPIC_API_KEY || ""),
      siteUrl: p("https://" + process.env.DOMAIN), mailDomain: p(process.env.DOMAIN), linkEmailDomain: p(process.argv[1] === "true") } }));
  ' "$1" > "$params"
  az deployment group create -g "$RG" -n mycyberlearning -f infra/main.bicep -p @"$params" -o none || { rm -f "$params"; die "Azure deployment failed (see the message above)."; }
  rm -f "$params"
  STORAGE_ACCOUNT="$(az deployment group show -g "$RG" -n mycyberlearning --query properties.outputs.storageAccount.value -o tsv)"
  SWA_HOST="$(az deployment group show -g "$RG" -n mycyberlearning --query properties.outputs.defaultHostname.value -o tsv)"
  echo "Site address (until your domain is connected): https://$SWA_HOST"
}

github_repo() {
  say "GitHub repository"
  if git remote get-url origin >/dev/null 2>&1; then
    REPO="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"; echo "Using existing remote: $REPO"; return
  fi
  local name vis
  name="$(ask 'Repository name' mycyberlearning)"
  echo "Public is recommended: free CodeQL code scanning and secret-scanning push protection, unlimited Actions minutes."
  echo "No secrets are stored in the code. Private works too, but those security features need a paid GitHub plan."
  vis="$(ask 'Visibility (public/private)' public)"
  gh repo create "$name" "--$vis" --source . --remote origin --description "My Cyber Learning: curated cybersecurity podcasts and books"
  REPO="$GH_USER/$name"
}

github_secrets() {
  say "Storing secrets in GitHub (encrypted; never printed)"
  local swa_token storage_cs acs_cs
  swa_token="$(az staticwebapp secrets list -n "$SITE" -g "$RG" --query properties.apiKey -o tsv)"
  storage_cs="$(az storage account show-connection-string -g "$RG" -n "$STORAGE_ACCOUNT" -o tsv)"
  acs_cs="$(az communication list-key -n "${PREFIX}-acs" -g "$RG" --query primaryConnectionString -o tsv 2>/dev/null || true)"
  if [[ -z "$acs_cs" ]]; then az extension add --name communication -y -o none 2>/dev/null || true; acs_cs="$(az communication list-key -n "${PREFIX}-acs" -g "$RG" --query primaryConnectionString -o tsv)"; fi
  printf %s "$swa_token"  | gh secret set AZURE_STATIC_WEB_APPS_API_TOKEN -R "$REPO"
  printf %s "$storage_cs" | gh secret set STORAGE_CONNECTION_STRING -R "$REPO"
  printf %s "$acs_cs"     | gh secret set ACS_CONNECTION_STRING -R "$REPO"
  printf %s "$TOKEN_SECRET" | gh secret set TOKEN_SECRET -R "$REPO"
  [[ -n "${ANTHROPIC_API_KEY:-}" ]] && printf %s "$ANTHROPIC_API_KEY" | gh secret set ANTHROPIC_API_KEY -R "$REPO"
  gh variable set SITE_URL -R "$REPO" --body "https://$DOMAIN"
  gh variable set MAIL_FROM -R "$REPO" --body "briefing@$DOMAIN"
  gh api -X PUT "repos/$REPO/environments/production" >/dev/null   # the email job runs in this environment
  # Free on public repos; ignored on private ones without a paid plan.
  gh api -X PATCH "repos/$REPO" -F 'security_and_analysis[secret_scanning][status]=enabled' \
     -F 'security_and_analysis[secret_scanning_push_protection][status]=enabled' >/dev/null 2>&1 || warn "Couldn't turn on secret scanning automatically; enable it in Settings > Code security."
  gh api -X PUT "repos/$REPO/vulnerability-alerts" >/dev/null 2>&1 || true
}

seed_and_push() {
  say "Loading the catalogue into Azure Table storage"
  npm install --no-audit --no-fund --ignore-scripts >/dev/null
  STORAGE_CONNECTION_STRING="$(az storage account show-connection-string -g "$RG" -n "$STORAGE_ACCOUNT" -o tsv)" npm run --silent seed
  say "Pushing the code (this starts the first deploy)"
  git push -u origin main
  echo "Watch it: gh run watch -R $REPO   (or the Actions tab on GitHub)"
}

admin_invite() {
  say "Making you the site admin"
  local host="${1:-$SWA_HOST}" url
  url="$(az staticwebapp users invite -n "$SITE" -g "$RG" --authentication-provider GitHub --user-details "$GH_USER" \
        --role admin --domain "$host" --invitation-expiration-in-hours 48 --query invitationUrl -o tsv)"
  echo "Open this link once, signed in to GitHub as $GH_USER, to accept the admin role:"; echo "  $url"
}

case "$STAGE" in
  setup)
    need; login; load_secrets; github_repo; deploy_infra false; github_secrets; seed_and_push; admin_invite
    say "Done"
    cat <<EOF
Next:
  1. Wait for the Deploy workflow to finish, then open https://$SWA_HOST
  2. Run the weekly refresh once to fill logos, ratings and episode counts:  gh workflow run refresh.yml -R $REPO
  3. When you own $DOMAIN, run:  ./scripts/deploy/setup.sh domain
EOF
    ;;
  domain)
    need; login; load_secrets
    STORAGE_ACCOUNT="$(az deployment group show -g "$RG" -n mycyberlearning --query properties.outputs.storageAccount.value -o tsv)"
    SWA_HOST="$(az staticwebapp show -n "$SITE" -g "$RG" --query defaultHostname -o tsv)"
    az extension add --name communication -y -o none 2>/dev/null || true
    say "DNS records to add at your domain registrar for $DOMAIN"
    echo "Website:"
    echo "  www                 CNAME  $SWA_HOST"
    echo "  @ (apex)            ALIAS/ANAME/flattened CNAME -> $SWA_HOST   (if your registrar can't, use Azure DNS, ~£0.40/month)"
    echo "Email (from Azure Communication Services):"
    az communication email domain show --domain-name "$DOMAIN" --email-service-name "${PREFIX}-email" -g "$RG" \
      --query "verificationRecords.{domain:domain, spf:spf, dkim:dkim, dkim2:dkim2}" -o jsonc
    echo "  _dmarc              TXT    \"v=DMARC1; p=quarantine; rua=mailto:dmarc@$DOMAIN\""
    read -r -p $'\nAdd those records, wait ~15 minutes, then press Enter to connect the domains... '
    say "Connecting the website domain"
    az staticwebapp hostname set -n "$SITE" -g "$RG" --hostname "www.$DOMAIN" -o none || warn "www not ready yet; re-run later."
    az staticwebapp hostname set -n "$SITE" -g "$RG" --hostname "$DOMAIN" --validation-method dns-txt-token --no-wait -o none || true
    tok="$(az staticwebapp hostname show -n "$SITE" -g "$RG" --hostname "$DOMAIN" --query validationToken -o tsv 2>/dev/null || true)"
    [[ -n "$tok" ]] && echo "Also add:  @  TXT  $tok   (proves you own the apex domain)"
    say "Asking Azure to verify the email domain"
    for t in Domain SPF DKIM DKIM2; do
      az communication email domain initiate-verification --domain-name "$DOMAIN" --email-service-name "${PREFIX}-email" -g "$RG" --verification-type "$t" -o none || true
    done
    GH_USER="$(gh api user --jq .login)"; admin_invite "$DOMAIN"
    echo; echo "When the email domain shows Verified in the Azure portal, run:  ./scripts/deploy/setup.sh link-email"
    ;;
  link-email)
    need; login; load_secrets; deploy_infra true
    say "Email sending is connected. Test it: Actions > Daily news briefing > Run workflow (tick 'send')."
    ;;
  *) die "Unknown stage '$STAGE' (use: setup | domain | link-email)";;
esac
