// Optional name and email for My list accounts: confirming the address, linking it to the daily briefing,
// consent to occasional new-feature emails, and signing in with an emailed link (account recovery).
//
// Rules
// - An address is only used once it's confirmed from a link sent to it, so nobody can attach someone else's address.
// - The briefing and new-feature emails are separate, unticked opt-ins with their own consent record and one-click
//   unsubscribe. Creating an account never subscribes anyone to anything.
// - Changing or removing the email needs a recent passkey sign-in, because the email can be used to sign in.
// - An emailed sign-in link works once, for 30 minutes, and signs every other device out. Requests for a link get the
//   same answer whether or not the address has an account, and are throttled per IP, per account and site-wide.
// - Every email the site sends for accounts counts towards the same daily cap as briefing confirmations, so these
//   flows can't use up the email plan's quota or mail strangers in bulk.
import { json } from "./lib/shared.js";
import { normaliseEmail, subscriberId, newOneTimeToken, sha256, hashesMatch, signToken, verifyToken, sendMail, renderAccountEmail, escapeHtml, CONSENT_VERSION } from "./lib/mail.js";
import { htmlPage, button } from "./news.js";
import { suppress } from "./admin.js";
import { _internal } from "./account.js";

const { handler, sessionCookie, limited, body, refuse, now, site, REAUTH_S } = _internal;
const SITE = req => site(req).origin;
const AID = /^[A-Za-z0-9_-]{22}$/;
const VERIFY_TTL_MS = 48 * 3600e3, LOGIN_TTL_MS = 30 * 60e3;
const CAP = () => Number(process.env.CONFIRM_DAILY_CAP) || 40;
const BRIEFING_CONSENT = "Ticked 'Email me the daily briefing' in my My list account; address confirmed from an emailed link.";
const UPDATES_CONSENT = "Ticked 'Email me occasionally about new features' in my My list account. I can stop these from any email.";
const GENERIC_LINK = { ok: true, message: "If that address belongs to a My list account, we've emailed a sign-in link. It works once and expires in 30 minutes." };
const jitter = () => new Promise(r => setTimeout(r, 250 + Math.floor(Math.random() * 400)));
const redirect = (to, headers = {}) => new Response(null, { status: 303, headers: { location: to, "cache-control": "no-store", ...headers } });
const cleanName = v => String(v ?? "").replace(/[\u0000-\u001f<>"]/g, "").replace(/\s+/g, " ").trim().slice(0, 40) || null;

/** The profile fields shown in Manage account. */
export async function profileOf(env, aid) {
  const a = await env.DB.prepare("SELECT name, email, email_id, email_verified_at, email_pending, briefing_wanted, updates_opt_in FROM accounts WHERE id = ?").bind(aid).first();
  if (!a) return null;
  const sub = a.email_id ? await env.DB.prepare("SELECT status FROM subscribers WHERE id = ?").bind(a.email_id).first() : null;
  return { name: a.name || "", email: a.email || "", emailVerified: !!a.email_verified_at, emailPending: a.email_pending || "",
    briefing: sub?.status === "active", briefingWaiting: !!a.briefing_wanted, updates: !!a.updates_opt_in };
}

/** Starts (or restarts) the daily briefing for a confirmed address, recording how consent was given. */
async function startBriefing(db, email, name) {
  const id = subscriberId(email), t = now();
  await db.prepare(`INSERT INTO subscribers (id, status, email, name, country, interests, consent_version, consent_text, requested_at, confirmed_at, sends)
      VALUES (?, 'active', ?, ?, '', '[]', ?, ?, ?, ?, 0)
    ON CONFLICT(id) DO UPDATE SET status = 'active', email = excluded.email, name = COALESCE(excluded.name, subscribers.name),
      consent_version = excluded.consent_version, consent_text = excluded.consent_text, confirmed_at = COALESCE(subscribers.confirmed_at, excluded.confirmed_at),
      token_hash = NULL, token_expires = NULL, suppressed_at = NULL, reason = NULL`)
    .bind(id, email, name || null, CONSENT_VERSION, BRIEFING_CONSENT, t, t).run();
}

/**
 * Sends an account email if the per-account throttle and the site-wide daily cap
 * allow it (one per minute, five per day). Returns "sent", "throttled", "capped" or "failed".
 */
async function sendAccountMail(env, aid, msg) {
  const db = env.DB, a = await db.prepare("SELECT mail_window_start, mail_sends, mail_last FROM accounts WHERE id = ?").bind(aid).first();
  const t = Date.now(), inWindow = a?.mail_window_start && t - Date.parse(a.mail_window_start) < 864e5;
  const sends = inWindow ? (a.mail_sends || 0) : 0;
  if ((a?.mail_last && t - Date.parse(a.mail_last) < 60e3) || sends >= 5) return "throttled";
  const day = new Date(t).toISOString().slice(0, 10);
  const sentToday = (await db.prepare("SELECT n FROM stats WHERE day = ? AND dim = 'mail' AND val = 'confirm'").bind(day).first())?.n || 0;
  if (sentToday >= CAP()) { console.warn("account email: daily cap reached"); return "capped"; }
  await db.batch([
    db.prepare("UPDATE accounts SET mail_window_start = ?, mail_sends = ?, mail_last = ? WHERE id = ?").bind(inWindow ? a.mail_window_start : new Date(t).toISOString(), sends + 1, new Date(t).toISOString(), aid),
    db.prepare("INSERT INTO stats (day, dim, val, n) VALUES (?, 'mail', 'confirm', 1) ON CONFLICT(day, dim, val) DO UPDATE SET n = n + 1").bind(day)
  ]);
  try { await sendMail(msg); return "sent"; } catch (e) { console.error("account email failed:", e.message); return "failed"; }
}
const mailNote = r => ({ sent: null, throttled: "We sent an email very recently. Please wait a minute and try again.",
  capped: "We've sent as many emails as we can today. Please try again tomorrow.", failed: "We couldn't send the email just now. Please try again later." })[r];

// PUT /api/account/profile { name?, email?, briefing?, updates? }
export const profile = handler(async (req, env, ctx, params, acc) => {
  const b = await body(req); if (!b) return refuse("Invalid request.");
  const db = env.DB, cur = await db.prepare("SELECT name, email, email_id, email_pending FROM accounts WHERE id = ?").bind(acc.id).first();
  const notes = [];
  let name = cur.name;
  if ("name" in b) { name = cleanName(b.name); await db.prepare("UPDATE accounts SET name = ? WHERE id = ?").bind(name, acc.id).run(); }

  let verified = cur.email;
  if ("email" in b) {
    const raw = String(b.email ?? "").trim();
    const want = raw ? normaliseEmail(raw) : "";
    if (raw && !want) return refuse("Enter a valid email address.");
    if (want !== (cur.email || "") || (!want && cur.email_pending)) {
      // The email can be used to sign in, so changing it needs a recent passkey sign-in (a stolen cookie isn't enough).
      // Adding the first address also needs it: otherwise a stolen cookie could add the thief's address.
      if (Date.now() / 1000 - acc.authAt > REAUTH_S) return json(403, { error: "For your security, confirm it's you with your passkey first.", reauth: true });
      if (!want) {
        if (cur.email_id) await suppress(db, cur.email_id, "email removed from account");
        await db.prepare("UPDATE accounts SET email = NULL, email_id = NULL, email_verified_at = NULL, email_pending = NULL, email_token_hash = NULL, email_token_expires = NULL, login_token_hash = NULL, login_token_expires = NULL, briefing_wanted = 0 WHERE id = ?").bind(acc.id).run();
        verified = null; notes.push("Email removed.");
      } else if (want === cur.email_pending && !b.resend) {
        notes.push(`We're waiting for you to confirm ${want}.`);
      } else {
        const { token, hash } = newOneTimeToken();
        await db.prepare("UPDATE accounts SET email_pending = ?, email_token_hash = ?, email_token_expires = ? WHERE id = ?").bind(want, hash, new Date(Date.now() + VERIFY_TTL_MS).toISOString(), acc.id).run();
        const url = `${SITE(req)}/api/account/email/confirm?a=${acc.id}&t=${encodeURIComponent(token)}`;
        const r = await sendAccountMail(env, acc.id, { to: want, ...renderAccountEmail({ kind: "verify", url, siteUrl: SITE(req), name }) });
        notes.push(r === "sent" ? `Check ${want} for a confirmation link.` : mailNote(r));
      }
    }
  }

  if ("briefing" in b) {
    if (b.briefing === true) {
      if (verified) { await startBriefing(db, verified, name); notes.push("The daily briefing will arrive each morning at 08:30 UK time."); }
      else { await db.prepare("UPDATE accounts SET briefing_wanted = 1 WHERE id = ?").bind(acc.id).run(); notes.push("The briefing starts once your email is confirmed."); }
    } else if (b.briefing === false) {
      await db.prepare("UPDATE accounts SET briefing_wanted = 0 WHERE id = ?").bind(acc.id).run();
      if (cur.email_id) await suppress(db, cur.email_id, "turned off in account");
    }
  }
  if ("updates" in b) {
    if (b.updates === true) await db.prepare("UPDATE accounts SET updates_opt_in = 1, updates_consent_at = ?, updates_consent_text = ? WHERE id = ? AND updates_opt_in = 0").bind(now(), UPDATES_CONSENT, acc.id).run();
    else if (b.updates === false) await db.prepare("UPDATE accounts SET updates_opt_in = 0 WHERE id = ?").bind(acc.id).run();
  }
  return json(200, { ok: true, profile: await profileOf(env, acc.id), message: notes.filter(Boolean).join(" ") });
}, { needSession: true });

/** Forms on our own pages post back to us; refuse cross-site posts (stops login CSRF with someone else's link). */
// These pages send no referrer, so browsers report the form's Origin as "null"; Sec-Fetch-Site is the reliable signal.
const sameSitePost = req => {
  const sfs = req.headers.get("sec-fetch-site");
  if (sfs) return sfs === "same-origin";
  const o = req.headers.get("origin");
  if (!o || o === "null") return true; // very old browsers send neither header
  try { return new URL(o).origin === SITE(req); } catch { return false; }
};

// GET shows a button; POST confirms. (Mail scanners open links, so GET never changes anything.)
export async function confirmEmail(req, env) {
  const q = new URL(req.url).searchParams, aid = String(q.get("a") || ""), token = String(q.get("t") || "");
  const bad = () => htmlPage("Link not recognised", "<p>This link is incomplete, has expired or has already been used. You can ask for a new one from My list, under Manage account.</p>", 400);
  if (!AID.test(aid) || token.length < 20 || token.length > 100) return bad();
  const a = await env.DB.prepare("SELECT id, name, email_pending, email_token_hash, email_token_expires, briefing_wanted FROM accounts WHERE id = ?").bind(aid).first();
  if (!a?.email_pending || !a.email_token_hash || !hashesMatch(a.email_token_hash, sha256(token)) || Date.parse(a.email_token_expires) < Date.now()) return bad();
  const action = `/api/account/email/confirm?a=${aid}&amp;t=${encodeURIComponent(token)}`;
  if (req.method === "GET") return htmlPage("Confirm your email", `<form method="post" action="${action}"><p>Press confirm to add <b>${escapeHtml(a.email_pending)}</b> to your My list account.</p>${button("Confirm email")}</form>`);
  if (!sameSitePost(req)) return bad();
  const email = a.email_pending, id = subscriberId(email);
  const taken = await env.DB.prepare("SELECT 1 FROM accounts WHERE email_id = ? AND id <> ?").bind(id, aid).first();
  if (taken) return htmlPage("Address already in use", "<p>That email address is already linked to another My list account. Sign in to that account instead, or use a different address.</p>", 409);
  const old = await env.DB.prepare("SELECT email_id FROM accounts WHERE id = ?").bind(aid).first();
  const upd = await env.DB.prepare(`UPDATE accounts SET email = ?, email_id = ?, email_verified_at = ?, email_pending = NULL, email_token_hash = NULL, email_token_expires = NULL,
      login_token_hash = NULL, login_token_expires = NULL, briefing_wanted = 0 WHERE id = ? AND email_token_hash = ?`).bind(email, id, now(), aid, a.email_token_hash).run();
  if (!(upd.meta?.changes ?? 0)) return bad();
  // A changed address takes the briefing with it: the old address stops, the new one starts if it was on.
  const wasOn = old?.email_id && old.email_id !== id && (await env.DB.prepare("SELECT status FROM subscribers WHERE id = ?").bind(old.email_id).first())?.status === "active";
  if (wasOn) await suppress(env.DB, old.email_id, "account email changed");
  if (a.briefing_wanted || wasOn) await startBriefing(env.DB, email, a.name);
  return redirect("/?account=email-confirmed#mylist");
}

// POST /api/account/recover/email { email }: emails a one-time sign-in link to a confirmed address.
export const requestLoginLink = handler(async (req, env) => {
  if (await limited(req, env, "recover", 5)) return json(429, { error: "Too many attempts. Please wait a minute." });
  const b = await body(req); if (!b) return refuse("Invalid request.");
  const email = normaliseEmail(b.email);
  if (!email) return refuse("Enter a valid email address.");
  const a = await env.DB.prepare("SELECT id, name FROM accounts WHERE email_id = ? AND email_verified_at IS NOT NULL").bind(subscriberId(email)).first();
  if (a) {
    const { token, hash } = newOneTimeToken();
    await env.DB.prepare("UPDATE accounts SET login_token_hash = ?, login_token_expires = ? WHERE id = ?").bind(hash, new Date(Date.now() + LOGIN_TTL_MS).toISOString(), a.id).run();
    const url = `${SITE(req)}/api/account/email-login?a=${a.id}&t=${encodeURIComponent(token)}`;
    await sendAccountMail(env, a.id, { to: email, ...renderAccountEmail({ kind: "login", url, siteUrl: SITE(req), name: a.name }) });
  }
  await jitter();
  return json(202, GENERIC_LINK); // same answer whether or not the address has an account
});

// GET shows a button; POST signs in (once), ends other sessions and goes to My list.
export async function emailLogin(req, env) {
  const q = new URL(req.url).searchParams, aid = String(q.get("a") || ""), token = String(q.get("t") || "");
  const bad = () => htmlPage("Link not recognised", "<p>This sign-in link has expired or has already been used. Ask for a new one from My list.</p>", 400);
  if (!AID.test(aid) || token.length < 20 || token.length > 100) return bad();
  const a = await env.DB.prepare("SELECT id, session_gen, login_token_hash, login_token_expires FROM accounts WHERE id = ?").bind(aid).first();
  if (!a?.login_token_hash || !hashesMatch(a.login_token_hash, sha256(token)) || Date.parse(a.login_token_expires) < Date.now()) return bad();
  if (req.method === "GET") return htmlPage("Sign in to My list", `<form method="post" action="/api/account/email-login?a=${aid}&amp;t=${encodeURIComponent(token)}"><p>Press the button to sign in on this device. Your other devices will be signed out.</p>${button("Sign in")}</form>`);
  if (!sameSitePost(req)) return bad();
  const gen = a.session_gen + 1;
  const upd = await env.DB.prepare("UPDATE accounts SET login_token_hash = NULL, login_token_expires = NULL, session_gen = ?, last_seen = ? WHERE id = ? AND login_token_hash = ?").bind(gen, now(), aid, a.login_token_hash).run();
  if (!(upd.meta?.changes ?? 0)) return bad();
  return redirect("/?account=signed-in#mylist", { "set-cookie": sessionCookie(aid, gen) });
}

// One-click unsubscribe from new-feature emails (RFC 8058 POST from the mail client, or the page's button).
export const updatesUnsubUrl = (siteOrigin, aid) => `${siteOrigin}/api/account/updates/unsubscribe?a=${aid}&t=${signToken("updates-unsub", aid)}`;
export async function updatesUnsubscribe(req, env) {
  const q = new URL(req.url).searchParams, aid = String(q.get("a") || ""), token = String(q.get("t") || "");
  if (!AID.test(aid) || !verifyToken("updates-unsub", aid, token)) return htmlPage("Link not recognised", "<p>This link is incomplete or has been altered. Use the link from the most recent update email.</p>", 400);
  if (req.method === "GET") return htmlPage("Stop new-feature emails?", `<form method="post" action="/api/account/updates/unsubscribe?a=${aid}&amp;t=${encodeURIComponent(token)}"><p>We'll stop sending occasional updates about new features. Your My list account and any daily briefing aren't affected.</p>${button("Stop these emails")}</form>`);
  await env.DB.prepare("UPDATE accounts SET updates_opt_in = 0 WHERE id = ?").bind(aid).run();
  return htmlPage("Done", "<p>You won't get any more new-feature emails. You can turn them back on in My list, under Manage account.</p>");
}
