// What's New: GET /api/whatsnew (public) and the admin editor (guarded).
import { json } from "./lib/shared.js";
import { guard } from "./auth.js";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
// A "Try it" link must stay on our own site: a view (#mylist, #news/2026-11-25) or a path (/video/). Never another domain.
export const safeLink = l => {
  const s = String(l ?? "").trim();
  if (!s) return "";
  return /^#[a-z][a-z-]{0,30}(\/[0-9-]{10})?$/.test(s) || /^\/(?!\/)[a-z0-9\-/]{0,80}$/.test(s) ? s : null;
};
export function validEntry(b) {
  const title = String(b?.title ?? "").trim(), body = String(b?.body ?? "").trim(), day = String(b?.day ?? "").trim(), link = safeLink(b?.link);
  if (!DAY.test(day) || isNaN(Date.parse(day))) return { error: "Give the date as YYYY-MM-DD." };
  if (!title || title.length > 90) return { error: "Add a title (up to 90 characters)." };
  if (!body || body.length > 400) return { error: "Add a short description (up to 400 characters)." };
  if (link === null) return { error: "The link must be on this site, such as #mylist or /video/." };
  return { day, title, body, link: link || null };
}
const rows = async env => (await env.DB.prepare("SELECT id, day, title, body, link FROM whatsnew ORDER BY day DESC, id DESC LIMIT 50").all()).results || [];

export async function list(req, env) {
  return json(200, { items: await rows(env) }, { "cache-control": "public, max-age=300" });
}
export const adminList = guard(async (req, env) => json(200, { items: await rows(env) }));
export const adminSave = guard(async (req, env) => {
  const b = await req.json().catch(() => null), v = validEntry(b);
  if (v.error) return json(400, v);
  const t = new Date().toISOString();
  if (b.id) {
    const r = await env.DB.prepare("UPDATE whatsnew SET day = ?, title = ?, body = ?, link = ?, updated_at = ? WHERE id = ?").bind(v.day, v.title, v.body, v.link, t, Number(b.id)).run();
    return (r.meta?.changes ?? 0) ? json(200, { ok: true, id: Number(b.id) }) : json(404, { error: "Not found." });
  }
  const r = await env.DB.prepare("INSERT INTO whatsnew (day, title, body, link, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id").bind(v.day, v.title, v.body, v.link, t, t).first();
  return json(200, { ok: true, id: r.id });
});
export const adminDelete = guard(async (req, env, ctx, { id }) => {
  const r = await env.DB.prepare("DELETE FROM whatsnew WHERE id = ?").bind(Number(id)).run();
  return (r.meta?.changes ?? 0) ? json(200, { ok: true }) : json(404, { error: "Not found." });
});
