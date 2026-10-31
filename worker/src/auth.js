// Admin sign-in with GitHub (OAuth app), replacing Static Web Apps' built-in auth.
//
// - Only GitHub user ids listed in ADMIN_GITHUB_IDS become admins (ids, not logins: logins can be renamed).
// - The session is a signed, expiring cookie (HMAC-SHA256 with TOKEN_SECRET): __Host- prefix, Secure, HttpOnly,
//   SameSite=Strict, 8 hours. Nothing about the session is stored server-side.
// - The OAuth `state` is a random value held in a short-lived cookie and compared in constant time.
// - The GitHub access token is used once to read the user id, then revoked.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { json } from "./lib/shared.js";

const SESSION_COOKIE = "__Host-mcl_admin";
const STATE_COOKIE = "__Host-mcl_oauth";
const SESSION_TTL_S = 8 * 3600;
const b64u = s => Buffer.from(s).toString("base64url");
const secret = () => {
  const s = process.env.TOKEN_SECRET;
  if (!s || s.length < 32) throw new Error("TOKEN_SECRET must be set");
  return s;
};
const mac = v => createHmac("sha256", secret()).update("session:" + v).digest("base64url");
const eq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };
const adminIds = () => String(process.env.ADMIN_GITHUB_IDS || "").split(/[,\s]+/).filter(s => /^\d+$/.test(s));

export function cookies(req) {
  const out = {};
  for (const part of (req.headers.get("cookie") || "").split(";")) {
    const i = part.indexOf("="); if (i < 0) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
const setCookie = (name, value, maxAge) => `${name}=${value}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=${name === STATE_COOKIE ? "Lax" : "Strict"}`;

/** The signed-in admin, or null. Re-checks the allow-list on every request, so removing an id takes effect at once. */
export function adminSession(req) {
  const raw = cookies(req)[SESSION_COOKIE];
  if (!raw) return null;
  const [payload, sig] = raw.split(".");
  if (!payload || !sig) return null;
  try {
    if (!eq(sig, mac(payload))) return null;
    const s = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!s.exp || s.exp < Date.now() / 1000 || !adminIds().includes(String(s.uid))) return null;
    return s;
  } catch { return null; }
}
export const isAdmin = req => !!adminSession(req);

const siteOrigin = req => {
  try { return new URL(process.env.SITE_URL).origin; } catch { return new URL(req.url).origin; }
};
const redirect = (to, extra = []) => {
  const h = new Headers({ location: to, "cache-control": "no-store" });
  for (const c of extra) h.append("set-cookie", c);
  return new Response(null, { status: 302, headers: h });
};
const page = (title, msg, status) => new Response(`<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;max-width:520px;margin:12vh auto;padding:0 16px"><h1 style="font-size:22px">${title}</h1><p>${msg}</p><p><a href="/">Back to My Cyber Learning</a></p>`,
  { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'" } });

// GET /auth/login → GitHub
export function login(req) {
  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID;
  if (!clientId) return page("Sign-in isn't set up", "GITHUB_OAUTH_CLIENT_ID is missing.", 500);
  const origin = new URL(req.url).origin;
  const state = randomBytes(24).toString("base64url");
  const u = new URL("https://github.com/login/oauth/authorize");
  u.search = new URLSearchParams({ client_id: clientId, redirect_uri: `${origin}/auth/callback`, state, allow_signup: "false" }).toString();
  return redirect(u.href, [setCookie(STATE_COOKIE, state, 600)]);
}

// GET /auth/callback?code&state ← GitHub
export async function callback(req) {
  const url = new URL(req.url), code = url.searchParams.get("code") || "", state = url.searchParams.get("state") || "";
  const expected = cookies(req)[STATE_COOKIE];
  const clear = setCookie(STATE_COOKIE, "", 0);
  if (!code || !state || !expected || !eq(state, expected)) return page("Sign-in failed", "The sign-in link expired or didn't match. Start again from /admin.", 400);
  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID, clientSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET;
  const tr = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST", headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: `${url.origin}/auth/callback` })
  });
  const tok = (await tr.json().catch(() => ({}))).access_token;
  if (!tok) return page("Sign-in failed", "GitHub didn't accept the sign-in. Try again.", 400);
  const ur = await fetch("https://api.github.com/user", { headers: { authorization: `Bearer ${tok}`, accept: "application/vnd.github+json", "user-agent": "mycyberlearning" } });
  const user = await ur.json().catch(() => ({}));
  // Revoke the token: we only needed it to read the user id.
  fetch(`https://api.github.com/applications/${clientId}/token`, {
    method: "DELETE", headers: { authorization: "Basic " + btoa(`${clientId}:${clientSecret}`), accept: "application/vnd.github+json", "user-agent": "mycyberlearning", "content-type": "application/json" },
    body: JSON.stringify({ access_token: tok })
  }).catch(() => {});
  if (!user?.id || !adminIds().includes(String(user.id))) return page("Not an admin", "This GitHub account isn't on the admin list for this site.", 403);
  const payload = b64u(JSON.stringify({ uid: user.id, login: String(user.login || "").slice(0, 60), exp: Math.floor(Date.now() / 1000) + SESSION_TTL_S }));
  return redirect("/", [clear, setCookie(SESSION_COOKIE, `${payload}.${mac(payload)}`, SESSION_TTL_S)]);
}

// GET /auth/logout
export const logout = () => redirect("/", [setCookie(SESSION_COOKIE, "", 0)]);

// GET /api/me
export function me(req) {
  const s = adminSession(req);
  return json(200, s ? { admin: true, login: s.login } : { admin: false });
}

/** Admin guard: signed-in admin, and state-changing calls must be same-origin JSON (CSRF protection). */
export function guard(fn) {
  return async (req, env, ctx, params) => {
    if (!isAdmin(req)) return json(403, { error: "Admins only." });
    if (req.method !== "GET") {
      if (!(req.headers.get("content-type") || "").toLowerCase().startsWith("application/json") && req.method !== "DELETE") return json(415, { error: "Send JSON." });
      const origin = req.headers.get("origin");
      let ok = false;
      try { const o = new URL(origin).origin; ok = o === siteOrigin(req) || o === new URL(req.url).origin; } catch { ok = false; }
      if (!ok) return json(403, { error: "Cross-site request refused." });
    }
    return fn(req, env, ctx, params);
  };
}
