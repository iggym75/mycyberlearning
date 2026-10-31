// Admin endpoints. Protected twice: staticwebapp.config.json restricts /api/admin/* to the "admin"
// role, and every handler re-checks the role from the client-principal header.
import { app } from "@azure/functions";
import { normaliseEmail, subscriberId } from "../lib/mail.js";
import { table, T, odata, rowToItem, itemToRow, json, isAdmin, slug, normaliseIsbn, isHttpUrl, isAmazonMusicUrl, DOMAIN_KEYS, FREQ_KEYS } from "../lib/shared.js";

// Admins only, and state-changing calls must be same-origin JSON (blocks cross-site form CSRF).
const SITE_ORIGIN = () => new URL(process.env.SITE_URL || "https://mycyberlearning.co.uk").origin;
function sameOrigin(req) {
  const origin = req.headers.get("origin"), host = req.headers.get("host");
  if (!origin) return false;
  try { const o = new URL(origin); return o.origin === SITE_ORIGIN() || o.host === host; } catch { return false; }
}
const guard = fn => async (req, ctx) => {
  if (!isAdmin(req)) return json(403, { error: "Admins only." });
  if (req.method !== "GET") {
    if (!(req.headers.get("content-type") || "").toLowerCase().startsWith("application/json") && req.method !== "DELETE") return json(415, { error: "Send JSON." });
    if (!sameOrigin(req)) return json(403, { error: "Cross-site request refused." });
  }
  return fn(req, ctx);
};
const URL_FIELDS = ["web", "apple", "spotify", "amazon", "youtube", "rss"];
function sanitiseItem(item) {
  for (const k of URL_FIELDS) if (item[k] != null) item[k] = isHttpUrl(item[k]) ? String(item[k]).slice(0, 500) : undefined;
  if (item.amazon && !isAmazonMusicUrl(item.amazon)) item.amazon = undefined;
  if (item.logo != null && !(/^covers\/[a-z0-9-]+\.jpg$/.test(item.logo) || isHttpUrl(item.logo))) item.logo = undefined;
  if (item.bundle && !isHttpUrl(item.bundle.url)) item.bundle = undefined;
  item.domains = (Array.isArray(item.domains) ? item.domains : []).filter(d => DOMAIN_KEYS.includes(d)).slice(0, 5);
  return item;
}

// GET /api/admin/submissions — pending review queue
app.http("adminListSubmissions", {
  route: "admin/submissions", methods: ["GET"], authLevel: "anonymous",
  handler: guard(async () => {
    const subs = await table(T.submissions); const items = [];
    for await (const r of subs.listEntities({ queryOptions: { filter: odata`PartitionKey eq 'pending'` } })) {
      const s = JSON.parse(r.data);
      const suggested = JSON.parse(r.suggestedDomains || "[]");
      // Merge the submitter's tags with Claude's suggestions for the reviewer to see.
      items.push({ ...s, id: r.rowKey, domains: [...new Set([...suggested, ...s.domains])].slice(0, 5), review: r.review, submitted: r.submitted });
    }
    return json(200, { items });
  })
});

// POST /api/admin/submissions/{id} { approve: boolean, overrides?: {...} }
app.http("adminDecide", {
  route: "admin/submissions/{id}", methods: ["POST"], authLevel: "anonymous",
  handler: guard(async (req) => {
    const id = req.params.id; const { approve, overrides = {} } = await req.json().catch(() => ({}));
    const subs = await table(T.submissions);
    let r; try { r = await subs.getEntity("pending", id); } catch { return json(404, { error: "Submission not found." }); }
    if (approve) {
      const s = JSON.parse(r.data);
      const suggested = JSON.parse(r.suggestedDomains || "[]"), level = JSON.parse(r.suggestedLevel || "[]");
      const item = {
        id: slug(s.name), type: s.type, name: s.name, by: s.by, desc: s.desc,
        domains: (overrides.domains || [...new Set([...suggested, ...s.domains])]).filter(d => DOMAIN_KEYS.includes(d)).slice(0, 5),
        level: level.length ? level : ["intermediate"], freq: s.type === "podcast" ? s.freq : undefined,
        launched: null, status: "active", web: s.web || undefined, apple: s.apple || undefined, spotify: s.spotify || undefined,
        amazon: s.amazon || undefined, youtube: s.youtube || undefined, rss: s.rss || undefined, isbn: s.isbn || undefined, publisher: s.publisher || undefined, isbnVerified: false, rating: null, curator: false, sources: ["community"], verified: false,
        addedAt: new Date().toISOString(), ...overrides
      };
      await (await table(T.items)).upsertEntity(itemToRow(sanitiseItem(item)), "Replace");
    }
    // Keep a record of the decision without personal data: drop the submitter's email and IP hash.
    const { email, ...publicData } = JSON.parse(r.data);
    await subs.upsertEntity({ partitionKey: approve ? "approved" : "rejected", rowKey: r.rowKey, data: JSON.stringify(publicData),
      suggestedDomains: r.suggestedDomains, review: r.review, submitted: r.submitted, decidedAt: new Date().toISOString() }, "Replace");
    await subs.deleteEntity("pending", id);
    return json(200, { ok: true });
  })
});

