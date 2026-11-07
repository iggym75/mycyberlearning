// Optional name and email for My list accounts: confirming the address, linking it to the daily briefing,
// consent to occasional new-feature emails, and signing in with an emailed link (account recovery).
//
// Rules
// - An address is only used once it's confirmed from a link sent to it, so nobody can attach someone else's address.
// - Consent to the briefing and new-feature emails comes from the address owner: the account holder can ask for them,
//   but they only start when the owner ticks them on the confirmation page (unticked by default). Once an address is
//   confirmed, the account holder is its owner and can change them in Manage account. Creating an account never
//   subscribes anyone to anything, and each consent is recorded with its time and wording.
// - Changing or removing the email needs a recent passkey sign-in, because the email can be used to sign in.
// - Emailed sign-in links work once, for 30 minutes, and sign every other device out. Several can be live at once, so
//   a new request never cancels one the person is about to use. Requests return straight away with the same answer
//   whether or not the address has an account (the lookup and sending happen after the response).
// - Email budget: account emails share the site-wide daily cap with briefing confirmations (CONFIRM_DAILY_CAP), with
//   sub-caps per kind (VERIFY_DAILY_CAP, LOGIN_DAILY_CAP), so no single flow can use up the plan's quota.
import { json } from "./lib/shared.js";
import { normaliseEmail, subscriberId, newOneTimeToken, sha256, signToken, verifyToken, sendMail, renderAccountEmail, escapeHtml, CONSENT_VERSION } from "./lib/mail.js";
import { htmlPage, button } from "./news.js";
import { suppress } from "./admin.js";
import { _internal } from "./account.js";

