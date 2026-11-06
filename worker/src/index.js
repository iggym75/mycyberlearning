// My Cyber Learning: Cloudflare Worker entry point.
// Serves /api/*, /auth/* and /admin; everything else is a static file from frontend/dist (the ASSETS binding).
import { initEnv, json } from "./lib/shared.js";
import * as pub from "./public.js";
import * as admin from "./admin.js";
import * as news from "./news.js";
import * as auth from "./auth.js";
import * as account from "./account.js";
import { dispatchBriefing } from "./cron.js";

// [method(s), path pattern, handler]. `:id` captures one URL-encoded segment.
const ROUTES = [
  ["GET", "/api/items", pub.items],
  ["POST", "/api/vote", pub.vote],
  ["POST", "/api/submissions", pub.submit],
  ["POST", "/api/subscribe", news.subscribe],
  ["GET,POST", "/api/subscribe/confirm", news.confirm],
  ["GET,POST", "/api/unsubscribe", news.unsubscribe],
  ["POST", "/api/t", news.telemetry],
  ["GET", "/api/me", auth.me],
  ["POST", "/api/account/register/options", account.registerOptions],
  ["POST", "/api/account/register/verify", account.registerVerify],
  ["POST", "/api/account/login/options", account.loginOptions],
  ["POST", "/api/account/login/verify", account.loginVerify],
  ["POST", "/api/account/recover", account.recover],
  ["POST", "/api/account/logout", account.logout],
  ["POST", "/api/account/recovery-code", account.newRecovery],
  ["DELETE", "/api/account/passkeys/:id", account.removePasskey],
  ["GET,DELETE", "/api/account", (req, env, ctx, p) => (req.method === "DELETE" ? account.remove : account.status)(req, env, ctx, p)],
  ["GET", "/api/account/export", account.exportData],
  ["GET", "/api/account/list", account.list],
  ["POST", "/api/account/list/merge", account.merge],
  ["POST", "/api/account/list/seen", account.seen],
  ["PUT,DELETE", "/api/account/list/:id", account.listItem],
  ["GET", "/api/admin/submissions", admin.listSubmissions],
  ["POST", "/api/admin/submissions/:id", admin.decide],
  ["PATCH,DELETE", "/api/admin/items/:id", admin.item],
  ["GET", "/api/admin/insights", admin.insights],
  ["GET", "/api/admin/export", admin.exportItems],
  ["GET", "/api/admin/subscribers/export", admin.exportSubscribers],
  ["POST", "/api/admin/subscribers/erase", admin.eraseSubscriber],
  ["GET", "/auth/login", auth.login],
  ["GET", "/auth/callback", auth.callback],
  ["GET", "/auth/logout", auth.logout],
  ["GET", "/admin", auth.login]
].map(([m, p, h]) => [m.split(","), new RegExp("^" + p.replace(/:id/g, "(?<id>[^/]+)") + "$"), h]);

export function match(method, pathname) {
  let pathMatched = false;
  for (const [methods, re, handler] of ROUTES) {
    const m = pathname.match(re);
    if (!m) continue;
    pathMatched = true;
    if (methods.includes(method)) {
      let params = {};
      try { params = Object.fromEntries(Object.entries(m.groups || {}).map(([k, v]) => [k, decodeURIComponent(v)])); } catch { return { status: 400 }; }
      return { handler, params };
    }
  }
  return pathMatched ? { status: 405 } : null;
}

export default {
  async fetch(req, env, ctx) {
    initEnv(env);
    const url = new URL(req.url);
    const dynamic = url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/") || url.pathname === "/admin";
    if (!dynamic) {
      // Existing files are served before the Worker runs, so this only sees misses. A "not found" must never be
      // cached: otherwise a cover requested just before it was published stays missing for a week (_headers).
      const res = await env.ASSETS.fetch(req);
      if (res.status !== 404) return res;
      const h = new Headers(res.headers); h.set("cache-control", "no-store");
      return new Response(res.body, { status: 404, headers: h });
    }
    const hit = match(req.method, url.pathname);
    if (!hit) return json(404, { error: "Not found." });
    if (hit.status) return json(hit.status, { error: hit.status === 405 ? "Method not allowed." : "Bad request." });
    try {
      return await hit.handler(req, env, ctx, hit.params);
    } catch (e) {
      console.error(`${req.method} ${url.pathname} failed:`, e?.message); // no request bodies or personal data in logs
      return json(500, { error: "Something went wrong. Please try again." });
    }
  },
  // Cron Triggers (wrangler.jsonc "triggers"): start the daily briefing on time.
  async scheduled(event, env, ctx) {
    initEnv(env);
    ctx.waitUntil(dispatchBriefing(new Date(event.scheduledTime)));
  }
};
