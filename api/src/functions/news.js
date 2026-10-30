// Daily briefing subscriptions and privacy-first analytics.
//
// Design rules (see SECURITY.md):
// - Double opt-in. Nothing is sent except one confirmation email until the person clicks the link.
// - Identical responses whether or not an address is already subscribed (no account enumeration).
// - Storage keys are HMACs of the email, never the address itself; confirmation tokens are stored hashed.
// - Unsubscribe is one click (RFC 8058) and erases the person's details, keeping only a hash so we never mail them again.
// - Analytics are aggregate counters only: no cookies, no identifiers, no IP addresses stored; Do Not Track / GPC honoured.
import { app } from "@azure/functions";
import { table, T, json, clientIp, rateLimited, clean, DOMAIN_KEYS } from "../lib/shared.js";
import { normaliseEmail, subscriberId, newOneTimeToken, sha256, hashesMatch, verifyToken, renderConfirmEmail, sendMail, escapeHtml, CONSENT_VERSION } from "../lib/mail.js";

const SITE = () => (process.env.SITE_URL || "https://mycyberlearning.co.uk").replace(/\/$/, "");
const COUNTRIES = new Set(["GB", "IE", "US", "CA", "AU", "NZ", "IN", "DE", "FR", "NL", "BE", "ES", "IT", "PT", "SE", "NO", "DK", "FI", "PL", "CH", "AT", "IL", "AE", "SG", "ZA", "NG", "KE", "BR", "MX", "JP", "OTHER"]);
const TOKEN_TTL_MS = 48 * 3600e3;
const GENERIC_OK = { ok: true, message: "Check your inbox for a confirmation link. If it doesn't arrive in a few minutes, check your spam folder." };
// Relative redirects work on both the custom domain and the default *.azurestaticapps.net host.
const redirect = (to) => ({ status: 303, headers: { location: to, "cache-control": "no-store" } });
const jitter = () => new Promise(r => setTimeout(r, 250 + Math.floor(Math.random() * 400))); // similar timing for every outcome

// POST /api/subscribe { email, name?, country?, interests?, consent: true, website (honeypot) }
app.http("subscribe", {
  route: "subscribe", methods: ["POST"], authLevel: "anonymous",
  handler: async (req, ctx) => {
    const ip = clientIp(req);
    if (rateLimited("subip:" + ip, 5, 3600e3)) return json(429, { error: "Too many attempts. Please try again later." });
    let b; try { b = await req.json(); } catch { return json(400, { error: "Invalid request." }); }
    if (b.website) { await jitter(); return json(202, GENERIC_OK); } // bots fill hidden fields; pretend success
    const email = normaliseEmail(b.email);
    if (!email) return json(400, { error: "Enter a valid email address." });
    if (b.consent !== true) return json(400, { error: "Tick the box to agree to receive the briefing." });


    const id = subscriberId(email);
    const t = await table(T.subscribers);
    let existing = null;
    try { existing = await t.getEntity("sub", id); } catch (e) { if (e.statusCode !== 404) throw e; }
    if (existing?.status === "active") { await jitter(); return json(202, GENERIC_OK); } // already subscribed: same response, nothing sent
    // Per-address throttle kept in storage (survives restarts and scale-out): at most one confirmation
    // email per 10 minutes and 3 per day. This also stops anyone cancelling a live link by re-submitting.
    const now = Date.now(), last = Date.parse(existing?.requestedAt || 0);
    const windowStart = now - Date.parse(existing?.windowStart || 0) < 864e5 ? existing.windowStart : new Date(now).toISOString();
    const sendsToday = windowStart === existing?.windowStart ? (existing?.sends || 0) : 0;
    if (existing?.status === "pending" && (now - last < 10 * 60e3 || sendsToday >= 3)) { await jitter(); return json(202, GENERIC_OK); }

    const { token, hash } = newOneTimeToken();
    const country = COUNTRIES.has(String(b.country || "").toUpperCase()) ? String(b.country).toUpperCase() : "";
    const interests = (Array.isArray(b.interests) ? b.interests : []).filter(d => DOMAIN_KEYS.includes(d)).slice(0, 8);
    await t.upsertEntity({
      partitionKey: "sub", rowKey: id, status: "pending", email, name: clean(b.name, 40).replace(/[<>]/g, ""),
      country, interests: JSON.stringify(interests), tokenHash: hash, tokenExpires: new Date(Date.now() + TOKEN_TTL_MS).toISOString(),
      consentVersion: CONSENT_VERSION, consentText: "Email me the My Cyber Learning daily briefing. I can unsubscribe at any time.",
      requestedAt: new Date(now).toISOString(), windowStart, sends: sendsToday + 1
    }, "Replace");

    const confirmUrl = `${SITE()}/api/subscribe/confirm?s=${id}&t=${encodeURIComponent(token)}`;
    // Don't wait for delivery status: keeps response time close to the other outcomes.
    try { await sendMail({ to: email, ...renderConfirmEmail({ confirmUrl, siteUrl: SITE() }) }, { wait: false }); }
    catch (e) { ctx.error("confirmation email failed", e.message); return json(503, { error: "We couldn't send the confirmation email just now. Please try again later." }); }
    return json(202, GENERIC_OK);
  }
});