const { handler, sessionCookie, limited, body, refuse, now, site, REAUTH_S } = _internal;
const SITE = req => site(req).origin;
const AID = /^[A-Za-z0-9_-]{22}$/;
const VERIFY_TTL_MS = 48 * 3600e3, LOGIN_TTL_MS = 30 * 60e3;
const TOTAL_CAP = () => Number(process.env.CONFIRM_DAILY_CAP) || 40;   // all confirmation and sign-in emails together
const KIND_CAP = { verify: () => Number(process.env.VERIFY_DAILY_CAP) || 15, login: () => Number(process.env.LOGIN_DAILY_CAP) || 15 };
export const BRIEFING_CONSENT = "Email me the My Cyber Learning daily briefing. I can unsubscribe at any time.";
export const UPDATES_CONSENT = "Email me occasionally about new features. I can stop these at any time.";
const GENERIC_LINK = { ok: true, message: "If that address belongs to a My list account, we've emailed a sign-in link. It works once and expires in 30 minutes." };
const jitter = () => new Promise(r => setTimeout(r, 250 + Math.floor(Math.random() * 400)));
const redirect = (to, headers = {}) => new Response(null, { status: 303, headers: { location: to, "cache-control": "no-store", ...headers } });
const cleanName = v => String(v ?? "").replace(/[\u0000-\u001f<>"]/g, "").replace(/\s+/g, " ").trim().slice(0, 40) || null;
const day = () => new Date().toISOString().slice(0, 10);

/** The profile fields shown in Manage account. Subscription state is only looked up for a confirmed address. */
export async function profileOf(env, aid) {
  const a = await env.DB.prepare("SELECT name, email, email_id, email_verified_at, email_pending, briefing_wanted, updates_wanted, updates_opt_in FROM accounts WHERE id = ?").bind(aid).first();
  if (!a) return null;
  const sub = a.email_id && a.email_verified_at ? await env.DB.prepare("SELECT status FROM subscribers WHERE id = ?").bind(a.email_id).first() : null;
  return { name: a.name || "", email: a.email || "", emailVerified: !!a.email_verified_at, emailPending: a.email_pending || "",
    briefing: sub?.status === "active", briefingWaiting: !!a.briefing_wanted, updates: !!a.updates_opt_in, updatesWaiting: !!a.updates_wanted };
}

/** Starts (or restarts) the daily briefing for a confirmed address, recording the consent wording and how it was given. */
async function startBriefing(db, email, name, how) {
  const id = subscriberId(email), t = now();
  await db.prepare(`INSERT INTO subscribers (id, status, email, name, country, interests, consent_version, consent_text, requested_at, confirmed_at, sends)
      VALUES (?, 'active', ?, ?, '', '[]', ?, ?, ?, ?, 0)
    ON CONFLICT(id) DO UPDATE SET status = 'active', email = excluded.email, name = COALESCE(excluded.name, subscribers.name),
      consent_version = excluded.consent_version, consent_text = excluded.consent_text, confirmed_at = COALESCE(subscribers.confirmed_at, excluded.confirmed_at),
      token_hash = NULL, token_expires = NULL, suppressed_at = NULL, reason = NULL`)
    .bind(id, email, name || null, CONSENT_VERSION, `${BRIEFING_CONSENT} (${how})`, t, t).run();
}

/**
 * Reserves one account email if the per-account throttle (one a minute; three confirmation and five sign-in emails a
 * day, counted separately), the per-kind daily cap and the site-wide daily cap allow it.
 * Returns "ok", "throttled" or "capped". Call before changing any token, so a refused request changes nothing.
 */
async function reserveMail(env, aid, kind) {
  const db = env.DB, col = kind === "login" ? ["login_window_start", "login_sends", "login_last"] : ["mail_window_start", "mail_sends", "mail_last"];
  const a = await db.prepare(`SELECT ${col[0]} AS ws, ${col[1]} AS n, ${col[2]} AS last FROM accounts WHERE id = ?`).bind(aid).first();
  const t = Date.now(), inWindow = a?.ws && t - Date.parse(a.ws) < 864e5, sends = inWindow ? (a.n || 0) : 0;
  const perDay = kind === "login" ? 5 : 3;
  if ((a?.last && t - Date.parse(a.last) < 60e3) || sends >= perDay) return "throttled";
  const d = day();
  const rows = (await db.prepare("SELECT val, n FROM stats WHERE day = ? AND dim = 'mail' AND val IN ('confirm', 'verify', 'login')").bind(d).all()).results;
  const got = v => rows.find(r => r.val === v)?.n || 0;
  if (got("confirm") >= TOTAL_CAP() || got(kind) >= KIND_CAP[kind]()) { console.warn(`account email: daily cap reached (${kind})`); return "capped"; }
  await db.batch([
    db.prepare(`UPDATE accounts SET ${col[0]} = ?, ${col[1]} = ?, ${col[2]} = ? WHERE id = ?`).bind(inWindow ? a.ws : new Date(t).toISOString(), sends + 1, new Date(t).toISOString(), aid),
    db.prepare("INSERT INTO stats (day, dim, val, n) VALUES (?, 'mail', 'confirm', 1) ON CONFLICT(day, dim, val) DO UPDATE SET n = n + 1").bind(d),
    db.prepare("INSERT INTO stats (day, dim, val, n) VALUES (?, 'mail', ?, 1) ON CONFLICT(day, dim, val) DO UPDATE SET n = n + 1").bind(d, kind)
  ]);
  return "ok";
}
const send = async msg => { try { await sendMail(msg); return "sent"; } catch (e) { console.error("account email failed:", e.message); return "failed"; } };
const mailNote = r => ({ sent: null, throttled: "We sent an email very recently. Please wait a minute and try again.",
  capped: "We've sent as many emails as we can today. Please try again tomorrow.", failed: "We couldn't send the email just now. Please try again later." })[r];

// PUT /api/account/profile { name?, email?, briefing?, updates?, resend? }
export const profile = handler(async (req, env, ctx, params, acc) => {
  const b = await body(req); if (!b) return refuse("Invalid request.");
  const db = env.DB, cur = await db.prepare("SELECT name, email, email_id, email_verified_at, email_pending FROM accounts WHERE id = ?").bind(acc.id).first();
  const notes = [];
  let name = cur.name;
  if ("name" in b) { name = cleanName(b.name); await db.prepare("UPDATE accounts SET name = ? WHERE id = ?").bind(name, acc.id).run(); }

  let verified = cur.email_verified_at ? cur.email : null, pendingNow = cur.email_pending;
  if ("email" in b) {
    const raw = String(b.email ?? "").trim();
    const want = raw ? normaliseEmail(raw) : "";
    if (raw && !want) return refuse("Enter a valid email address.");
    if (want !== (cur.email || "") || (!want && cur.email_pending) || b.resend) {
      // The email can be used to sign in, so adding, changing or removing it needs a recent passkey sign-in.
      if (Date.now() / 1000 - acc.authAt > REAUTH_S) return json(403, { error: "For your security, confirm it's you with your passkey first.", reauth: true });
      if (!want) {
        if (cur.email_id) await suppress(db, cur.email_id, "email removed from account");
        await db.batch([
          db.prepare("UPDATE accounts SET email = NULL, email_id = NULL, email_verified_at = NULL, email_pending = NULL, email_token_hash = NULL, email_token_expires = NULL, briefing_wanted = 0, updates_wanted = 0, updates_opt_in = 0 WHERE id = ?").bind(acc.id),
          db.prepare("DELETE FROM login_links WHERE account_id = ?").bind(acc.id)
        ]);
        verified = null; pendingNow = null; notes.push("Email removed.");
      } else if (want === cur.email_pending && !b.resend) {
        notes.push(`We're waiting for you to confirm ${want}.`);
      } else if (want !== cur.email || b.resend) {
        const r = await reserveMail(env, acc.id, "verify");
        if (r !== "ok") notes.push(mailNote(r));
        else {
          const { token, hash } = newOneTimeToken();
          await db.prepare("UPDATE accounts SET email_pending = ?, email_token_hash = ?, email_token_expires = ? WHERE id = ?").bind(want, hash, new Date(Date.now() + VERIFY_TTL_MS).toISOString(), acc.id).run();
          pendingNow = want;
          const url = `${SITE(req)}/api/account/email/confirm?a=${acc.id}&t=${encodeURIComponent(token)}`;
          const s = await send({ to: want, ...renderAccountEmail({ kind: "verify", url, siteUrl: SITE(req), name }) });
          notes.push(s === "sent" ? `Check ${want} for a confirmation link.` : mailNote(s));
        }
      }
    }
  }

  // With a confirmed address, the account holder is its owner and changes take effect now. Without one, they're only
  // requests: the address owner says yes or no on the confirmation page.
  if ("briefing" in b) {
    if (b.briefing === true) {
      if (verified && !pendingNow) { await startBriefing(db, verified, name, "turned on in My list account settings"); notes.push("The daily briefing will arrive each morning at 08:30 UK time."); }
      else { await db.prepare("UPDATE accounts SET briefing_wanted = 1 WHERE id = ?").bind(acc.id).run(); if (pendingNow) notes.push("You can start the briefing when you confirm your email."); }
    } else if (b.briefing === false) {
      await db.prepare("UPDATE accounts SET briefing_wanted = 0 WHERE id = ?").bind(acc.id).run();
      if (verified && cur.email_id) await suppress(db, cur.email_id, "turned off in account");
    }
  }
  if ("updates" in b) {
    if (b.updates === true) {
      if (verified && !pendingNow) await db.prepare("UPDATE accounts SET updates_opt_in = 1, updates_wanted = 0, updates_consent_at = ?, updates_consent_text = ? WHERE id = ? AND updates_opt_in = 0").bind(now(), `${UPDATES_CONSENT} (turned on in My list account settings)`, acc.id).run();
      else await db.prepare("UPDATE accounts SET updates_wanted = 1 WHERE id = ?").bind(acc.id).run();
    } else if (b.updates === false) await db.prepare("UPDATE accounts SET updates_opt_in = 0, updates_wanted = 0 WHERE id = ?").bind(acc.id).run();
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
const tick = (id, label) => `<label style="display:flex;gap:8px;align-items:flex-start;margin:0 0 10px"><input type="checkbox" name="${id}" value="yes" style="margin-top:4px"> <span>${escapeHtml(label)}</span></label>`;

// GET shows the page (with unticked email choices); POST confirms. Mail scanners open links, so GET never changes anything.
export async function confirmEmail(req, env) {
  const q = new URL(req.url).searchParams, aid = String(q.get("a") || ""), token = String(q.get("t") || "");
  const bad = () => htmlPage("Link not recognised", "<p>This link is incomplete, has expired or has already been used. You can ask for a new one from My list, under Manage account.</p>", 400);
  if (!AID.test(aid) || token.length < 20 || token.length > 100) return bad();
  const a = await env.DB.prepare("SELECT id, name, email_id, email_pending, email_token_hash, email_token_expires FROM accounts WHERE id = ?").bind(aid).first();
  if (!a?.email_pending || !a.email_token_hash || a.email_token_hash !== sha256(token) || Date.parse(a.email_token_expires) < Date.now()) return bad();
  const action = `/api/account/email/confirm?a=${aid}&amp;t=${encodeURIComponent(token)}`;
  if (req.method === "GET") return htmlPage("Confirm your email", `<form method="post" action="${action}">
<p>Press confirm to add <b>${escapeHtml(a.email_pending)}</b> to a My list account on My Cyber Learning.</p>
<p>Would you also like these emails? Leave them unticked if not. You can change your mind at any time.</p>
${tick("briefing", BRIEFING_CONSENT)}${tick("updates", UPDATES_CONSENT)}
${button("Confirm email")}</form><p style="font-size:14px;color:#4a5668">If you didn't ask for this, close this page and the address won't be added.</p>`);
  if (!sameSitePost(req)) return bad();
  const form = await req.formData().catch(() => new FormData());
  const wantsBriefing = form.get("briefing") === "yes", wantsUpdates = form.get("updates") === "yes";
  const email = a.email_pending, id = subscriberId(email), t = now();
  const inUse = () => htmlPage("Address already in use", "<p>That email address is already linked to another My list account. Sign in to that account instead, or use a different address.</p>", 409);
  if (await env.DB.prepare("SELECT 1 FROM accounts WHERE email_id = ? AND id <> ?").bind(id, aid).first()) return inUse();
  let upd;
  try {
    upd = await env.DB.prepare(`UPDATE accounts SET email = ?, email_id = ?, email_verified_at = ?, email_pending = NULL, email_token_hash = NULL, email_token_expires = NULL,
        briefing_wanted = 0, updates_wanted = 0, updates_opt_in = ?, updates_consent_at = ?, updates_consent_text = ?
      WHERE id = ? AND email_token_hash = ?`).bind(email, id, t, wantsUpdates ? 1 : 0, wantsUpdates ? t : null,
        wantsUpdates ? `${UPDATES_CONSENT} (ticked by the address owner on the confirmation page)` : null, aid, a.email_token_hash).run();
  } catch (e) { if (/UNIQUE/i.test(String(e?.message))) return inUse(); throw e; } // two accounts confirming the same address at once
  if (!(upd.meta?.changes ?? 0)) return bad();
  await env.DB.prepare("DELETE FROM login_links WHERE account_id = ?").bind(aid).run(); // links sent to an old address stop working
  // A changed address stops the briefing to the old one; the new one gets it only if its owner ticked it here.
  if (a.email_id && a.email_id !== id) await suppress(env.DB, a.email_id, "account email changed");
  if (wantsBriefing) await startBriefing(env.DB, email, a.name, "ticked by the address owner on the confirmation page");
  return redirect("/?account=email-confirmed#mylist");
}

// POST /api/account/recover/email { email }: emails a one-time sign-in link to a confirmed address.
// Answers straight away, identically for every address; the lookup and sending happen after the response.
export const requestLoginLink = handler(async (req, env, ctx) => {
  if (await limited(req, env, "recover", 5)) return json(429, { error: "Too many attempts. Please wait a minute." });
  const b = await body(req); if (!b) return refuse("Invalid request.");
  const email = normaliseEmail(b.email);
  if (!email) return refuse("Enter a valid email address.");
  const origin = SITE(req);
  const work = (async () => {
    const a = await env.DB.prepare("SELECT id, name FROM accounts WHERE email_id = ? AND email_verified_at IS NOT NULL").bind(subscriberId(email)).first();
    if (!a || (await reserveMail(env, a.id, "login")) !== "ok") return;
    const { token, hash } = newOneTimeToken();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM login_links WHERE account_id = ? AND expires < ?").bind(a.id, now()),
      env.DB.prepare("INSERT INTO login_links (token_hash, account_id, expires) VALUES (?, ?, ?)").bind(hash, a.id, new Date(Date.now() + LOGIN_TTL_MS).toISOString())
    ]);
    await send({ to: email, ...renderAccountEmail({ kind: "login", url: `${origin}/api/account/email-login?a=${a.id}&t=${encodeURIComponent(token)}`, siteUrl: origin, name: a.name }) });
  })().catch(e => console.error("sign-in link:", e.message));
  if (ctx?.waitUntil) ctx.waitUntil(work); else await work;
  await jitter();
  return json(202, GENERIC_LINK);
});

// GET shows a button; POST signs in (once), ends other sessions and goes to My list.
export async function emailLogin(req, env) {
  const q = new URL(req.url).searchParams, aid = String(q.get("a") || ""), token = String(q.get("t") || "");
  const bad = () => htmlPage("Link not recognised", "<p>This sign-in link has expired or has already been used. Ask for a new one from My list.</p>", 400);
  if (!AID.test(aid) || token.length < 20 || token.length > 100) return bad();
  const hash = sha256(token);
  const link = await env.DB.prepare("SELECT account_id, expires FROM login_links WHERE token_hash = ?").bind(hash).first();
  if (!link || link.account_id !== aid || Date.parse(link.expires) < Date.now()) return bad();
  if (req.method === "GET") return htmlPage("Sign in to My list", `<form method="post" action="/api/account/email-login?a=${aid}&amp;t=${encodeURIComponent(token)}"><p>Press the button to sign in on this device. Your other devices will be signed out.</p>${button("Sign in")}</form>`);
  if (!sameSitePost(req)) return bad();
  const used = await env.DB.prepare("DELETE FROM login_links WHERE token_hash = ? AND account_id = ? RETURNING expires").bind(hash, aid).first(); // single use
  if (!used) return bad();
  const a = await env.DB.prepare("SELECT session_gen FROM accounts WHERE id = ?").bind(aid).first();
  if (!a) return bad();
  const gen = a.session_gen + 1;
  await env.DB.batch([
    env.DB.prepare("UPDATE accounts SET session_gen = ?, last_seen = ? WHERE id = ?").bind(gen, now(), aid),
    env.DB.prepare("DELETE FROM login_links WHERE account_id = ?").bind(aid) // any other links for this account stop working too
  ]);
  return redirect("/?account=signed-in#mylist", { "set-cookie": sessionCookie(aid, gen) });
}

// One-click unsubscribe from new-feature emails (RFC 8058 POST from the mail client, or the page's button).
export const updatesUnsubUrl = (siteOrigin, aid) => `${siteOrigin}/api/account/updates/unsubscribe?a=${aid}&t=${signToken("updates-unsub", aid)}`;
export async function updatesUnsubscribe(req, env) {
  const q = new URL(req.url).searchParams, aid = String(q.get("a") || ""), token = String(q.get("t") || "");
  if (!AID.test(aid) || !verifyToken("updates-unsub", aid, token)) return htmlPage("Link not recognised", "<p>This link is incomplete or has been altered. Use the link from the most recent update email.</p>", 400);
  if (req.method === "GET") return htmlPage("Stop new-feature emails?", `<form method="post" action="/api/account/updates/unsubscribe?a=${aid}&amp;t=${encodeURIComponent(token)}"><p>We'll stop sending occasional updates about new features. Your My list account and any daily briefing aren't affected.</p>${button("Stop these emails")}</form>`);
  await env.DB.prepare("UPDATE accounts SET updates_opt_in = 0, updates_wanted = 0 WHERE id = ?").bind(aid).run();
  return htmlPage("Done", "<p>You won't get any more new-feature emails. You can turn them back on in My list, under Manage account.</p>");
}
