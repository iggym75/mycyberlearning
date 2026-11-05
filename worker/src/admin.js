// Admin endpoints. Every handler is wrapped in guard(): a valid admin session cookie, and same-origin JSON for writes.
import { normaliseEmail, subscriberId } from "./lib/mail.js";
import { json, slug, normaliseIsbn, isHttpUrl, isAmazonMusicUrl, isPlatformUrl, DOMAIN_KEYS, FREQ_KEYS, KIND_KEYS, COST_KEYS } from "./lib/shared.js";
import { rowToItem, getItemRow, upsertItem, insertItem, deleteItem } from "./lib/db.js";
import { guard } from "./auth.js";

const URL_FIELDS = ["web", "apple", "spotify", "amazon", "youtube", "rss", "twitch"];
function sanitiseItem(item) {
  for (const k of URL_FIELDS) if (item[k] != null) item[k] = isHttpUrl(item[k]) ? String(item[k]).slice(0, 500) : undefined;
  if (item.amazon && !isAmazonMusicUrl(item.amazon)) item.amazon = undefined;
  for (const k of ["apple", "spotify", "youtube", "twitch"]) if (item[k] && !isPlatformUrl(k, item[k])) item[k] = undefined;
  if (item.logo != null && !(/^covers\/[a-z0-9-]+\.(jpg|png|webp|gif)$/.test(item.logo) || isHttpUrl(item.logo))) item.logo = undefined;
  if (item.bundle && !isHttpUrl(item.bundle.url)) item.bundle = undefined;
  if (item.logoFrom != null && !(isHttpUrl(item.logoFrom) && item.logoFrom.startsWith("https://"))) item.logoFrom = undefined; // where the refresh fetches a platform logo from
  item.domains = (Array.isArray(item.domains) ? item.domains : []).filter(d => DOMAIN_KEYS.includes(d)).slice(0, 5);
  if (item.type === "platform") { if (!KIND_KEYS.includes(item.kind)) item.kind = undefined; if (!COST_KEYS.includes(item.cost)) item.cost = undefined; }
  else { delete item.kind; delete item.cost; }
  return item;
}
const parse = (s, d) => { try { return JSON.parse(s ?? ""); } catch { return d; } };

// GET /api/admin/submissions: pending review queue
export const listSubmissions = guard(async (req, env) => {
  const { results } = await env.DB.prepare("SELECT * FROM submissions WHERE status = 'pending' ORDER BY submitted").all();
  const items = results.map(r => {
    const s = parse(r.data, {}), suggested = parse(r.suggested_domains, []);
    // Merge the submitter's tags with Claude's suggestions for the reviewer to see.
    return { ...s, id: r.id, domains: [...new Set([...suggested, ...(s.domains || [])])].slice(0, 5), review: r.review, submitted: r.submitted };
  });
  return json(200, { items });
});

// POST /api/admin/submissions/:id { approve: boolean, overrides?: {...} }
export const decide = guard(async (req, env, ctx, { id }) => {
  const { approve, overrides = {} } = await req.json().catch(() => ({}));
  const r = await env.DB.prepare("SELECT * FROM submissions WHERE id = ? AND status = 'pending'").bind(id).first();
  if (!r) return json(404, { error: "Submission not found." });
  const s = parse(r.data, {});
  if (approve) {
    const suggested = parse(r.suggested_domains, []), level = parse(r.suggested_level, []);
    const item = sanitiseItem({
      id: slug(s.name), type: s.type, name: s.name, by: s.by, desc: s.desc,
      domains: (Array.isArray(overrides.domains) ? overrides.domains : [...new Set([...suggested, ...(s.domains || [])])]),
      level: level.length ? level : ["intermediate"], freq: s.type === "podcast" ? s.freq : undefined, kind: s.kind || undefined, cost: s.cost || undefined,
      launched: null, status: "active", web: s.web || undefined, apple: s.apple || undefined, spotify: s.spotify || undefined,
      amazon: s.amazon || undefined, youtube: s.youtube || undefined, rss: s.rss || undefined, isbn: s.isbn || undefined, publisher: s.publisher || undefined,
      isbnVerified: false, rating: null, curator: false, sources: ["community"], verified: false, addedAt: new Date().toISOString()
    });
    if (!(await insertItem(env.DB, item))) return json(409, { error: `"${s.name}" is already in the library.` });
  }
  // Keep a record of the decision without personal data: drop the submitter's email and IP hash.
  const { email, ...publicData } = s;
  await env.DB.prepare("UPDATE submissions SET status = ?, data = ?, ip_hash = NULL, decided_at = ? WHERE id = ?")
    .bind(approve ? "approved" : "rejected", JSON.stringify(publicData), new Date().toISOString(), id).run();
  return json(200, { ok: true });
});

