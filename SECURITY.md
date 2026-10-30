# Security and privacy

## Reporting a vulnerability
Email security@mycyberlearning.co.uk with details and steps to reproduce. Please don't open a public issue. We aim to acknowledge reports within 3 working days.

## What we hold, and where
| Data | Where | Protection | Retention |
|---|---|---|---|
| Subscriber email, optional first name, country, topic preferences, consent record | Azure Table `subscribers` (UK South) | Row key is an HMAC of the email, never the address; double encryption at rest; access only via the storage key held in app settings / GitHub secrets | Until unsubscribe or erasure; unconfirmed sign-ups deleted after 7 days |
| Unsubscribed / erased addresses | Table `subscribers`, partition `suppressed` | HMAC only (no address) | Indefinitely, as an opt-out record (the person can re-subscribe by confirming again) |
| Confirmation tokens | Table `subscribers` | Stored as SHA-256 hash; expire after 48 h; cleared on use | 48 hours |
| Visit counters | Table `stats` | Aggregate counts per day (section, time-zone region, language, device, referring site). No IPs, cookies or identifiers | 13 months |
| Vote records | Table `votes` | Salted SHA-256 of a random browser id | While the item exists |
| Visitor suggestions (optional contact email) | Table `submissions` | IP stored only as salted hash for abuse control | Email and IP hash removed on review, or after 90 days |

IP addresses are used in memory for rate limiting and are never written to storage. No personal data is sent to Anthropic: Claude only sees public podcast notes and catalogue text.

## Controls
**Application**
- Double opt-in with a confirmation page (GET shows a button, POST confirms) so mail scanners that pre-open links can't subscribe people.
- Identical responses and similar response times whether or not an address is subscribed (no enumeration); per-IP limits in memory (least-recently-used eviction) plus a per-address limit in storage (one confirmation email per 10 minutes, three per day), which also stops anyone cancelling someone else's live confirmation link; honeypot field.
- One-click unsubscribe (RFC 8058 `List-Unsubscribe` + `List-Unsubscribe-Post`), signed with HMAC-SHA256 and compared in constant time. GET never changes state.
- Strict input validation (email syntax, allow-listed countries, domains and telemetry values); all user- and feed-derived text is HTML-escaped in pages and emails; only `http(s)` links are emitted.
- CSV exports neutralise spreadsheet formula injection.
- Admin endpoints are restricted by Static Web Apps role rules **and** re-checked in every handler; state-changing admin calls must be same-origin JSON (CSRF protection); every stored URL is checked to be http(s) on the server and again before rendering.
- Feed text is decoded then stripped of `< > " \``, passed to Claude as a JSON array (so it can't forge structure), and every model output is validated: known references only, enum-checked domains, bounded lengths, and URLs, email addresses and phone numbers removed, so a manipulated feed can't put a phishing link or number into the briefing. Links only ever come from the feeds' own episode URLs.
- Emails contain no images, scripts, tracking pixels or tracked links; Azure engagement tracking is disabled.

**Platform**
- HTTPS only with HSTS; CSP without third-party scripts; `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `nosniff`, strict referrer and permissions policies.
- Storage: TLS 1.2+, no public blob access, no cross-tenant replication, infrastructure (double) encryption.
- Email data location: UK. Site hosting: West Europe; storage: UK South.

**Supply chain and pipeline**
- Dependabot for npm and GitHub Actions; CodeQL (security-extended) on every push and weekly; `npm audit` in the deploy job.
- Least-privilege `permissions` on every workflow and job; secrets are scoped to the single step that needs them and dependencies install with `--ignore-scripts`, so a compromised package's install script never sees a secret; checkout without persisted credentials where no push is needed; the email job runs in a `production` environment so you can add required reviewers.
- The daily send is resumable: an interrupted run continues where it stopped without double-sending.
- Secrets live only in GitHub encrypted secrets and Static Web Apps app settings. `TOKEN_SECRET` and `VOTE_SALT` are random 32-byte values supplied at deployment (never derived from resource names).

## Operating checklist
- [ ] Enable GitHub secret scanning and push protection (Settings → Code security).
- [ ] Protect `main`: require PRs and passing checks; restrict who can approve the `production` environment.
- [ ] Commit `package-lock.json` files, then switch workflows to `npm ci` and add `cache: npm`.
- [ ] Pin third-party actions to commit SHAs (Dependabot keeps them updated).
- [ ] Add SPF, DKIM and DMARC (`p=quarantine` or stricter) for mycyberlearning.co.uk.
- [ ] Keep `tokenSecret`, `voteSalt` and the Anthropic key in a password manager: every Bicep redeploy must pass the same values (it replaces all app settings), and GitHub's `TOKEN_SECRET` must match exactly.
- [ ] Rotate the storage key, ACS key and `TOKEN_SECRET` yearly or after any suspected exposure (rotating `TOKEN_SECRET` invalidates old unsubscribe links and changes subscriber ids, so export first and re-import).
- [ ] Turn on Microsoft Defender for Storage if budget allows (~£8/month per account).
- [ ] Review the privacy notice whenever data collection changes, and keep a record of processing activities.

## Known limitations
- Pull-request preview environments run with the production app settings. Only merge or preview PRs you trust, or turn off previews (Static Web Apps → Environments) if you accept outside contributions.
- Rate limits are per Function instance and in memory; they blunt casual abuse rather than determined attackers. Azure Front Door with WAF would add edge rate limiting at extra cost (~£30/month).
- The Static Web Apps managed API cannot use managed identity or private endpoints, so storage is reached with an account key.
- Time-zone region is a coarse, user-controlled signal; it is not verified location.
