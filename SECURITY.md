# Security and privacy

## Reporting a vulnerability
Email security@mycyberlearning.co.uk with details and steps to reproduce. Please don't open a public issue. We aim to acknowledge reports within 3 working days.

## Cost safety (why Cloudflare's free plan)
The site runs on Cloudflare's Workers Free plan and Resend's free plan, with **no payment card on any account**. Free-plan limits fail closed: over-limit requests and database queries return errors instead of being billed. So a leaked API key or a taken-over account can disrupt the site but can't create a bill. Anthropic usage is prepaid with auto-reload off, which caps it the same way.

## What we hold, and where
| Data | Where | Protection | Retention |
|---|---|---|---|
| Subscriber email, optional first name, country, topic preferences, consent record | D1 table `subscribers` (EU jurisdiction) | Row id is an HMAC of the email, never the address; encrypted at rest by Cloudflare; reachable only through the Worker or a D1-scoped API token | Until unsubscribe or erasure; unconfirmed sign-ups deleted after 7 days |
| Unsubscribed / erased addresses | `subscribers` rows with status `suppressed` | HMAC id only; every personal field is cleared | Indefinitely, as an opt-out record (the person can re-subscribe by confirming again) |
| Confirmation tokens | `subscribers` | Stored as SHA-256 hash; expire after 48 h; cleared on use | 48 hours |
| Visit counters | `stats` | Aggregate counts per day (section, time-zone region, language, device, referring site). No IPs, cookies or identifiers | 13 months |
| Vote records | `votes` | Salted SHA-256 of a random browser id | While the item exists |
| Visitor suggestions (optional contact email) | `submissions` | IP stored only as a salted hash for abuse control | Email and IP hash removed on review, or after 90 days |
| Briefing emails in transit | Resend (email delivery) | TLS; open and click tracking left off | Per Resend's retention for delivery logs |

IP addresses are used in memory for rate limiting and are never written to the database. No personal data is sent to Anthropic: Claude only sees public podcast notes and catalogue text.

## Controls
**Application**
- Double opt-in with a confirmation page (GET shows a button, POST confirms) so mail scanners that pre-open links can't subscribe people.
- Identical responses and similar timing whether or not an address is subscribed (no enumeration); per-IP limits in memory plus a per-address limit in the database (one confirmation email per 10 minutes, three per day); honeypot field.
- One-click unsubscribe (RFC 8058 `List-Unsubscribe` + `List-Unsubscribe-Post`), signed with HMAC-SHA256 and compared in constant time. GET never changes state.
- Strict input validation (email syntax, allow-listed countries, domains and telemetry values); all user- and feed-derived text is HTML-escaped in pages and emails; only `http(s)` links are emitted; every SQL statement uses bound parameters.
- CSV exports neutralise spreadsheet formula injection.
- **Admin sign-in**: GitHub OAuth with a random `state` in a short-lived cookie (constant-time check); only numeric GitHub ids in `ADMIN_GITHUB_IDS` are admins, re-checked on every request; the GitHub token is revoked straight after reading the user id; the session is an HMAC-signed `__Host-` cookie (Secure, HttpOnly, SameSite=Strict, 8 hours). State-changing admin calls must be same-origin JSON (CSRF protection); every stored URL is checked to be http(s) on the server and again before rendering.
- Feed text is decoded then stripped of `< > " \``, passed to Claude as a JSON array, and every model output is validated: known references only, enum-checked domains, bounded lengths, and URLs, email addresses and phone numbers removed.
- Emails contain no images, scripts, tracking pixels or tracked links.

**Platform**
- HTTPS only with HSTS; CSP without third-party scripts; `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `nosniff`, strict referrer and permissions policies (`frontend/_headers`; API responses set their own).
- The Worker has no runtime npm dependencies: it uses only Web APIs and Node's built-in `crypto`.
- D1 created in the EU jurisdiction; Worker logs contain no request bodies or personal data.

**Supply chain and pipeline**
- Dependabot for npm and GitHub Actions; CodeQL (security-extended) on every push and weekly; `npm audit` in the deploy job.
- Least-privilege tokens: `CLOUDFLARE_API_TOKEN` (Workers Scripts edit + D1 edit) is used only by the deploy job; the data jobs use `CLOUDFLARE_D1_TOKEN` (D1 edit only). Neither can change account settings or add billing.
- Least-privilege `permissions` on every workflow and job; secrets are scoped to the single step that needs them; dependencies install with `--ignore-scripts --omit=dev`; checkout without persisted credentials where no push is needed; deploy and email jobs run in a `production` environment so you can add required reviewers.
- Pull requests are tested but never deployed, so a malicious PR can't reach production secrets.

## Operating checklist
- [ ] Two-factor (passkey preferred) on Cloudflare, GitHub, Resend and Anthropic. Never add a payment card to Cloudflare or Resend unless you choose to upgrade.
- [ ] Enable GitHub secret scanning and push protection (Settings → Code security).
- [ ] Protect `main`: require PRs and passing checks; restrict who can approve the `production` environment.
- [ ] Commit `package-lock.json`, then switch workflows to `npm ci --ignore-scripts` and add `cache: npm`.
- [ ] Pin third-party actions to commit SHAs (Dependabot keeps them updated).
- [ ] Add one Cloudflare rate-limiting rule (free plan includes one): e.g. `POST /api/*`, 20 requests per 10 seconds per IP, block for 10 seconds.
- [ ] SPF, DKIM and DMARC (`p=quarantine` or stricter) for the sending domain.
- [ ] Keep `TOKEN_SECRET` and `VOTE_SALT` in a password manager. The Worker's and GitHub's `TOKEN_SECRET` must match exactly.
- [ ] Rotate the Cloudflare tokens, mail key and `TOKEN_SECRET` yearly or after any suspected exposure (rotating `TOKEN_SECRET` invalidates old unsubscribe links and changes subscriber ids, so export first and re-import).
- [ ] Review the privacy notice whenever data collection changes, and keep a record of processing activities.

## Known limitations
- In-memory rate limits are per Worker isolate; the Cloudflare rate-limiting rule above is the real edge limit.
- D1's free daily write limit (100,000 rows) is shared by votes, sign-ups and visit counters. A traffic flood could exhaust it until midnight UTC; the site keeps serving pages, but writes fail.
- Resend's free plan sends 100 emails a day. Past that, the daily send stops cleanly and logs how many subscribers were skipped.
- Time-zone region is a coarse, user-controlled signal; it is not verified location.
