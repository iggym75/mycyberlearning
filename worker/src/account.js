// Visitor accounts for "My list": passkey sign-in only (no passwords, no email), a one-time recovery code,
// and the saved items themselves.
//
// Security notes
// - Passkeys are verified in lib/webauthn.js with user verification required, so every sign-in is
//   two factors in one step (the device plus its biometric or PIN) and can't be phished to another site.
// - Ceremony challenges are random, single use (deleted on first use) and expire after 5 minutes.
// - The session is an HMAC-signed __Host- cookie (Secure, HttpOnly, SameSite=Lax, 30 days) keyed with
//   SESSION_SECRET under a "user:" purpose, so it can never be mistaken for an admin session. It carries the
//   account's session generation, which "sign out everywhere", recovery and account deletion bump.
// - Every state-changing call must be same-origin JSON (CSRF), and sign-up, sign-in and recovery are rate limited
//   per IP, with a site-wide daily cap on new accounts so automated sign-ups can't exhaust the D1 write quota.
// - Nothing personal is stored: an account is a random id, passkey public keys, a hashed recovery code and item ids.
import { createHmac, randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { json, clientIp, rateLimited } from "./lib/shared.js";
import { verifyRegistration, verifyAuthentication, challengeOf, newChallenge, ALGS, b64u, WebAuthnError } from "./lib/webauthn.js";

const COOKIE = "__Host-mcl_user";
const SESSION_TTL_S = 30 * 24 * 3600;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MAX_ITEMS = 500, MAX_PASSKEYS = 10;
const RP_NAME = "My Cyber Learning";

const secret = () => {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) throw new Error("SESSION_SECRET must be set");
  return s;
};
const mac = v => createHmac("sha256", secret()).update("user:" + v).digest("base64url");
const eq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };
const now = () => new Date().toISOString();
const site = req => { try { return new URL(process.env.SITE_URL); } catch { return new URL(req.url); } };
const rp = req => { const u = site(req); return { origin: u.origin, rpId: u.hostname }; };
const hashCode = code => createHash("sha256").update("recovery:" + code).digest("hex");

const cookieHeader = (value, maxAge) => `${COOKIE}=${value}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Lax`;
const REAUTH_S = 10 * 60; // sensitive changes need a passkey (or recovery) sign-in within the last 10 minutes
const sessionCookie = (aid, gen, at = Math.floor(Date.now() / 1000)) => {
  const payload = Buffer.from(JSON.stringify({ aid, gen, at, exp: Math.floor(Date.now() / 1000) + SESSION_TTL_S })).toString("base64url");
  return cookieHeader(`${payload}.${mac(payload)}`, SESSION_TTL_S);
};
const clearCookie = cookieHeader("", 0);