// GET /api/subscribe/confirm?s=<id>&t=<token> shows a "Confirm" button; POST confirms.
// Email security scanners open links automatically, so a GET must never change anything.
const htmlPage = (title, body, status = 200) => ({
  status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" },
  body: `<!doctype html><html lang="en-GB"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<body style="font-family:system-ui,sans-serif;max-width:520px;margin:12vh auto;padding:0 16px;color:#0f1c2e;line-height:1.5"><h1 style="font-size:22px">${escapeHtml(title)}</h1>${body}
<p><a href="${escapeHtml(SITE())}" style="color:#0b7a75">Back to My Cyber Learning</a></p></body></html>`
});
const button = (label) => `<button type="submit" style="background:#0b7a75;color:#fff;border:0;border-radius:8px;padding:10px 16px;font-size:15px;cursor:pointer">${escapeHtml(label)}</button>`;

app.http("subscribeConfirm", {
  route: "subscribe/confirm", methods: ["GET", "POST"], authLevel: "anonymous",
  handler: async (req) => {
    const id = String(req.query.get("s") || ""), token = String(req.query.get("t") || "");
    const bad = () => htmlPage("Link not recognised", "<p>This confirmation link is incomplete or has already been used. Subscribe again from the website to get a new one.</p>", 400);
    if (!/^[a-f0-9]{40}$/.test(id) || token.length < 20 || token.length > 100) return bad();
    const t = await table(T.subscribers);
    let r; try { r = await t.getEntity("sub", id); } catch { return bad(); }
    if (r.status === "active") return redirect(`/?subscribe=confirmed#news`);
    if (!hashesMatch(r.tokenHash, sha256(token))) return bad();
    if (Date.parse(r.tokenExpires) < Date.now()) return htmlPage("Link expired", "<p>Confirmation links last 48 hours. Subscribe again from the website to get a new one.</p>", 410);
    if (req.method === "GET") {
      return htmlPage("Confirm your daily briefing", `<form method="post" action="/api/subscribe/confirm?s=${id}&amp;t=${encodeURIComponent(token)}">
<p>Press confirm to start receiving the My Cyber Learning briefing each morning. You can unsubscribe from any email.</p>${button("Confirm subscription")}</form>`);
    }
    await t.updateEntity({ partitionKey: "sub", rowKey: id, status: "active", confirmedAt: new Date().toISOString(), tokenHash: "", tokenExpires: "" }, "Merge", { etag: r.etag });
    try { await t.deleteEntity("suppressed", id); } catch { /* not previously unsubscribed */ }
    return redirect(`/?subscribe=confirmed#news`);
  }
});

