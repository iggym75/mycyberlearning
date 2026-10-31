// Daily briefing subscriptions and privacy-first analytics.
//
// Design rules (see SECURITY.md):
// - Double opt-in. Nothing is sent except one confirmation email until the person confirms.
// - Identical responses whether or not an address is already subscribed (no account enumeration).
// - Row keys are HMACs of the email, never the address itself; confirmation tokens are stored hashed.
// - Unsubscribe is one click (RFC 8058) and erases the person's details, keeping only a hash so we never mail them again.
// - Analytics are aggregate counters only: no cookies, no identifiers, no IP addresses stored; Do Not Track / GPC honoured.
import { json, clientIp, rateLimited, clean, DOMAIN_KEYS } from "./lib/shared.js";
import { normaliseEmail, subscriberId, newOneTimeToken, sha256, hashesMatch, verifyToken, renderConfirmEmail, sendMail, escapeHtml, CONSENT_VERSION } from "./lib/mail.js";
import { suppress } from "./admin.js";

const SITE = () => (process.env.SITE_URL || "https://mycyberlearning.co.uk").replace(/\/$/, "");
const COUNTRIES = new Set(["GB", "IE", "US", "CA", "AU", "NZ", "IN", "DE", "FR", "NL", "BE", "ES", "IT", "PT", "SE", "NO", "DK", "FI", "PL", "CH", "AT", "IL", "AE", "SG", "ZA", "NG", "KE", "BR", "MX", "JP", "OTHER"]);
const TOKEN_TTL_MS = 48 * 3600e3;
const GENERIC_OK = { ok: true, message: "Check your inbox for a confirmation link. If it doesn't arrive in a few minutes, check your spam folder." };
const redirect = to => new Response(null, { status: 303, headers: { location: to, "cache-control": "no-store" } }); // relative: works on any host
const jitter = () => new Promise(r => setTimeout(r, 250 + Math.floor(Math.random() * 400))); // similar timing for every outcome

// POST /api/subscribe { email, name?, country?, interests?, consent: true, website (honeypot) }
export async function subscribe(req, env) {
  if (rateLimited("subip:" + clientIp(req), 5, 3600e3)) return json(429, { error: "Too many attempts. Please try again later." });
  let b; try { b = await req.json(); } catch { return json(400, { error: "Invalid request." }); }
  if (b.website) { await jitter(); return json(202, GENERIC_OK); } // bots fill hidden fields; pretend success
  const email = normaliseEmail(b.email);
  if (!email) return json(400, { error: "Enter a valid email address." });
  if (b.consent !== true) return json(400, { error: "Tick the box to agree to receive the briefing." });

  const db = env.DB, id = subscriberId(email);
  const existing = await db.prepare("SELECT * FROM subscribers WHERE id = ?").bind(id).first();
  if (existing?.status === "active") { await jitter(); return json(202, GENERIC_OK); } // already subscribed: same response, nothing sent
  // Per-address throttle kept in the database: at most one confirmation email per 10 minutes and 3 per day.
  // This also stops anyone cancelling a live link by re-submitting.
  const now = Date.now(), last = Date.parse(existing?.requested_at || 0) || 0;
  const sameWindow = existing?.window_start && now - Date.parse(existing.window_start) < 864e5;
  const windowStart = sameWindow ? existing.window_start : new Date(now).toISOString();
  const sendsToday = sameWindow ? (existing.sends || 0) : 0;
  if (existing?.status === "pending" && (now - last < 10 * 60e3 || sendsToday >= 3)) { await jitter(); return json(202, GENERIC_OK); }

  const { token, hash } = newOneTimeToken();
  const country = COUNTRIES.has(String(b.country || "").toUpperCase()) ? String(b.country).toUpperCase() : "";
  const interests = (Array.isArray(b.interests) ? b.interests : []).filter(d => DOMAIN_KEYS.includes(d)).slice(0, 8);
  await db.prepare(`INSERT INTO subscribers (id, status, email, name, country, interests, token_hash, token_expires, consent_version, consent_text, requested_at, window_start, sends)
      VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET status = 'pending', email = excluded.email, name = excluded.name, country = excluded.country,
      interests = excluded.interests, token_hash = excluded.token_hash, token_expires = excluded.token_expires,
      consent_version = excluded.consent_version, consent_text = excluded.consent_text, requested_at = excluded.requested_at,
      window_start = excluded.window_start, sends = excluded.sends, suppressed_at = NULL, reason = NULL`).bind(
    id, email, clean(b.name, 40).replace(/[<>]/g, ""), country, JSON.stringify(interests), hash, new Date(now + TOKEN_TTL_MS).toISOString(),
    CONSENT_VERSION, "Email me the My Cyber Learning daily briefing. I can unsubscribe at any time.", new Date(now).toISOString(), windowStart, sendsToday + 1
  ).run();

  const confirmUrl = `${SITE()}/api/subscribe/confirm?s=${id}&t=${encodeURIComponent(token)}`;
  try { await sendMail({ to: email, ...renderConfirmEmail({ confirmUrl, siteUrl: SITE() }) }); }
  catch (e) { console.error("confirmation email failed:", e.message); return json(503, { error: "We couldn't send the confirmation email just now. Please try again later." }); }
  return json(202, GENERIC_OK);
}

// GET /api/subscribe/confirm?s=<id>&t=<token> shows a "Confirm" button; POST confirms.
// Email security scanners open links automatically, so a GET must never change anything.
const htmlPage = (title, body, status = 200) => new Response(`<!doctype html><html lang="en-GB"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<body style="font-family:system-ui,sans-serif;max-width:520px;margin:12vh auto;padding:0 16px;color:#0f1c2e;line-height:1.5"><h1 style="font-size:22px">${escapeHtml(title)}</h1>${body}
<p><a href="/" style="color:#0b7a75">Back to My Cyber Learning</a></p></body></html>`, { status, headers: {
  "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" } });