function readCookie(req) {
  for (const part of (req.headers.get("cookie") || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === COOKIE) return part.slice(i + 1).trim();
  }
  return null;
}
/** The signed-in account row, or null. Checks signature, expiry and the session generation in D1. */
async function session(req, env) {
  const raw = readCookie(req);
  if (!raw) return null;
  const [payload, sig] = raw.split(".");
  if (!payload || !sig || !eq(sig, mac(payload))) return null;
  let s; try { s = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { return null; }
  if (!s?.aid || !s.exp || s.exp < Date.now() / 1000) return null;
  const acc = await env.DB.prepare("SELECT id, created_at, session_gen, list_seen_at, recovery_hash IS NOT NULL AS has_recovery FROM accounts WHERE id = ?").bind(String(s.aid)).first();
  return acc && acc.session_gen === s.gen ? { ...acc, authAt: Number(s.at) || 0 } : null;
}

/** State-changing calls: same-origin JSON only. */
function sameOrigin(req) {
  if (req.method === "GET") return true;
  const ct = (req.headers.get("content-type") || "").toLowerCase();
  if (req.method !== "DELETE" && !ct.startsWith("application/json")) return false;
  try { return new URL(req.headers.get("origin")).origin === rp(req).origin; } catch { return false; }
}
async function limited(req, env, bucket, perMinute) {
  const ip = clientIp(req);
  if (rateLimited(`acct:${bucket}:${ip}`, perMinute, 60_000)) return true;
  if (env.ACCOUNT_LIMITER && !(await env.ACCOUNT_LIMITER.limit({ key: `${bucket}:${ip}` }).catch(() => ({ success: true }))).success) return true;
  return false;
}
const body = async req => { try { const b = await req.json(); return b && typeof b === "object" ? b : null; } catch { return null; } };
const refuse = msg => json(400, { error: msg });

/** Wraps a handler: CSRF check, then (when `needSession`) a valid session. */
const handler = (fn, { needSession = false, recentAuth = false } = {}) => async (req, env, ctx, params) => {
  if (!sameOrigin(req)) return json(403, { error: "Cross-site request refused." });
  const acc = await session(req, env);
  if (needSession && !acc) return json(401, { error: "Please sign in." }, { "set-cookie": clearCookie });
  if (acc && req.method !== "GET") {
    // Per-account write limit, so one account can't burn the database's daily write allowance.
    if (rateLimited(`acct:w:${acc.id}`, 60, 60_000) ||
        (env.ACCOUNT_LIMITER && !(await env.ACCOUNT_LIMITER.limit({ key: `w:${acc.id}` }).catch(() => ({ success: true }))).success))
      return json(429, { error: "That's a lot of changes at once. Please wait a minute." });
  }
  if (recentAuth && (!acc || Date.now() / 1000 - acc.authAt > REAUTH_S))
    return json(403, { error: "For your security, confirm it's you with your passkey first.", reauth: true });
  return fn(req, env, ctx, params, acc);
};

async function issueChallenge(env, purpose, accountId) {
  const challenge = newChallenge();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM webauthn_challenges WHERE expires < ?").bind(Date.now()),
    env.DB.prepare("INSERT INTO webauthn_challenges (challenge, purpose, account_id, expires) VALUES (?, ?, ?, ?)").bind(challenge, purpose, accountId ?? null, Date.now() + CHALLENGE_TTL_MS)
  ]);
  return challenge;
}
/** Consumes the challenge named in the credential's clientDataJSON: returns its row once, then it's gone. */
async function takeChallenge(env, credential, purposes) {
  const c = challengeOf(credential);
  if (!c) return null;
  const row = await env.DB.prepare("DELETE FROM webauthn_challenges WHERE challenge = ? RETURNING challenge, purpose, account_id, expires").bind(c).first();
  if (!row || row.expires < Date.now() || !purposes.includes(row.purpose)) return null;
  return row;
}
const newRecoveryCode = () => {
  // 26 symbols from a 31-letter alphabet without look-alikes (≈128.8 bits), shown as 6 groups for writing down.
  // Rejection sampling keeps every symbol equally likely: bytes of 248 or more (31 × 8) are discarded.
  const A = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; let s = "";
  // 0..247 >> 3 gives 0..30, each value from exactly 8 byte values.
  while (s.length < 26) for (const b of randomBytes(32)) { if (b < 248 && s.length < 26) s += A[b >> 3]; }
  return s.match(/.{1,5}/g).join("-");
};
const normCode = c => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

// POST /api/account/register/options: new account, or (signed in) add another passkey to this one.
export const registerOptions = handler(async (req, env, ctx, params, acc) => {
  if (await limited(req, env, "reg", 10)) return json(429, { error: "Too many attempts. Please wait a minute." });
  const { rpId } = rp(req);
  let userId, purpose, exclude = [];
  if (acc && Date.now() / 1000 - acc.authAt > REAUTH_S) return json(403, { error: "For your security, confirm it's you with your passkey first.", reauth: true });
  if (acc) {
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM passkeys WHERE account_id = ?").bind(acc.id).first();
    if ((n?.n || 0) >= MAX_PASSKEYS) return refuse(`You can have up to ${MAX_PASSKEYS} passkeys. Remove one first.`);
    userId = acc.id; purpose = "add";
    exclude = (await env.DB.prepare("SELECT id FROM passkeys WHERE account_id = ?").bind(acc.id).all()).results.map(r => ({ type: "public-key", id: r.id }));
  } else {
    const day = now().slice(0, 10), cap = Number(process.env.ACCOUNT_DAILY_CAP || 300);
    const made = (await env.DB.prepare("SELECT n FROM stats WHERE day = ? AND dim = 'acct' AND val = 'new'").bind(day).first())?.n || 0;
    if (made >= cap) return json(503, { error: "We've reached today's limit for new accounts. Please try again tomorrow." });
    userId = b64u.encode(randomBytes(16)); purpose = "register";
  }
  const challenge = await issueChallenge(env, purpose, userId);
  return json(200, { publicKey: {
    challenge, rp: { id: rpId, name: RP_NAME },
    user: { id: userId, name: "My Cyber Learning list", displayName: "My Cyber Learning list" },
    pubKeyCredParams: ALGS.map(alg => ({ type: "public-key", alg })),
    authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
    attestation: "none", timeout: CHALLENGE_TTL_MS, excludeCredentials: exclude
  } });
});