// PATCH /api/admin/items/:id edits fields, hides/unhides, locks tags. DELETE removes the item and its votes.
export const item = guard(async (req, env, ctx, { id }) => {
  const r = await getItemRow(env.DB, id);
  if (!r) return json(404, { error: "Item not found." });
  if (req.method === "DELETE") { await deleteItem(env.DB, id); return json(200, { ok: true }); }
  const patch = await req.json().catch(() => ({}));
  const cur = rowToItem(r), it = { ...cur };
  const allowed = ["name", "by", "desc", "domains", "level", "freq", "launched", "status", "web", "apple", "spotify", "amazon", "youtube", "rss", "logo", "curator", "hidden", "published", "tagsLocked", "isbn", "publisher", "format", "kind", "cost", "logoFrom", "statusLocked", "twitch"];
  for (const k of allowed) if (k in patch) it[k] = patch[k] === "" || patch[k] === null ? undefined : patch[k];
  sanitiseItem(it);
  if ("isbn" in patch && it.isbn) { const n = normaliseIsbn(it.isbn); if (!n) return json(400, { error: "That ISBN doesn't look right." }); if (n !== cur.isbn) it.isbnVerified = false; it.isbn = n; }
  if (it.freq && !FREQ_KEYS.includes(it.freq)) return json(400, { error: "Unknown frequency." });
  if ("domains" in patch) it.tagsLocked = true; // a human edited the tags; the refresh job leaves them alone
  // Likewise a changed status or frequency (the edit form always sends freq, so only a real change locks it).
  if (!("statusLocked" in patch) && (("status" in patch && patch.status !== cur.status) || ("freq" in patch && patch.freq !== cur.freq))) it.statusLocked = true;
  for (const k of ["name", "by", "desc"]) if (typeof it[k] === "string") it[k] = it[k].slice(0, k === "desc" ? 800 : 160);
  await upsertItem(env.DB, it);
  return json(200, { item: it });
});

/* ---------- Briefing subscribers and site insights ---------- */

// GET /api/admin/insights?days=30 → aggregate subscriber and visit statistics. No individual records.
export const insights = guard(async (req, env) => {
  const days = Math.min(90, Math.max(1, Number(new URL(req.url).searchParams.get("days")) || 30));
  const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  const subs = { active: 0, pending: 0, unsubscribed: 0, byCountry: {}, byInterest: {}, signupsByDay: {} };
  const { results: rows } = await env.DB.prepare("SELECT status, country, interests, confirmed_at FROM subscribers").all();
  for (const r of rows) {
    if (r.status === "suppressed") { subs.unsubscribed++; continue; }
    if (r.status !== "active") { subs.pending++; continue; }
    subs.active++;
    const c = r.country || "Not given"; subs.byCountry[c] = (subs.byCountry[c] || 0) + 1;
    for (const d of parse(r.interests, [])) subs.byInterest[d] = (subs.byInterest[d] || 0) + 1;
    const day = (r.confirmed_at || "").slice(0, 10); if (day >= since) subs.signupsByDay[day] = (subs.signupsByDay[day] || 0) + 1;
  }
  const visits = { byDay: {}, page: {}, region: {}, lang: {}, device: {}, ref: {} };
  const { results: st } = await env.DB.prepare("SELECT day, dim, val, n FROM stats WHERE day >= ?").bind(since).all();
  for (const r of st) {
    if (r.dim === "total") visits.byDay[r.day] = (visits.byDay[r.day] || 0) + r.n;
    else if (visits[r.dim]) visits[r.dim][r.val] = (visits[r.dim][r.val] || 0) + r.n;
  }
  return json(200, { days, subscribers: subs, visits });
});

