// Passkey accounts and My list, end to end against the Worker and a local SQLite copy of the schema.
// A small software authenticator below makes real ES256, Ed25519 and RS256 credentials, so the
// cryptographic checks in worker/src/lib/webauthn.js run exactly as they would against a phone or laptop.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { webcrypto as wc, createHash, createHmac } from "node:crypto";
import { localD1 } from "../d1.mjs";
import worker from "../../worker/src/index.js";
import { insertItem } from "../../worker/src/lib/db.js";
import { decodeCbor, derToRaw, b64u } from "../../worker/src/lib/webauthn.js";

const SITE = "https://mycyberlearning.co.uk", RP_ID = "mycyberlearning.co.uk";
let db, env;
const ctx = { waitUntil: p => p };

before(async () => {
  db = await localD1(":memory:");
  env = { DB: db, ASSETS: { fetch: () => new Response("static") }, SITE_URL: SITE, SESSION_SECRET: "z".repeat(48), TOKEN_SECRET: "t".repeat(48), VOTE_SALT: "s".repeat(40) };
  globalThis.fetch = async u => { throw new Error("unexpected fetch " + u); };
  for (const id of ["darknet-diaries", "risky-business", "hacking-book"]) await insertItem(db, { id, type: "podcast", name: id, desc: "x", domains: ["news"] });
  await insertItem(db, { id: "hidden-one", type: "podcast", name: "h", desc: "x", domains: ["news"], hidden: true });
});

let ipN = 0;
const call = (path, { method = "GET", body, cookie, origin = SITE, ip } = {}) => worker.fetch(new Request(SITE + path, {
  method, body: body ? JSON.stringify(body) : undefined,
  headers: { "cf-connecting-ip": ip || `198.51.100.${(ipN++ % 200) + 1}`, ...(body ? { "content-type": "application/json" } : {}), ...(method !== "GET" && origin ? { origin } : {}), ...(cookie ? { cookie } : {}) }
}), env, ctx);
const cookieOf = r => (r.headers.getSetCookie?.() || []).map(c => c.split(";")[0]).find(c => c.startsWith("__Host-mcl_user="));

/* ---------- a tiny CBOR encoder and a software authenticator ---------- */
function cbor(v) {
  const head = (major, n) => n < 24 ? [major << 5 | n] : n < 256 ? [major << 5 | 24, n] : n < 65536 ? [major << 5 | 25, n >> 8, n & 255] : [major << 5 | 26, n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255];
  if (typeof v === "number") return Uint8Array.from(v >= 0 ? head(0, v) : head(1, -1 - v));
  if (typeof v === "string") { const b = new TextEncoder().encode(v); return Uint8Array.from([...head(3, b.length), ...b]); }
  if (v instanceof Uint8Array) return Uint8Array.from([...head(2, v.length), ...v]);
  if (v instanceof Map) { const parts = [Uint8Array.from(head(5, v.size))]; for (const [k, x] of v) parts.push(cbor(k), cbor(x)); return cat(...parts); }
  throw new Error("cbor: unsupported");
}
const cat = (...p) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
const sha = b => new Uint8Array(createHash("sha256").update(b).digest());
const u32 = n => Uint8Array.from([n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255]);
const fromB64u = s => new Uint8Array(Buffer.from(s, "base64url"));