// POST /api/account/register/verify { credential, label? }
export const registerVerify = handler(async (req, env, ctx, params, acc) => {
  if (await limited(req, env, "reg", 10)) return json(429, { error: "Too many attempts. Please wait a minute." });
  const b = await body(req); if (!b) return refuse("Invalid request.");
  const ch = await takeChallenge(env, b.credential, acc ? ["add"] : ["register"]);
  if (!ch || (acc && ch.account_id !== acc.id)) return refuse("That request expired. Please try again.");
  if (!acc) {
    const made = (await env.DB.prepare("SELECT n FROM stats WHERE day = ? AND dim = 'acct' AND val = 'new'").bind(now().slice(0, 10)).first())?.n || 0;
    if (made >= Number(process.env.ACCOUNT_DAILY_CAP || 300)) return json(503, { error: "We've reached today's limit for new accounts. Please try again tomorrow." });
  }
  let reg;
  try { reg = await verifyRegistration(b.credential, { expectedChallenge: ch.challenge, origin: rp(req).origin, rpId: rp(req).rpId }); }
  catch (e) { if (e instanceof WebAuthnError) return refuse("Your device's passkey couldn't be verified. Please try again."); throw e; }
  if (await env.DB.prepare("SELECT 1 FROM passkeys WHERE id = ?").bind(reg.credentialId).first()) return refuse("That passkey is already registered.");
  const t = now(), label = String(b.label || "").replace(/[^\p{L}\p{N} .,'()&+-]/gu, "").trim().slice(0, 40) || null;
  const addKey = aid => env.DB.prepare("INSERT INTO passkeys (id, account_id, jwk, alg, sign_count, backed_up, label, created_at, last_used) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(reg.credentialId, aid, JSON.stringify(reg.jwk), reg.alg, reg.signCount, reg.backedUp ? 1 : 0, label, t, t);
  if (acc) {
    await addKey(acc.id).run();
    return json(200, { ok: true, added: true });
  }
  const aid = ch.account_id, code = newRecoveryCode(), day = t.slice(0, 10);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO accounts (id, created_at, last_seen, recovery_hash, session_gen, list_seen_at) VALUES (?, ?, ?, ?, 0, ?)").bind(aid, t, t, hashCode(normCode(code)), t),
    addKey(aid),
    env.DB.prepare("INSERT INTO stats (day, dim, val, n) VALUES (?, 'acct', 'new', 1) ON CONFLICT(day, dim, val) DO UPDATE SET n = n + 1").bind(day)
  ]);
  return json(200, { ok: true, recoveryCode: code }, { "set-cookie": sessionCookie(aid, 0) });
});

// POST /api/account/login/options
export const loginOptions = handler(async (req, env) => {
  if (await limited(req, env, "login", 20)) return json(429, { error: "Too many attempts. Please wait a minute." });
  const challenge = await issueChallenge(env, "login", null);
  return json(200, { publicKey: { challenge, rpId: rp(req).rpId, userVerification: "required", timeout: CHALLENGE_TTL_MS, allowCredentials: [] } });
});

// POST /api/account/login/verify { credential }
export const loginVerify = handler(async (req, env) => {
  if (await limited(req, env, "login", 20)) return json(429, { error: "Too many attempts. Please wait a minute." });
  const b = await body(req); if (!b) return refuse("Invalid request.");
  const generic = refuse("That passkey isn't recognised here. If you deleted your account, create a new one.");
  const ch = await takeChallenge(env, b.credential, ["login"]);
  if (!ch) return refuse("That request expired. Please try again.");
  let credId; try { credId = b64u.encode(b64u.decode(String(b.credential?.rawId ?? b.credential?.id ?? ""))); } catch { return generic; }
  const pk = await env.DB.prepare("SELECT id, account_id, jwk, alg, sign_count FROM passkeys WHERE id = ?").bind(credId).first();
  if (!pk) return generic;
  if (b.credential?.response?.userHandle !== pk.account_id) return generic; // discoverable credentials always return it
  let res;
  try { res = await verifyAuthentication(b.credential, { expectedChallenge: ch.challenge, origin: rp(req).origin, rpId: rp(req).rpId, jwk: JSON.parse(pk.jwk), alg: pk.alg, storedSignCount: pk.sign_count }); }
  catch (e) { if (e instanceof WebAuthnError) return generic; throw e; }
  const t = now();
  const acc = await env.DB.prepare("SELECT session_gen FROM accounts WHERE id = ?").bind(pk.account_id).first();
  if (!acc) return generic;
  // Only if the counter hasn't moved since we read it, so two parallel sign-ins can't both pass the clone check.
  const upd = await env.DB.prepare("UPDATE passkeys SET sign_count = ?, backed_up = ?, last_used = ? WHERE id = ? AND sign_count = ?").bind(res.signCount, res.backedUp ? 1 : 0, t, pk.id, pk.sign_count).run();
  if (!(upd.meta?.changes ?? 0)) return generic;
  await env.DB.prepare("UPDATE accounts SET last_seen = ? WHERE id = ?").bind(t, pk.account_id).run();
  return json(200, { ok: true }, { "set-cookie": sessionCookie(pk.account_id, acc.session_gen) });
});

// POST /api/account/recover { code }: signs in with the recovery code, then replaces it and ends other sessions.
export const recover = handler(async (req, env) => {
  if (await limited(req, env, "recover", 5)) return json(429, { error: "Too many attempts. Please wait a minute." });
  const b = await body(req); if (!b) return refuse("Invalid request.");
  const c = normCode(b.code);
  if (c.length !== 26) return refuse("That recovery code isn't right. It has 26 letters and numbers.");
  const acc = await env.DB.prepare("SELECT id, session_gen FROM accounts WHERE recovery_hash = ?").bind(hashCode(c)).first();
  if (!acc) return refuse("That recovery code isn't right, or it has already been used.");
  const code = newRecoveryCode(), gen = acc.session_gen + 1;
  await env.DB.prepare("UPDATE accounts SET recovery_hash = ?, session_gen = ?, last_seen = ? WHERE id = ?").bind(hashCode(normCode(code)), gen, now(), acc.id).run();
  return json(200, { ok: true, recoveryCode: code }, { "set-cookie": sessionCookie(acc.id, gen) });
});

// GET /api/account: who am I, and my passkeys.
export const status = handler(async (req, env, ctx, params, acc) => {
  if (!acc) return json(200, { signedIn: false });
  const keys = (await env.DB.prepare("SELECT id, label, backed_up, created_at, last_used FROM passkeys WHERE account_id = ? ORDER BY created_at").bind(acc.id).all()).results;
  return json(200, { signedIn: true, created: acc.created_at, hasRecoveryCode: !!acc.has_recovery,
    passkeys: keys.map(k => ({ id: k.id, label: k.label, synced: !!k.backed_up, created: k.created_at, lastUsed: k.last_used })) });
});

// POST /api/account/logout { everywhere? }
export const logout = handler(async (req, env, ctx, params, acc) => {
  const b = (await body(req)) || {};
  if (acc && b.everywhere === true) await env.DB.prepare("UPDATE accounts SET session_gen = session_gen + 1 WHERE id = ?").bind(acc.id).run();
  return json(200, { ok: true }, { "set-cookie": clearCookie });
});

// POST /api/account/recovery-code: replace the recovery code (shown once).
export const newRecovery = handler(async (req, env, ctx, params, acc) => {
  const code = newRecoveryCode(), gen = acc.session_gen + 1;
  await env.DB.prepare("UPDATE accounts SET recovery_hash = ?, session_gen = ? WHERE id = ?").bind(hashCode(normCode(code)), gen, acc.id).run();
  return json(200, { ok: true, recoveryCode: code }, { "set-cookie": sessionCookie(acc.id, gen, acc.authAt) });
}, { needSession: true, recentAuth: true });

// DELETE /api/account/passkeys/:id
export const removePasskey = handler(async (req, env, ctx, params, acc) => {
  // One statement, so two parallel removals can't take an account down to no passkeys.
  const r = await env.DB.prepare("DELETE FROM passkeys WHERE id = ? AND account_id = ? AND (SELECT COUNT(*) FROM passkeys WHERE account_id = ?) > 1")
    .bind(String(params.id), acc.id, acc.id).run();
  if (!(r.meta?.changes ?? 0)) {
    const exists = await env.DB.prepare("SELECT 1 FROM passkeys WHERE id = ? AND account_id = ?").bind(String(params.id), acc.id).first();
    return exists ? refuse("This is your only passkey. Add another one first, or delete your account instead.") : json(404, { error: "Not found." });
  }
  // A removed passkey usually means a lost device: sign every other device out, keep this one signed in.
  const gen = acc.session_gen + 1;
  await env.DB.prepare("UPDATE accounts SET session_gen = ? WHERE id = ?").bind(gen, acc.id).run();
  return json(200, { ok: true }, { "set-cookie": sessionCookie(acc.id, gen, acc.authAt) });
}, { needSession: true, recentAuth: true });

// DELETE /api/account: erase the account, its passkeys and its list.
export const remove = handler(async (req, env, ctx, params, acc) => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM favourites WHERE account_id = ?").bind(acc.id),
    env.DB.prepare("DELETE FROM passkeys WHERE account_id = ?").bind(acc.id),
    env.DB.prepare("DELETE FROM webauthn_challenges WHERE account_id = ?").bind(acc.id),
    env.DB.prepare("DELETE FROM accounts WHERE id = ?").bind(acc.id)
  ]);
  return json(200, { ok: true }, { "set-cookie": clearCookie });
}, { needSession: true, recentAuth: true });