// GET /api/admin/export → CSV of every catalogue item, hidden ones included, with community vote tallies.
const ITEM_COLUMNS = ["id", "type", "name", "by", "desc", "kind", "cost", "domains", "level", "freq", "status", "launched", "published",
  "web", "apple", "spotify", "amazon", "youtube", "rss", "isbn", "publisher", "rating", "rating_count", "rating_as_of",
  "community_up", "community_down", "curator", "hidden", "tags_locked", "episodes", "last_episode", "sources"];
export const exportItems = guard(async (req, env) => {
  const { results } = await env.DB.prepare("SELECT * FROM items ORDER BY id").all();
  const rows = [ITEM_COLUMNS];
  for (const r of results) {
    const i = rowToItem(r);
    rows.push([i.id, i.type, i.name, i.by, i.desc, i.kind, i.cost, (i.domains || []).join(" "), (i.level || []).join(" "), i.freq, i.status, i.launched, i.published,
      i.web, i.apple, i.spotify, i.amazon, i.youtube, i.rss, i.isbn, i.publisher, i.rating?.v, i.rating?.n, i.rating?.asOf,
      i.community?.up ?? 0, i.community?.down ?? 0, i.curator ? "yes" : "no", i.hidden ? "yes" : "no", i.tagsLocked ? "yes" : "no",
      i.episodes, i.lastEpisode, (i.sources || []).join(" ")]);
  }
  return csvResponse(rows, `mycyberlearning-catalogue-${new Date().toISOString().slice(0, 10)}.csv`);
});

// Neutralise spreadsheet formula injection (=, +, -, @ at the start of a cell) and quote every cell.
const csvCell = v => { let s = String(v ?? ""); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return `"${s.replace(/"/g, '""')}"`; };
function csvResponse(rows, filename) {
  return new Response("\ufeff" + rows.map(r => r.map(csvCell).join(",")).join("\r\n"), { status: 200, headers: {
    "content-type": "text/csv; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff",
    "content-disposition": `attachment; filename="${filename}"` } });
}

// GET /api/admin/subscribers/export → CSV of active subscribers (for your records and subject access requests).
export const exportSubscribers = guard(async (req, env) => {
  const rows = [["email", "name", "country", "interests", "confirmed_at", "consent_version"]];
  const { results } = await env.DB.prepare("SELECT * FROM subscribers WHERE status = 'active' ORDER BY confirmed_at").all();
  for (const r of results) if (r.status === "active") rows.push([r.email, r.name || "", r.country || "", parse(r.interests, []).join(" "), r.confirmed_at || "", r.consent_version || ""]);
  console.log(`subscriber export by admin, ${rows.length - 1} rows`);
  return csvResponse(rows, `subscribers-${new Date().toISOString().slice(0, 10)}.csv`);
});

// POST /api/admin/subscribers/erase { email } → right-to-erasure requests received by email or post.
export const eraseSubscriber = guard(async (req, env) => {
  const { email } = await req.json().catch(() => ({}));
  const e = normaliseEmail(email); if (!e) return json(400, { error: "Enter a valid email address." });
  const id = subscriberId(e);
  const found = !!(await env.DB.prepare("SELECT 1 FROM subscribers WHERE id = ? AND status != 'suppressed'").bind(id).first());
  if (found) await suppress(env.DB, id, "erasure-request"); // unknown addresses leave no trace
  console.log(`erasure request processed (found=${found})`);
  return json(200, { ok: true, found, message: found ? "Deleted. They won't receive any more briefings unless they subscribe and confirm again." : "No subscriber with that address was found." });
});

/** Deletes a subscriber's details and keeps only the hashed id, so they're never mailed again unless they re-confirm. */
export async function suppress(db, id, reason = "unsubscribed") {
  await db.prepare(`INSERT INTO subscribers (id, status, suppressed_at, reason) VALUES (?, 'suppressed', ?, ?)
    ON CONFLICT(id) DO UPDATE SET status = 'suppressed', email = NULL, name = NULL, country = NULL, interests = NULL,
      token_hash = NULL, token_expires = NULL, consent_text = NULL, requested_at = NULL, window_start = NULL, sends = 0,
      confirmed_at = NULL, last_sent = NULL, suppressed_at = excluded.suppressed_at, reason = excluded.reason`)
    .bind(id, new Date().toISOString(), reason).run();
}
