// End-to-end tests for the Cloudflare Worker against a local SQLite copy of the D1 schema.
// Outbound calls (email provider, GitHub, Anthropic) are intercepted; nothing leaves the machine.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { localD1 } from "../d1.mjs";
import worker from "../../worker/src/index.js";
import { insertItem } from "../../worker/src/lib/db.js";
import { signToken, subscriberId } from "../../worker/src/lib/mail.js";

const SITE = "https://mycyberlearning.co.uk";
const TOKEN_SECRET = "t".repeat(48);
let db, env, outbox, ghUser;
const ctx = { waitUntil: p => p };

before(async () => {
  db = await localD1(":memory:");
  env = {
    DB: db, ASSETS: { fetch: () => new Response("static", { status: 200 }) },
    SITE_URL: SITE, TOKEN_SECRET, VOTE_SALT: "s".repeat(40), MAIL_FROM: "My Cyber Learning <briefing@mycyberlearning.co.uk>",
    MAIL_PROVIDER: "resend", MAIL_API_KEY: "re_test", GITHUB_OAUTH_CLIENT_ID: "cid", GITHUB_OAUTH_CLIENT_SECRET: "csecret", ADMIN_GITHUB_IDS: "1001"
  };
  outbox = []; ghUser = { id: 1001, login: "ianm" };
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u === "https://api.resend.com/emails") { outbox.push(JSON.parse(init.body)); return new Response('{"id":"x"}', { status: 200 }); }
    if (u === "https://github.com/login/oauth/access_token") return Response.json({ access_token: "gho_test" });
    if (u === "https://api.github.com/user") return Response.json(ghUser);
    if (u.startsWith("https://api.github.com/applications/")) return new Response(null, { status: 204 });
    throw new Error("unexpected fetch " + u);
  };
  await insertItem(db, { id: "darknet-diaries", type: "podcast", name: "Darknet Diaries", desc: "Stories", domains: ["stories"] });
  await insertItem(db, { id: "secret-show", type: "podcast", name: "Hidden show", desc: "x", domains: ["news"], hidden: true });
});