async function makeAuthenticator(alg = -7) {
  const params = { [-7]: { name: "ECDSA", namedCurve: "P-256" }, [-8]: { name: "Ed25519" }, [-257]: { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" } }[alg];
  const keys = await wc.subtle.generateKey(params, true, ["sign", "verify"]);
  const jwk = await wc.subtle.exportKey("jwk", keys.publicKey);
  const cose = alg === -7 ? new Map([[1, 2], [3, -7], [-1, 1], [-2, fromB64u(jwk.x)], [-3, fromB64u(jwk.y)]])
    : alg === -8 ? new Map([[1, 1], [3, -8], [-1, 6], [-2, fromB64u(jwk.x)]])
    : new Map([[1, 3], [3, -257], [-1, fromB64u(jwk.n)], [-2, fromB64u(jwk.e)]]);
  const credId = wc.getRandomValues(new Uint8Array(32));
  const a = { alg, counter: 0, credId, userHandle: null, flags: 0x05 /* UP+UV */, origin: SITE, rpId: RP_ID, type: undefined };
  a.create = (opts, { badChallenge, flags } = {}) => {
    const pk = opts.publicKey; a.userHandle = pk.user.id;
    const clientDataJSON = new TextEncoder().encode(JSON.stringify({ type: a.type || "webauthn.create", challenge: badChallenge || pk.challenge, origin: a.origin, crossOrigin: false }));
    const authData = cat(sha(new TextEncoder().encode(a.rpId)), Uint8Array.of((flags ?? a.flags) | 0x40), u32(a.counter), new Uint8Array(16), Uint8Array.of(0, credId.length), credId, cbor(cose));
    const attestationObject = cbor(new Map([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]));
    return { id: b64u.encode(credId), rawId: b64u.encode(credId), type: "public-key", response: { clientDataJSON: b64u.encode(clientDataJSON), attestationObject: b64u.encode(attestationObject) } };
  };
  a.get = async (opts, { flags, counter, origin } = {}) => {
    const pk = opts.publicKey;
    if (counter !== undefined) a.counter = counter;
    const clientDataJSON = new TextEncoder().encode(JSON.stringify({ type: "webauthn.get", challenge: pk.challenge, origin: origin || a.origin }));
    const authData = cat(sha(new TextEncoder().encode(a.rpId)), Uint8Array.of(flags ?? a.flags), u32(a.counter));
    const signed = cat(authData, sha(clientDataJSON));
    let sig = new Uint8Array(await wc.subtle.sign(alg === -7 ? { name: "ECDSA", hash: "SHA-256" } : params, keys.privateKey, signed));
    if (alg === -7) sig = rawToDer(sig);
    return { id: b64u.encode(credId), rawId: b64u.encode(credId), type: "public-key", response: { clientDataJSON: b64u.encode(clientDataJSON), authenticatorData: b64u.encode(authData), signature: b64u.encode(sig), userHandle: a.userHandle } };
  };
  return a;
}
function rawToDer(raw) {
  const int = b => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; b = b.slice(i); return b[0] & 0x80 ? cat(Uint8Array.of(0), b) : b; };
  const r = int(raw.slice(0, 32)), s = int(raw.slice(32));
  const body = cat(Uint8Array.of(2, r.length), r, Uint8Array.of(2, s.length), s);
  return cat(Uint8Array.of(0x30, body.length), body);
}

async function register(a, { cookie } = {}) {
  const opts = await (await call("/api/account/register/options", { method: "POST", body: {}, cookie })).json();
  const r = await call("/api/account/register/verify", { method: "POST", body: { credential: a.create(opts), label: "Test device" }, cookie });
  return { r, data: await r.json(), cookie: cookieOf(r) };
}
async function login(a, getOpts = {}) {
  const opts = await (await call("/api/account/login/options", { method: "POST", body: {} })).json();
  const r = await call("/api/account/login/verify", { method: "POST", body: { credential: await a.get(opts, getOpts) } });
  return { r, data: await r.json(), cookie: cookieOf(r) };
}

/* ---------- tests ---------- */
test("CBOR decoder: strict and bounded", () => {
  assert.deepEqual(decodeCbor(cbor(new Map([[1, 2], ["a", new Uint8Array([9])]]))).value, new Map([[1, 2], ["a", new Uint8Array([9])]]));
  assert.throws(() => decodeCbor(Uint8Array.of(0x9f)), /indefinite/);                       // indefinite array
  assert.throws(() => decodeCbor(Uint8Array.of(0x5a, 0xff, 0xff, 0xff, 0xff)), /truncated/);  // 4 GB byte string claim
  assert.throws(() => decodeCbor(Uint8Array.of(0xa2, 1, 1, 1, 2)), /duplicate/);
  assert.throws(() => decodeCbor(Uint8Array.of(0xc0, 0)), /tags/);
  assert.equal(derToRaw(rawToDer(new Uint8Array(64).fill(0x80))).length, 64);
});

for (const [alg, name] of [[-7, "ES256"], [-8, "Ed25519"], [-257, "RS256"]]) {
  test(`register and sign in with a ${name} passkey`, async () => {
    const a = await makeAuthenticator(alg);
    const reg = await register(a);
    assert.equal(reg.r.status, 200, JSON.stringify(reg.data));
    assert.match(reg.data.recoveryCode, /^[A-Z2-9]{5}(-[A-Z2-9]{1,5}){5}$/);
    assert.ok(reg.cookie);
    const me = await (await call("/api/account", { cookie: reg.cookie })).json();
    assert.equal(me.signedIn, true); assert.equal(me.passkeys.length, 1); assert.equal(me.passkeys[0].label, "Test device");
    const li = await login(a);
    assert.equal(li.r.status, 200, JSON.stringify(li.data));
    assert.ok(li.cookie);
  });
}

test("registration is refused for a wrong origin, rpId, reused or unknown challenge, or no user verification", async () => {
  const bad = async (mutate, extra) => {
    const a = await makeAuthenticator(); mutate(a);
    const opts = await (await call("/api/account/register/options", { method: "POST", body: {} })).json();
    const r = await call("/api/account/register/verify", { method: "POST", body: { credential: a.create(opts, extra) } });
    return r.status;
  };
  assert.equal(await bad(a => { a.origin = "https://evil.example"; }), 400);
  assert.equal(await bad(a => { a.rpId = "evil.example"; }), 400);
  assert.equal(await bad(a => { a.type = "webauthn.get"; }), 400);
  assert.equal(await bad(() => {}, { flags: 0x01 }), 400);                                   // user present but not verified
  assert.equal(await bad(() => {}, { badChallenge: b64u.encode(new Uint8Array(32)) }), 400); // never issued
  // A challenge can only be used once
  const a = await makeAuthenticator();
  const opts = await (await call("/api/account/register/options", { method: "POST", body: {} })).json();
  const cred = a.create(opts);
  assert.equal((await call("/api/account/register/verify", { method: "POST", body: { credential: cred } })).status, 200);
  assert.equal((await call("/api/account/register/verify", { method: "POST", body: { credential: cred } })).status, 400);
});

test("sign-in is refused for a wrong origin, a bad signature, no UV, or a counter that goes backwards", async () => {
  const a = await makeAuthenticator();
  await register(a);
  assert.equal((await login(a, { origin: "https://evil.example" })).r.status, 400);
  assert.equal((await login(a, { flags: 0x01 })).r.status, 400);
  // Tampered signature
  const opts = await (await call("/api/account/login/options", { method: "POST", body: {} })).json();
  const cred = await a.get(opts); const sig = fromB64u(cred.response.signature); sig[sig.length - 1] ^= 1; cred.response.signature = b64u.encode(sig);
  assert.equal((await call("/api/account/login/verify", { method: "POST", body: { credential: cred } })).status, 400);
  // Counter: 5 then 5 again (possible clone) is refused; 6 is fine
  assert.equal((await login(a, { counter: 5 })).r.status, 200);
  assert.equal((await login(a, { counter: 5 })).r.status, 400);
  assert.equal((await login(a, { counter: 6 })).r.status, 200);
  // An assertion can't be replayed (its challenge is consumed)
  const o2 = await (await call("/api/account/login/options", { method: "POST", body: {} })).json();
  a.counter = 7; const c2 = await a.get(o2);
  assert.equal((await call("/api/account/login/verify", { method: "POST", body: { credential: c2 } })).status, 200);
  assert.equal((await call("/api/account/login/verify", { method: "POST", body: { credential: c2 } })).status, 400);
});

test("state-changing calls must be same-origin JSON; list calls need a session", async () => {
  assert.equal((await call("/api/account/register/options", { method: "POST", body: {}, origin: "https://evil.example" })).status, 403);
  assert.equal((await call("/api/account/register/options", { method: "POST", body: {}, origin: null })).status, 403);
  assert.equal((await call("/api/account/list")).status, 401);
  assert.equal((await call("/api/account/list/darknet-diaries", { method: "PUT", body: {} })).status, 401);
  assert.deepEqual(await (await call("/api/account")).json(), { signedIn: false });
  // A forged or admin-purpose cookie isn't a user session
  const forged = "__Host-mcl_user=" + Buffer.from(JSON.stringify({ aid: "x", gen: 0, exp: 9e9 })).toString("base64url") + ".AAAA";
  assert.equal((await call("/api/account/list", { cookie: forged })).status, 401);
});

test("My list: add, refuse hidden or unknown items, merge from the device, mark seen, remove, export", async () => {
  const a = await makeAuthenticator(); const { cookie } = await register(a);
  assert.equal((await call("/api/account/list/darknet-diaries", { method: "PUT", body: {}, cookie })).status, 200);
  assert.equal((await call("/api/account/list/darknet-diaries", { method: "PUT", body: {}, cookie })).status, 200); // idempotent
  assert.equal((await call("/api/account/list/hidden-one", { method: "PUT", body: {}, cookie })).status, 404);
  assert.equal((await call("/api/account/list/no-such-thing", { method: "PUT", body: {}, cookie })).status, 404);
  const m = await (await call("/api/account/list/merge", { method: "POST", body: { items: [{ id: "risky-business" }, { id: "darknet-diaries" }, { id: "hidden-one" }, { id: "../etc" }] }, cookie })).json();
  assert.equal(m.added, 1);
  assert.deepEqual(m.items.map(i => i.id).sort(), ["darknet-diaries", "risky-business"]);
  assert.equal((await call("/api/account/list/seen", { method: "POST", body: {}, cookie })).status, 200);
  assert.equal((await call("/api/account/list/risky-business", { method: "DELETE", cookie })).status, 200);
  const l = await (await call("/api/account/list", { cookie })).json();
  assert.deepEqual(l.items.map(i => i.id), ["darknet-diaries"]);
  const ex = await call("/api/account/export", { cookie });
  assert.match(ex.headers.get("content-disposition"), /attachment/);
  const data = await ex.json();
  assert.equal(data.list.length, 1); assert.ok(!JSON.stringify(data).includes('"jwk"'));
});

test("second passkey, removing passkeys, recovery code, sign out everywhere, delete account", async () => {
  const a = await makeAuthenticator(), b = await makeAuthenticator(-8);
  const first = await register(a);
  let cookie = first.cookie;
  // Add a second passkey while signed in (same account)
  const added = await register(b, { cookie });
  assert.equal(added.r.status, 200); assert.equal(added.data.added, true);
  let me = await (await call("/api/account", { cookie })).json();
  assert.equal(me.passkeys.length, 2);
  assert.equal((await login(b)).r.status, 200);
  // Removing a passkey signs every other device out but keeps this one signed in
  const otherDevice = (await login(a)).cookie;
  const rm = await call(`/api/account/passkeys/${encodeURIComponent(me.passkeys[1].id)}`, { method: "DELETE", cookie });
  assert.equal(rm.status, 200);
  assert.equal((await call("/api/account/list", { cookie: otherDevice })).status, 401);
  cookie = cookieOf(rm);
  me = await (await call("/api/account", { cookie })).json();
  // Can't remove the last passkey
  assert.equal((await call(`/api/account/passkeys/${encodeURIComponent(me.passkeys[0].id)}`, { method: "DELETE", cookie })).status, 400);
  // Recovery code signs in once, replaces itself and ends other sessions
  const rc = await call("/api/account/recover", { method: "POST", body: { code: first.data.recoveryCode.toLowerCase().replace(/-/g, " ") } });
  assert.equal(rc.status, 200);
  const rec = await rc.json(); const recCookie = cookieOf(rc);
  assert.notEqual(rec.recoveryCode, first.data.recoveryCode);
  assert.equal((await call("/api/account/list", { cookie })).status, 401);          // old session ended
  assert.equal((await call("/api/account/list", { cookie: recCookie })).status, 200);
  assert.equal((await call("/api/account/recover", { method: "POST", body: { code: first.data.recoveryCode } })).status, 400); // used up
  // Sign out everywhere
  const again = (await login(a)).cookie;
  await call("/api/account/logout", { method: "POST", body: { everywhere: true }, cookie: recCookie });
  assert.equal((await call("/api/account/list", { cookie: again })).status, 401);
  // Delete the account: data gone, passkey no longer works
  cookie = (await login(a)).cookie;
  await call("/api/account/list/darknet-diaries", { method: "PUT", body: {}, cookie });
  assert.equal((await call("/api/account", { method: "DELETE", cookie })).status, 200);
  assert.equal((await login(a)).r.status, 400);
  const left = await db.prepare("SELECT (SELECT COUNT(*) FROM favourites WHERE account_id NOT IN (SELECT id FROM accounts)) AS orphans").first();
  assert.equal(left.orphans, 0);
});

test("new accounts stop at the daily cap", async () => {
  process.env.ACCOUNT_DAILY_CAP = "1";
  try {
    const r = await call("/api/account/register/options", { method: "POST", body: {} });
    assert.equal(r.status, 503);
  } finally { delete process.env.ACCOUNT_DAILY_CAP; }
});

const mint = (aid, gen, at) => { const payload = Buffer.from(JSON.stringify({ aid, gen, at, exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url");
  return `__Host-mcl_user=${payload}.${createHmac("sha256", "z".repeat(48)).update("user:" + payload).digest("base64url")}`; };

test("sensitive changes need a passkey sign-in in the last 10 minutes", async () => {
  const a = await makeAuthenticator(); const { cookie } = await register(a);
  const aid = a.userHandle, stale = mint(aid, 0, Math.floor(Date.now() / 1000) - 3600);
  assert.equal((await call("/api/account/list", { cookie: stale })).status, 200);                       // ordinary use is fine
  for (const [path, method] of [["/api/account/register/options", "POST"], ["/api/account/recovery-code", "POST"], ["/api/account", "DELETE"]]) {
    const r = await call(path, { method, body: method === "POST" ? {} : undefined, cookie: stale });
    assert.equal(r.status, 403, path); assert.equal((await r.json()).reauth, true);
  }
  // A new recovery code (fresh session) ends other sessions
  const other = (await login(a)).cookie;
  const nc = await call("/api/account/recovery-code", { method: "POST", body: {}, cookie });
  assert.equal(nc.status, 200);
  assert.equal((await call("/api/account/list", { cookie: other })).status, 401);
  assert.equal((await call("/api/account/list", { cookie: cookieOf(nc) })).status, 200);
});

test("sign-in needs the user handle to match, and marking seen is one write", async () => {
  const a = await makeAuthenticator(); const { cookie } = await register(a);
  const opts = await (await call("/api/account/login/options", { method: "POST", body: {} })).json();
  const cred = await a.get(opts); cred.response.userHandle = null;
  assert.equal((await call("/api/account/login/verify", { method: "POST", body: { credential: cred } })).status, 400);
  await call("/api/account/list/darknet-diaries", { method: "PUT", body: {}, cookie });
  await call("/api/account/list/risky-business", { method: "PUT", body: {}, cookie });
  const r = await call("/api/account/list/seen", { method: "POST", body: {}, cookie });
  assert.equal(r.status, 200);
  const l = (await (await call("/api/account/list", { cookie })).json()).items;
  assert.ok(l.every(x => x.seen >= x.added));
  assert.equal((await call("/api/account/list/merge", { method: "POST", body: { items: Array.from({ length: 501 }, (_, i) => ({ id: "x" + i })) }, cookie })).status, 400);
});

test("malformed base64 and keys are a clean 400, not a 500", async () => {
  const a = await makeAuthenticator();
  const opts = await (await call("/api/account/register/options", { method: "POST", body: {} })).json();
  const cred = a.create(opts); cred.response.attestationObject = "abcde";
  assert.equal((await call("/api/account/register/verify", { method: "POST", body: { credential: cred } })).status, 400);
});