/* ---------- My list ---------- */
// "seen" for each item is the later of when it was added and when the person last opened My list.
const listRows = async (env, aid) => {
  const acc = await env.DB.prepare("SELECT list_seen_at FROM accounts WHERE id = ?").bind(aid).first();
  return (await env.DB.prepare("SELECT item_id, added_at FROM favourites WHERE account_id = ? ORDER BY added_at DESC").bind(aid).all()).results
    .map(r => ({ id: r.item_id, added: r.added_at, seen: [r.added_at, acc?.list_seen_at || ""].sort().pop() }));
};
const validIds = async (env, ids) => {
  const clean = [...new Set(ids.map(String).filter(id => /^[a-z0-9][a-z0-9-]{0,79}$/.test(id)))].slice(0, MAX_ITEMS);
  if (!clean.length) return [];
  const found = new Set();
  for (let i = 0; i < clean.length; i += 90) {
    const part = clean.slice(i, i + 90);
    const rows = (await env.DB.prepare(`SELECT id FROM items WHERE hidden = 0 AND id IN (${part.map(() => "?").join(",")})`).bind(...part).all()).results;
    rows.forEach(r => found.add(r.id));
  }
  return clean.filter(id => found.has(id));
};

// GET /api/account/list
export const list = handler(async (req, env, ctx, params, acc) => json(200, { items: await listRows(env, acc.id) }), { needSession: true });