const button = label => `<button type="submit" style="background:#0b7a75;color:#fff;border:0;border-radius:8px;padding:10px 16px;font-size:15px;cursor:pointer">${escapeHtml(label)}</button>`;

export async function confirm(req, env) {
  const q = new URL(req.url).searchParams, id = String(q.get("s") || ""), token = String(q.get("t") || "");
  const bad = () => htmlPage("Link not recognised", "<p>This confirmation link is incomplete or has already been used. Subscribe again from the website to get a new one.</p>", 400);
  if (!/^[a-f0-9]{40}$/.test(id) || token.length < 20 || token.length > 100) return bad();
  const r = await env.DB.prepare("SELECT * FROM subscribers WHERE id = ?").bind(id).first();
  if (!r) return bad();
  if (r.status === "active") return redirect("/?subscribe=confirmed#news");
  if (r.status !== "pending" || !hashesMatch(r.token_hash, sha256(token))) return bad();
  if (Date.parse(r.token_expires) < Date.now()) return htmlPage("Link expired", "<p>Confirmation links last 48 hours. Subscribe again from the website to get a new one.</p>", 410);
  if (req.method === "GET") {
    return htmlPage("Confirm your daily briefing", `<form method="post" action="/api/subscribe/confirm?s=${id}&amp;t=${encodeURIComponent(token)}">
<p>Press confirm to start receiving the My Cyber Learning briefing each morning. You can unsubscribe from any email.</p>${button("Confirm subscription")}</form>`);
  }
  await env.DB.prepare("UPDATE subscribers SET status = 'active', confirmed_at = ?, token_hash = NULL, token_expires = NULL WHERE id = ? AND status = 'pending' AND token_hash = ?")
    .bind(new Date().toISOString(), id, r.token_hash).run();
  return redirect("/?subscribe=confirmed#news");
}

// GET shows a confirmation page (mail scanners follow GET links, so GET never unsubscribes by itself).
// POST unsubscribes: from that page's form, or one-click from the mail client (RFC 8058).
export async function unsubscribe(req, env) {
  const q = new URL(req.url).searchParams, id = String(q.get("s") || ""), token = String(q.get("t") || "");
  if (!(/^[a-f0-9]{40}$/.test(id) && verifyToken("unsubscribe", id, token)))
    return htmlPage("Link not recognised", "<p>This unsubscribe link is incomplete or has been altered. Use the link from the most recent briefing email.</p>", 400);
  if (req.method === "GET") {
    return htmlPage("Unsubscribe from the daily briefing?", `<form method="post" action="/api/unsubscribe?s=${id}&amp;t=${encodeURIComponent(token)}">
<p>We'll stop sending the briefing and delete your email address and details.</p>${button("Unsubscribe")}</form>`);
  }
  await suppress(env.DB, id, "unsubscribed");
  return htmlPage("You're unsubscribed", "<p>Your email address and details have been deleted. You won't receive any more briefings.</p>");
}

// POST /api/t  { p: page, r: referrer host, tz: IANA time zone, l: language, d: device class }
// Aggregate counters per day. Nothing identifying is stored, and the response is always 204.
const PAGES = new Set(["library", "news", "podcasts", "books"]);
let ZONES = null;
const zones = () => (ZONES ??= new Set(Intl.supportedValuesOf ? Intl.supportedValuesOf("timeZone") : []));
const REFERRERS = ["google", "bing", "duckduckgo", "yahoo", "ecosia", "linkedin", "t.co", "twitter", "x.com", "reddit", "facebook", "github", "youtube", "news.ycombinator", "mastodon", "bsky", "chatgpt", "claude.ai", "perplexity"];
const refBucket = h => { h = h.toLowerCase().replace(/^www\./, ""); return REFERRERS.find(r => h === r || h.startsWith(r + ".") || h.endsWith("." + r) || h.includes(r + ".")) || "other"; };
const DEVICE = new Set(["mobile", "tablet", "desktop"]);
export async function telemetry(req, env) {
  const done = new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  if (req.headers.get("dnt") === "1" || req.headers.get("sec-gpc") === "1") return done;
  if (/bot|crawl|spider|slurp|preview|headless/i.test(req.headers.get("user-agent") || "")) return done;
  if (rateLimited("t:" + clientIp(req), 60, 600e3)) return done;
  let b; try { b = JSON.parse((await req.text()).slice(0, 1000)); } catch { return done; }
  const dims = [];
  if (PAGES.has(b.p)) dims.push(["page", b.p]);
  if (typeof b.tz === "string" && zones().has(b.tz)) dims.push(["region", b.tz]);
  if (typeof b.l === "string" && /^[a-z]{2}(-[A-Za-z]{2})?$/.test(b.l)) dims.push(["lang", b.l]);
  if (DEVICE.has(b.d)) dims.push(["device", b.d]);
  if (typeof b.r === "string" && /^[a-z0-9.-]{3,80}$/i.test(b.r)) dims.push(["ref", refBucket(b.r)]); // fixed buckets, so rows can't be multiplied
  if (!dims.length) return done;
  dims.push(["total", "views"]);
  const day = new Date().toISOString().slice(0, 10), db = env.DB;
  await db.batch(dims.map(([dim, val]) => db.prepare("INSERT INTO stats (day, dim, val, n) VALUES (?, ?, ?, 1) ON CONFLICT(day, dim, val) DO UPDATE SET n = n + 1").bind(day, dim, val)))
    .catch(e => console.warn("telemetry write failed:", e.message)); // never fail the page over a counter
  return done;
}