const call = (path, { method = "GET", body, headers = {}, ip = "203.0.113.9" } = {}) =>
  worker.fetch(new Request(SITE + path, { method, headers: { "cf-connecting-ip": ip, ...(body ? { "content-type": "application/json" } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined }), env, ctx);
async function adminCookie() {
  const login = await call("/auth/login");
  const state = new URL(login.headers.get("location")).searchParams.get("state");
  const stateCookie = login.headers.get("set-cookie").split(";")[0];
  const cb = await call(`/auth/callback?code=abc&state=${state}`, { headers: { cookie: stateCookie } });
  assert.equal(cb.status, 302);
  return cb.headers.getSetCookie().find(c => c.startsWith("__Host-mcl_admin=")).split(";")[0];
}

test("static paths go to the assets binding; unknown API paths 404; wrong method 405", async () => {
  assert.equal(await (await call("/")).text(), "static");
  assert.equal((await call("/api/nope")).status, 404);
  assert.equal((await call("/api/items", { method: "DELETE" })).status, 405);
});

test("items: public list hides hidden items and sets security headers", async () => {
  const r = await call("/api/items");
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  const { items } = await r.json();
  assert.deepEqual(items.map(i => i.id), ["darknet-diaries"]);
});

test("votes: up, switch to down, clear; tallies never negative", async () => {
  const v = dir => call("/api/vote", { method: "POST", body: { id: "darknet-diaries", dir, voterId: "browser-123456" } }).then(r => r.json());
  assert.deepEqual((await v(1)).community, { up: 1, down: 0 });
  assert.deepEqual((await v(1)).community, { up: 1, down: 0 }); // same vote twice counts once
  assert.deepEqual((await v(-1)).community, { up: 0, down: 1 });
  assert.deepEqual((await v(0)).community, { up: 0, down: 0 });
  assert.equal((await call("/api/vote", { method: "POST", body: { id: "secret-show", dir: 1, voterId: "browser-123456" } })).status, 404);
  const row = await db.prepare("SELECT voter FROM votes").all();
  assert.equal(row.results.length, 0);
});

test("submissions: validation, duplicates, honeypot, stored as pending with hashed IP", async () => {
  const bad = await call("/api/submissions", { method: "POST", body: { name: "x", desc: "short" } });
  assert.equal(bad.status, 400);
  const dup = await call("/api/submissions", { method: "POST", body: { name: "Darknet Diaries", desc: "d".repeat(50), web: "https://darknetdiaries.com", apple: "https://podcasts.apple.com/x" } });
  assert.equal(dup.status, 409);
  const js = await call("/api/submissions", { method: "POST", body: { name: "New Show", desc: "d".repeat(50), web: "javascript:alert(1)", apple: "https://podcasts.apple.com/x" } });
  assert.equal(js.status, 400);
  const ok = await call("/api/submissions", { method: "POST", body: { name: "New Show", desc: "A brand new security podcast about things.", web: "https://new.example", apple: "https://podcasts.apple.com/gb/podcast/x", email: "me@example.com", domains: ["news", "bogus"] } });
  assert.equal(ok.status, 202);
  const r = await db.prepare("SELECT * FROM submissions").first();
  assert.equal(r.status, "pending");
  assert.match(r.ip_hash, /^[a-f0-9]{64}$/);
  assert.ok(!r.ip_hash.includes("203.0.113.9"));
  assert.deepEqual(JSON.parse(r.data).domains, ["news"]);
});

test("subscribe → confirm (GET shows a button, POST confirms) → unsubscribe erases details", async () => {
  outbox.length = 0;
  const s = await call("/api/subscribe", { method: "POST", body: { email: "Reader@Example.com", name: "Sam<script>", country: "gb", interests: ["news", "bad"], consent: true } });
  assert.equal(s.status, 202);
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].from, "My Cyber Learning <briefing@mycyberlearning.co.uk>");
  const link = outbox[0].text.match(/https:\/\/\S+confirm\S+/)[0];
  const id = subscriberId("reader@example.com");
  const row = await db.prepare("SELECT * FROM subscribers WHERE id = ?").bind(id).first();
  assert.equal(row.status, "pending"); assert.equal(row.name, "Samscript"); assert.equal(row.country, "GB"); assert.equal(row.interests, '["news"]');
  assert.ok(!link.includes(row.token_hash)); // only the hash is stored
  // Re-submitting straight away sends nothing (per-address throttle) and looks identical
  const again = await call("/api/subscribe", { method: "POST", body: { email: "reader@example.com", consent: true } });
  assert.equal(again.status, 202); assert.equal(outbox.length, 1);

  const path = link.replace(SITE, "");
  const get = await call(path);
  assert.equal(get.status, 200);
  assert.match(get.headers.get("content-security-policy"), /default-src 'none'/);
  assert.equal((await db.prepare("SELECT status FROM subscribers WHERE id = ?").bind(id).first()).status, "pending");
  const post = await call(path, { method: "POST" });
  assert.equal(post.status, 303);
  assert.equal(post.headers.get("location"), "/?subscribe=confirmed#news");
  assert.equal((await db.prepare("SELECT status FROM subscribers WHERE id = ?").bind(id).first()).status, "active");

  // Already active: same response, no email
  await call("/api/subscribe", { method: "POST", body: { email: "reader@example.com", consent: true } });
  assert.equal(outbox.length, 1);

  // Tampered unsubscribe link is refused; a genuine one shows a page on GET and erases on POST
  assert.equal((await call(`/api/unsubscribe?s=${id}&t=nope`, { method: "POST" })).status, 400);
  const unsub = `/api/unsubscribe?s=${id}&t=${signToken("unsubscribe", id)}`;
  assert.equal((await call(unsub)).status, 200);
  assert.equal((await db.prepare("SELECT status FROM subscribers WHERE id = ?").bind(id).first()).status, "active");
  assert.equal((await call(unsub, { method: "POST" })).status, 200);
  const gone = await db.prepare("SELECT * FROM subscribers WHERE id = ?").bind(id).first();
  assert.equal(gone.status, "suppressed"); assert.equal(gone.email, null); assert.equal(gone.name, null);
});

test("subscribe: invalid email, missing consent, honeypot", async () => {
  assert.equal((await call("/api/subscribe", { method: "POST", body: { email: "not-an-email", consent: true }, ip: "198.51.100.1" })).status, 400);
  assert.equal((await call("/api/subscribe", { method: "POST", body: { email: "a@b.co", consent: false }, ip: "198.51.100.1" })).status, 400);
  const n = outbox.length;
  assert.equal((await call("/api/subscribe", { method: "POST", body: { email: "a@b.co", consent: true, website: "spam" }, ip: "198.51.100.1" })).status, 202);
  assert.equal(outbox.length, n);
});

test("telemetry: aggregate counters only, DNT honoured, unknown values ignored", async () => {
  const t = (body, headers = {}) => worker.fetch(new Request(SITE + "/api/t", { method: "POST", headers: { "cf-connecting-ip": "192.0.2.1", ...headers }, body: JSON.stringify(body) }), env, ctx);
  assert.equal((await t({ p: "library", tz: "Europe/London", l: "en-GB", d: "desktop", r: "www.google.com" })).status, 204);
  await t({ p: "library" }, { dnt: "1" });
  await t({ p: "evil", tz: "Mars/Base", r: "<script>" });
  const { results } = await db.prepare("SELECT dim, val, n FROM stats ORDER BY dim").all();
  assert.deepEqual(results.map(r => `${r.dim}:${r.val}:${r.n}`), ["device:desktop:1", "lang:en-GB:1", "page:library:1", "ref:google:1", "region:Europe/London:1", "total:views:1"]);
});