// GET shows a confirmation page (mail scanners follow GET links, so GET never unsubscribes by itself).
// POST unsubscribes: from that page's form, or one-click from the mail client (RFC 8058).
app.http("unsubscribe", {
  route: "unsubscribe", methods: ["GET", "POST"], authLevel: "anonymous",
  handler: async (req) => {
    const id = String(req.query.get("s") || ""), token = String(req.query.get("t") || "");
    const valid = /^[a-f0-9]{40}$/.test(id) && verifyToken("unsubscribe", id, token);
    const page = htmlPage;
    if (!valid) return page("Link not recognised", "<p>This unsubscribe link is incomplete or has been altered. Use the link from the most recent briefing email.</p>", 400);
    if (req.method === "GET") {
      return page("Unsubscribe from the daily briefing?", `<form method="post" action="/api/unsubscribe?s=${id}&amp;t=${encodeURIComponent(token)}">
<p>We'll stop sending the briefing and delete your email address and details.</p>
${button("Unsubscribe")}</form>`);
    }
    const t = await table(T.subscribers);
    try { await t.deleteEntity("sub", id); } catch { /* already gone */ }
    await t.upsertEntity({ partitionKey: "suppressed", rowKey: id, at: new Date().toISOString() }, "Replace"); // hash only: no personal data
    return page("You're unsubscribed", "<p>Your email address and details have been deleted. You won't receive any more briefings.</p>");
  }
});

// POST /api/t  { p: page, r: referrer host, tz: IANA time zone, l: language, d: device class }
// Aggregate counters per day. Nothing identifying is stored, and the response is always 204.
const PAGES = new Set(["library", "news", "podcasts", "books"]);
const ZONES = new Set(Intl.supportedValuesOf ? Intl.supportedValuesOf("timeZone") : []);
const REFERRERS = ["google", "bing", "duckduckgo", "yahoo", "ecosia", "linkedin", "t.co", "twitter", "x.com", "reddit", "facebook", "github", "youtube", "news.ycombinator", "mastodon", "bsky", "chatgpt", "claude.ai", "perplexity"];
const refBucket = h => { h = h.toLowerCase().replace(/^www\./, ""); const m = REFERRERS.find(r => h === r || h.startsWith(r + ".") || h.endsWith("." + r) || h.includes(r + ".")); return m || "other"; };
const DEVICE = new Set(["mobile", "tablet", "desktop"]);
app.http("telemetry", {
  route: "t", methods: ["POST"], authLevel: "anonymous",
  handler: async (req) => {
    const done = { status: 204, headers: { "cache-control": "no-store" } };
    if (req.headers.get("dnt") === "1" || req.headers.get("sec-gpc") === "1") return done;
    if (/bot|crawl|spider|slurp|preview|headless/i.test(req.headers.get("user-agent") || "")) return done;
    if (rateLimited("t:" + clientIp(req), 60, 600e3)) return done;
    let b; try { b = JSON.parse((await req.text()).slice(0, 1000)); } catch { return done; }
    const dims = [];
    if (PAGES.has(b.p)) dims.push(`page|${b.p}`);
    if (typeof b.tz === "string" && ZONES.has(b.tz)) dims.push(`region|${b.tz}`);
    if (typeof b.l === "string" && /^[a-z]{2}(-[A-Za-z]{2})?$/.test(b.l)) dims.push(`lang|${b.l}`);
    if (DEVICE.has(b.d)) dims.push(`device|${b.d}`);
    if (typeof b.r === "string" && /^[a-z0-9.-]{3,80}$/i.test(b.r)) dims.push(`ref|${refBucket(b.r)}`); // fixed set of buckets, so rows can't be multiplied
    if (!dims.length) return done;
    dims.push("total|views");
    const day = new Date().toISOString().slice(0, 10), t = await table(T.stats);
    // Table keys can't contain / \ # ? so encode the time zone's slash.
    await Promise.all(dims.map(d => increment(t, day, d.replace(/\//g, "~"))));
    return done;
  }
});
async function increment(t, pk, rk) {
  for (let i = 0; i < 4; i++) {
    let r = null;
    try { r = await t.getEntity(pk, rk); } catch (e) { if (e.statusCode !== 404) throw e; }
    try {
      if (!r) await t.createEntity({ partitionKey: pk, rowKey: rk, n: 1 });
      else await t.updateEntity({ partitionKey: pk, rowKey: rk, n: (r.n || 0) + 1 }, "Merge", { etag: r.etag });
      return;
    } catch (e) { if (![409, 412].includes(e.statusCode)) throw e; }
  }
}