// PUT / DELETE /api/account/list/:id
export const listItem = handler(async (req, env, ctx, params, acc) => {
  const id = String(params.id);
  if (req.method === "DELETE") {
    await env.DB.prepare("DELETE FROM favourites WHERE account_id = ? AND item_id = ?").bind(acc.id, id).run();
    return json(200, { ok: true });
  }
  if (!(await validIds(env, [id])).length) return json(404, { error: "Not found." });
  const n = (await env.DB.prepare("SELECT COUNT(*) AS n FROM favourites WHERE account_id = ?").bind(acc.id).first())?.n || 0;
  if (n >= MAX_ITEMS) return refuse(`Your list can hold up to ${MAX_ITEMS} items.`);
  const t = now();
  await env.DB.prepare("INSERT INTO favourites (account_id, item_id, added_at) VALUES (?, ?, ?) ON CONFLICT(account_id, item_id) DO NOTHING").bind(acc.id, id, t).run();
  return json(200, { ok: true });
}, { needSession: true });

// POST /api/account/list/merge { items: [{ id, added? }] }: adds what was saved on this device before signing in.
export const merge = handler(async (req, env, ctx, params, acc) => {
  const b = await body(req); if (!b || !Array.isArray(b.items) || b.items.length > MAX_ITEMS) return refuse("Invalid request.");
  const have = new Set((await listRows(env, acc.id)).map(r => r.id));
  const ids = (await validIds(env, b.items.map(x => x?.id))).filter(id => !have.has(id)).slice(0, Math.max(0, MAX_ITEMS - have.size));
  const t = now();
  if (ids.length) await env.DB.batch(ids.map(id => env.DB.prepare("INSERT INTO favourites (account_id, item_id, added_at) VALUES (?, ?, ?) ON CONFLICT(account_id, item_id) DO NOTHING").bind(acc.id, id, t)));
  return json(200, { ok: true, added: ids.length, items: await listRows(env, acc.id) });
}, { needSession: true });

// POST /api/account/list/seen: marks everything as seen now (clears the "new" badges).
export const seen = handler(async (req, env, ctx, params, acc) => {
  await env.DB.prepare("UPDATE accounts SET list_seen_at = ? WHERE id = ?").bind(now(), acc.id).run(); // one row, however long the list
  return json(200, { ok: true });
}, { needSession: true });

// GET /api/account/export: everything we hold for this account, as JSON.
export const exportData = handler(async (req, env, ctx, params, acc) => {
  const keys = (await env.DB.prepare("SELECT id, label, alg, backed_up, created_at, last_used FROM passkeys WHERE account_id = ?").bind(acc.id).all()).results;
  return json(200, { account: { created: acc.created_at }, passkeys: keys.map(k => ({ ...k, publicKeyOnly: true })), list: await listRows(env, acc.id) },
    { "content-disposition": 'attachment; filename="my-cyber-learning-list.json"' });
}, { needSession: true });