// PATCH /api/admin/items/{id} — edit fields, hide/unhide, lock tags.  DELETE removes the item and its votes.
app.http("adminItem", {
  route: "admin/items/{id}", methods: ["PATCH", "DELETE"], authLevel: "anonymous",
  handler: guard(async (req) => {
    const id = req.params.id; const items = await table(T.items);
    let r; try { r = await items.getEntity("item", id); } catch { return json(404, { error: "Item not found." }); }
    if (req.method === "DELETE") {
      await items.deleteEntity("item", id);
      const votes = await table(T.votes);
      for await (const v of votes.listEntities({ queryOptions: { filter: odata`PartitionKey eq ${id}` } })) await votes.deleteEntity(v.partitionKey, v.rowKey);
      return json(200, { ok: true });
    }
    const patch = await req.json().catch(() => ({}));
    const item = rowToItem(r);
    const allowed = ["name", "by", "desc", "domains", "level", "freq", "launched", "status", "web", "apple", "spotify", "amazon", "youtube", "rss", "logo", "curator", "hidden", "published", "tagsLocked", "isbn", "publisher", "format"];
    for (const k of allowed) if (k in patch) item[k] = patch[k] === "" ? undefined : patch[k];
    sanitiseItem(item);
    if ("isbn" in patch && item.isbn) { const n = normaliseIsbn(item.isbn); if (!n) return json(400, { error: "That ISBN doesn't look right." }); if (n !== r.isbn) item.isbnVerified = false; item.isbn = n; }
    if (item.freq && !FREQ_KEYS.includes(item.freq)) return json(400, { error: "Unknown frequency." });
    if ("domains" in patch) item.tagsLocked = true; // a human edited the tags; the refresh job leaves them alone
    await items.updateEntity({ ...itemToRow(item, r) }, "Replace", { etag: r.etag });
    return json(200, { item });
  })
});

/* ---------- Briefing subscribers and site insights (admin only) ---------- */

// GET /api/admin/insights?days=30 → aggregate subscriber and visit statistics. No individual records.
app.http("adminInsights", {
  route: "admin/insights", methods: ["GET"], authLevel: "anonymous",
  handler: guard(async (req) => {
    const days = Math.min(90, Math.max(1, Number(req.query.get("days")) || 30));
    const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
    const subs = { active: 0, pending: 0, unsubscribed: 0, byCountry: {}, byInterest: {}, signupsByDay: {} };
    for await (const r of (await table(T.subscribers)).listEntities()) {
      if (r.partitionKey === "suppressed") { subs.unsubscribed++; continue; }
      if (r.status === "active") {
        subs.active++;
        const c = r.country || "Not given"; subs.byCountry[c] = (subs.byCountry[c] || 0) + 1;
        for (const d of JSON.parse(r.interests || "[]")) subs.byInterest[d] = (subs.byInterest[d] || 0) + 1;
        const day = (r.confirmedAt || "").slice(0, 10); if (day >= since) subs.signupsByDay[day] = (subs.signupsByDay[day] || 0) + 1;
      } else subs.pending++;
    }
    const visits = { byDay: {}, page: {}, region: {}, lang: {}, device: {}, ref: {} };
    for await (const r of (await table(T.stats)).listEntities({ queryOptions: { filter: odata`PartitionKey ge ${since}` } })) {
      const [dim, ...rest] = r.rowKey.split("|"); const val = rest.join("|").replace(/~/g, "/");
      if (dim === "total") visits.byDay[r.partitionKey] = (visits.byDay[r.partitionKey] || 0) + r.n;
      else if (visits[dim]) visits[dim][val] = (visits[dim][val] || 0) + r.n;
    }
    return json(200, { days, subscribers: subs, visits });
  })
});

// GET /api/admin/subscribers/export → CSV of active subscribers (for your own records / subject access requests).
app.http("adminSubscribersExport", {
  route: "admin/subscribers/export", methods: ["GET"], authLevel: "anonymous",
  handler: guard(async (req, ctx) => {
    const rows = [["email", "name", "country", "interests", "confirmed_at", "consent_version"]];
    for await (const r of (await table(T.subscribers)).listEntities({ queryOptions: { filter: odata`PartitionKey eq 'sub' and status eq 'active'` } }))
      if (r.partitionKey === "sub" && r.status === "active") rows.push([r.email, r.name || "", r.country || "", JSON.parse(r.interests || "[]").join(" "), r.confirmedAt || "", r.consentVersion || ""]);
    // Neutralise spreadsheet formula injection (=, +, -, @ at the start of a cell).
    const cell = v => { let s = String(v ?? ""); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return `"${s.replace(/"/g, '""')}"`; };
    ctx.log(`subscriber export by admin, ${rows.length - 1} rows`);
    return { status: 200, headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="subscribers-${new Date().toISOString().slice(0, 10)}.csv"`, "cache-control": "no-store" }, body: rows.map(r => r.map(cell).join(",")).join("\r\n") };
  })
});

// POST /api/admin/subscribers/erase { email } → right-to-erasure requests received by email or post.
app.http("adminSubscriberErase", {
  route: "admin/subscribers/erase", methods: ["POST"], authLevel: "anonymous",
  handler: guard(async (req, ctx) => {
    const { email } = await req.json().catch(() => ({}));
    const e = normaliseEmail(email); if (!e) return json(400, { error: "Enter a valid email address." });
    const id = subscriberId(e), t = await table(T.subscribers);
    let found = true; try { await t.deleteEntity("sub", id); } catch { found = false; }
    await t.upsertEntity({ partitionKey: "suppressed", rowKey: id, at: new Date().toISOString(), reason: "erasure-request" }, "Replace");
    ctx.log(`erasure request processed (found=${found})`);
    return json(200, { ok: true, found, message: found ? "Deleted. They won't receive any more briefings unless they subscribe and confirm again." : "No subscriber with that address was found." });
  })
});