test("admin: refused without a session; OAuth state must match; non-admin GitHub users refused", async () => {
  assert.equal((await call("/api/admin/submissions")).status, 403);
  assert.deepEqual(await (await call("/api/me")).json(), { admin: false });
  const login = await call("/admin");
  assert.equal(login.status, 302);
  assert.match(login.headers.get("location"), /^https:\/\/github\.com\/login\/oauth\/authorize\?/);
  assert.equal((await call("/auth/callback?code=abc&state=forged", { headers: { cookie: "__Host-mcl_oauth=real" } })).status, 400);
  ghUser = { id: 2002, login: "someone-else" };
  const l2 = await call("/auth/login");
  const st = new URL(l2.headers.get("location")).searchParams.get("state");
  const cb = await call(`/auth/callback?code=abc&state=${st}`, { headers: { cookie: l2.headers.get("set-cookie").split(";")[0] } });
  assert.equal(cb.status, 403);
  ghUser = { id: 1001, login: "ianm" };
});

test("admin: forged or expired session cookies are refused", async () => {
  const payload = Buffer.from(JSON.stringify({ uid: 1001, login: "ianm", exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url");
  const forged = `__Host-mcl_admin=${payload}.AAAA`;
  assert.equal((await call("/api/admin/submissions", { headers: { cookie: forged } })).status, 403);
  const old = Buffer.from(JSON.stringify({ uid: 1001, login: "ianm", exp: 1 })).toString("base64url");
  const sig = createHmac("sha256", TOKEN_SECRET).update("session:" + old).digest("base64url");
  assert.equal((await call("/api/admin/submissions", { headers: { cookie: `__Host-mcl_admin=${old}.${sig}` } })).status, 403);
});

test("admin: queue, approve, edit (URL sanitising), CSRF checks, insights, export, erase, delete", async () => {
  const cookie = await adminCookie();
  const me = await (await call("/api/me", { headers: { cookie } })).json();
  assert.deepEqual(me, { admin: true, login: "ianm" });
  const h = { cookie, origin: SITE };
  const { items: queue } = await (await call("/api/admin/submissions", { headers: h })).json();
  assert.equal(queue.length, 1);
  // CSRF: wrong origin and non-JSON are refused
  assert.equal((await call(`/api/admin/submissions/${queue[0].id}`, { method: "POST", body: { approve: true }, headers: { cookie, origin: "https://evil.example" } })).status, 403);
  assert.equal((await worker.fetch(new Request(SITE + `/api/admin/submissions/${queue[0].id}`, { method: "POST", headers: { cookie, origin: SITE, "content-type": "text/plain" }, body: "{}" }), env, ctx)).status, 415);
  assert.equal((await call(`/api/admin/submissions/${queue[0].id}`, { method: "POST", body: { approve: true }, headers: h })).status, 200);
  const sub = await db.prepare("SELECT * FROM submissions WHERE id = ?").bind(queue[0].id).first();
  assert.equal(sub.status, "approved"); assert.equal(sub.ip_hash, null); assert.ok(!JSON.parse(sub.data).email);
  // Edit: javascript: URLs dropped, tags locked, look-alike Amazon host dropped
  const patch = await call("/api/admin/items/new-show", { method: "PATCH", body: { web: "javascript:alert(1)", amazon: "https://music.amazon.evil.com/podcasts/x", domains: ["ai", "nope"], hidden: true }, headers: h });
  const { item } = await patch.json();
  assert.equal(item.web, undefined); assert.equal(item.amazon, undefined); assert.deepEqual(item.domains, ["ai"]); assert.equal(item.tagsLocked, true); assert.equal(item.hidden, true);
  // Admin list includes hidden items
  const all = await (await call("/api/items", { headers: { cookie } })).json();
  assert.ok(all.items.some(i => i.id === "secret-show"));
  // Insights and CSV export (formula injection neutralised)
  await db.prepare("INSERT INTO subscribers (id, status, email, name, confirmed_at) VALUES ('f'||hex(randomblob(19)), 'active', 'x@y.co', '=HYPERLINK(\"evil\")', '2026-10-31T06:00:00Z')").run();
  const ins = await (await call("/api/admin/insights", { headers: h })).json();
  assert.equal(ins.subscribers.active, 1); assert.equal(ins.visits.byDay[new Date().toISOString().slice(0, 10)], 1);
  const csv = await (await call("/api/admin/subscribers/export", { headers: h })).text();
  assert.match(csv, /"'=HYPERLINK/);
  // Erasure
  const er = await (await call("/api/admin/subscribers/erase", { method: "POST", body: { email: "reader@example.com" }, headers: h })).json();
  assert.equal(er.ok, true);
  // Delete removes the item and its votes
  await call("/api/vote", { method: "POST", body: { id: "darknet-diaries", dir: 1, voterId: "browser-999999" } });
  assert.equal((await call("/api/admin/items/darknet-diaries", { method: "DELETE", headers: h })).status, 200);
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM votes").first()).n, 0);
  // Logout clears the cookie
  const out = await call("/auth/logout", { headers: { cookie } });
  assert.match(out.headers.get("set-cookie"), /__Host-mcl_admin=; .*Max-Age=0/);
});

test("removing an id from ADMIN_GITHUB_IDS revokes an existing session at once", async () => {
  const cookie = await adminCookie();
  env.ADMIN_GITHUB_IDS = "9999";
  assert.equal((await call("/api/admin/submissions", { headers: { cookie } })).status, 403);
  env.ADMIN_GITHUB_IDS = "1001";
});
