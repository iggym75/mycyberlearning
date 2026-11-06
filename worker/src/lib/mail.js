// Email, token and subscriber helpers shared by the Worker (confirmation emails, unsubscribe)
// and scripts/send-digest.mjs (the morning briefing). No third-party code runs on untrusted input here:
// every value placed in an email is escaped, and every link is checked to be http(s).
import { createHmac, randomBytes, createHash, timingSafeEqual } from "node:crypto";

export const CONSENT_VERSION = "2026-10-30";

/* ---------- Escaping and validation ---------- */
export const escapeHtml = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** Only absolute http(s) URLs survive; anything else (javascript:, data:, relative) becomes null. */
export function safeUrl(u) {
  try { const x = new URL(String(u)); return x.protocol === "https:" || x.protocol === "http:" ? x.href : null; } catch { return null; }
}

/** Lower-cased, trimmed email if it is plausibly valid (single @, dotted domain, no spaces/control chars, <= 254 chars). */
export function normaliseEmail(raw) {
  const e = String(raw ?? "").trim().toLowerCase();
  if (e.length > 254 || /[\s<>()\[\]\\,;:"\u0000-\u001f\u007f]/.test(e)) return null;
  const m = e.match(/^([a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64})@([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)$/);
  if (!m || m[1].startsWith(".") || m[1].endsWith(".") || m[1].includes("..")) return null;
  return e;
}

/* ---------- Keys and tokens ---------- */
function secret() {
  const s = process.env.TOKEN_SECRET;
  if (!s || s.length < 32) throw new Error("TOKEN_SECRET must be set to a random value of at least 32 characters");
  return s;
}
/** Stable, non-reversible subscriber id derived from the email, so storage keys never contain the address. */
export const subscriberId = email => createHmac("sha256", secret()).update("subscriber:" + email).digest("hex").slice(0, 40);

/** Stateless signed token for links such as unsubscribe: HMAC(purpose:id). */
export const signToken = (purpose, id) => createHmac("sha256", secret()).update(`${purpose}:${id}`).digest("base64url");
export function verifyToken(purpose, id, token) {
  if (typeof token !== "string" || typeof id !== "string" || token.length > 100) return false;
  const a = Buffer.from(signToken(purpose, id)), b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** One-time random token (for confirmation links); only its SHA-256 hash is stored. */
export function newOneTimeToken() {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: sha256(token) };
}
export const sha256 = s => createHash("sha256").update(String(s)).digest("hex");
export function hashesMatch(hexA, hexB) {
  if (typeof hexA !== "string" || typeof hexB !== "string" || hexA.length !== hexB.length) return false;
  return timingSafeEqual(Buffer.from(hexA, "hex"), Buffer.from(hexB, "hex"));
}

/* ---------- Scheduling ---------- */
/** Hour of the day in London for a given instant (handles GMT/BST). */
export function londonHour(date = new Date()) {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", hourCycle: "h23" }).format(date));
}
export function londonDate(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

/* ---------- Email templates (inline styles only; no images, scripts, tracking pixels or remote fonts) ---------- */
const C = { ink: "#0f1c2e", ink2: "#4a5668", muted: "#6c7789", line: "#d3d9e1", bg: "#f2f4f7", card: "#ffffff", signal: "#0b7a75", tag: "#d5ecea" };
const wrap = (inner, footer, preheader = "") => `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>My Cyber Learning</title></head>
<body style="margin:0;padding:0;background:${C.bg};font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;color:${C.ink}">
${preheader ? `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all">${escapeHtml(preheader)}</div>` : ""}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg}"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;background:${C.card};border:1px solid ${C.line};border-radius:10px">
<tr><td style="padding:20px 24px;border-bottom:1px solid ${C.line}"><span style="display:inline-block;background:${C.signal};color:#fff;font-weight:700;border-radius:6px;padding:3px 8px;font-size:13px">MCL</span>
<span style="font-weight:700;font-size:16px;margin-left:8px">My Cyber Learning</span></td></tr>
${inner}
</table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px"><tr><td style="padding:16px 8px;font-size:12px;line-height:1.5;color:${C.muted}">${footer}</td></tr></table>
</td></tr></table></body></html>`;

export function renderConfirmEmail({ confirmUrl, siteUrl }) {
  const url = safeUrl(confirmUrl), site = safeUrl(siteUrl);
  if (!url || !site) throw new Error("Invalid URL for confirmation email");
  const html = wrap(`<tr><td style="padding:24px">
<h1 style="font-size:22px;margin:0 0 12px">Confirm your daily briefing</h1>
<p style="font-size:15px;line-height:1.55;color:${C.ink2};margin:0 0 20px">Someone (hopefully you) asked to receive the My Cyber Learning morning briefing at this address. Press the button to confirm. The link expires in 48 hours.</p>
<p style="margin:0 0 20px"><a href="${escapeHtml(url)}" style="display:inline-block;background:${C.signal};color:#fff;text-decoration:none;font-weight:600;padding:12px 18px;border-radius:8px">Confirm subscription</a></p>
<p style="font-size:13px;color:${C.muted};margin:0">If you didn't ask for this, ignore this email and you won't hear from us again.</p></td></tr>`,
    `You received this because this address was entered at ${escapeHtml(site)}. If you don't confirm, we delete it within 7 days.`);
  const text = `Confirm your My Cyber Learning daily briefing\n\nOpen this link to confirm (expires in 48 hours):\n${url}\n\nIf you didn't ask for this, ignore this email.`;
  return { subject: "Confirm your My Cyber Learning daily briefing", html, text };
}

/**
 * Morning briefing. `shows` maps show id -> display name. `interests` (domain keys) moves matching items first.
 * All digest text is escaped; links are kept only if http(s).
 */
export function renderDigestEmail({ digest, shows, siteUrl, unsubscribeUrl, name, interests = [] }) {
  const site = safeUrl(siteUrl), unsub = safeUrl(unsubscribeUrl);
  if (!site || !unsub) throw new Error("Invalid site or unsubscribe URL");
  const dateLabel = new Date(digest.date + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  const hit = d => (d || []).some(x => interests.includes(x));
  const order = (a, b) => (hit(b.domains) - hit(a.domains));
  const stories = [...(digest.topStories || [])].sort(order);
  const episodes = [...(digest.episodes || [])].sort((a, b) => order(a, b) || (!!b.core - !!a.core));
  const byRef = Object.fromEntries((digest.episodes || []).map(e => [e.ref, e]));
  const greet = name ? `Good morning, ${escapeHtml(name)}.` : "Good morning.";
  const archive = new URL(`#news`, site).href;
  const quiet = (digest.quietCore || []).map(id => shows[id] || id).join(", ");

  // Deliverability: few links (each episode is linked once, from its title), no images, no tracking, a real plain-text part.
  const storyHtml = stories.map((s, i) => {
    const via = [...new Set((s.refs || []).map(r => byRef[r]).filter(Boolean).map(e => shows[e.show] || e.show))].map(escapeHtml).join(", ");
    return `<tr><td style="padding:0 24px 18px">
<table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr>
<td valign="top" style="width:30px;padding-top:1px"><div style="width:24px;height:24px;line-height:24px;border-radius:12px;background:${C.signal};color:#fff;font-size:13px;font-weight:700;text-align:center">${i + 1}</div></td>
<td valign="top"><div style="font-size:18px;line-height:1.3;font-weight:700;color:${C.ink};margin:0 0 4px">${escapeHtml(s.title)}</div>
<div style="font-size:14px;line-height:1.55;color:${C.ink2}">${escapeHtml(s.summary)}</div>
${via ? `<div style="font-size:12px;color:${C.muted};margin-top:4px">Covered by ${via}</div>` : ""}</td></tr></table></td></tr>`;
  }).join("");

  const epHtml = episodes.map(e => {
    const u = safeUrl(e.url);
    const title = u ? `<a href="${escapeHtml(u)}" style="color:${C.ink};text-decoration:underline">${escapeHtml(e.title)}</a>` : escapeHtml(e.title);
    return `<tr><td style="padding:12px 24px;border-top:1px solid ${C.line}">
<div style="font-size:16px;font-weight:700;color:${C.signal};margin:0 0 2px">${escapeHtml(shows[e.show] || e.show)}${e.minutes ? `<span style="font-size:12px;font-weight:400;color:${C.muted}"> · ${Number(e.minutes) | 0} min</span>` : ""}</div>
<div style="font-size:15px;font-weight:600;margin:0 0 4px">${title}</div>
<div style="font-size:14px;line-height:1.5;color:${C.ink2}">${escapeHtml(e.summary)}</div></td></tr>`;
  }).join("");

  const empty = `<tr><td style="padding:0 24px 20px;font-size:14px;color:${C.ink2}">No new episodes from the news podcasts since the last briefing. Back tomorrow.</td></tr>`;
  const html = wrap(`<tr><td style="padding:24px 24px 8px">
<div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:${C.muted}">Daily briefing · ${escapeHtml(dateLabel)}</div>
<h1 style="font-size:22px;line-height:1.25;margin:6px 0 10px">${escapeHtml(digest.headline || "Today in cyber security")}</h1>
<p style="font-size:15px;line-height:1.55;color:${C.ink2};margin:0 0 8px">${greet} ${escapeHtml(digest.overview || "")}</p></td></tr>
${stories.length ? `<tr><td style="padding:14px 24px 12px"><div style="font-size:20px;font-weight:800;color:${C.ink};border-left:4px solid ${C.signal};padding-left:10px">Top stories</div></td></tr>${storyHtml}` : ""}
${episodes.length ? `<tr><td style="padding:14px 24px 10px"><div style="font-size:20px;font-weight:800;color:${C.ink};border-left:4px solid ${C.signal};padding-left:10px">New episodes since the last briefing</div></td></tr>${epHtml}` : empty}${quiet ? `<tr><td style="padding:8px 24px 0;font-size:13px;color:${C.muted}">No new episode from: ${escapeHtml(quiet)}.</td></tr>` : ""}
<tr><td style="padding:16px 24px 24px;border-top:1px solid ${C.line}"><a href="${escapeHtml(archive)}" style="color:${C.signal};font-size:14px">Read on the website</a></td></tr>`,
    `Summaries are written by My Cyber Learning from each show's public episode notes; listen to the shows for the full story.<br>
You're receiving this because you subscribed at ${escapeHtml(site)}. <a href="${escapeHtml(unsub)}" style="color:${C.muted}">Unsubscribe</a> (one click, no login).`, digest.overview || "");

  const text = [`My Cyber Learning, daily briefing, ${dateLabel}`, "", digest.headline || "", "", `${name ? `Good morning, ${name}.` : "Good morning."} ${digest.overview || ""}`, "",
    ...(stories.length ? ["Top stories", ...stories.map((s, i) => `${i + 1}. ${s.title}\n   ${s.summary}`), ""] : []),
    ...(episodes.length ? ["New episodes since the last briefing", ...episodes.map(e => `- ${shows[e.show] || e.show}: ${e.title}${e.minutes ? ` (${e.minutes} min)` : ""}\n  ${e.summary}\n  ${safeUrl(e.url) || ""}`)] : ["No new episodes since the last briefing."]),
    "", `Website: ${archive}`, `Unsubscribe: ${unsub}`].join("\n");
  return { subject: digestSubject(digest.headline, dateLabel), html, text };
}

/** "MCL Daily Briefing: <headline>", kept under ~90 characters and cut at a word, not mid-word (long subjects score worse with spam filters). */
export function digestSubject(headline, dateLabel) {
  const prefix = "MCL Daily Briefing: ";
  let h = String(headline || dateLabel || "").replace(/\s+/g, " ").trim();
  const room = 90 - prefix.length;
  if (h.length > room) h = h.slice(0, room).replace(/\s+\S*$/, "").replace(/[,;:\s]+$/, "") + "…";
  return prefix + h;
}

/* ---------- Sending (Resend or Brevo HTTP API; no SDK) ---------- */
/** "My Cyber Learning <briefing@example.com>" -> { name, email } */
export function parseFrom(from) {
  const m = String(from || "").match(/^\s*(?:"?([^"<]*?)"?\s*)?<([^>]+)>\s*$/);
  const email = normaliseEmail(m ? m[2] : from);
  return email ? { name: (m?.[1] || "").trim() || "My Cyber Learning", email } : null;
}
const PROVIDERS = {
  // Resend: open and click tracking are off unless you enable them on the domain; keep them off.
  resend: (m, key) => ({
    url: "https://api.resend.com/emails",
    init: { headers: { authorization: `Bearer ${key}` },
      body: { from: `${m.from.name} <${m.from.email}>`, to: [m.to], subject: m.subject, html: m.html, text: m.text, headers: m.headers } }
  }),
  // Brevo: turn off open/click tracking in Brevo's transactional settings before using it here.
  brevo: (m, key) => ({
    url: "https://api.brevo.com/v3/smtp/email",
    init: { headers: { "api-key": key },
      body: { sender: m.from, to: [{ email: m.to }], subject: m.subject, htmlContent: m.html, textContent: m.text, headers: m.headers } }
  })
};
/**
 * Sends one message. `headers` lets digests carry List-Unsubscribe / List-Unsubscribe-Post (RFC 8058).
 * Pass `transport` in tests to avoid network calls. Throws on any non-2xx response.
 */
export async function sendMail({ to, subject, html, text, headers = {} }, { transport } = {}) {
  if (!normaliseEmail(to)) throw new Error("Invalid recipient");
  const from = parseFrom(process.env.MAIL_FROM);
  if (!from) throw new Error("MAIL_FROM is not set to a valid address");
  const message = { from, to, subject, html, text, headers };
  if (transport) return transport(message);
  const provider = PROVIDERS[(process.env.MAIL_PROVIDER || "resend").toLowerCase()];
  const key = process.env.MAIL_API_KEY;
  if (!provider) throw new Error("MAIL_PROVIDER must be resend or brevo");
  if (!key) throw new Error("MAIL_API_KEY is not set");
  const { url, init } = provider(message, key);
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(url, { method: "POST", signal: ctrl.signal, headers: { "content-type": "application/json", accept: "application/json", ...init.headers }, body: JSON.stringify(init.body) });
    if (!r.ok) throw new Error(`mail provider returned ${r.status}`); // never include the response body: it can echo addresses
    return { ok: true };
  } finally { clearTimeout(t); }
}
