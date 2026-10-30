// Admin endpoints. Protected twice: staticwebapp.config.json restricts /api/admin/* to the "admin"
// role, and every handler re-checks the role from the client-principal header.
import { app } from "@azure/functions";
import { table, T, odata, rowToItem, itemToRow, json, isAdmin, slug, DOMAIN_KEYS, FREQ_KEYS } from "../lib/shared.js";

const guard = fn => async (req, ctx) => isAdmin(req) ? fn(req, ctx) : json(403, { error: "Admins only." });

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
        youtube: s.youtube || undefined, rss: s.rss || undefined, rating: null, curator: false, sources: ["community"], verified: false,
        addedAt: new Date().toISOString(), ...overrides
      };
      await (await table(T.items)).upsertEntity(itemToRow(item), "Replace");
    }
    // Keep a record of the decision, remove from the pending queue.
    await subs.upsertEntity({ ...r, partitionKey: approve ? "approved" : "rejected", decidedAt: new Date().toISOString(), etag: undefined, timestamp: undefined });
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
    const allowed = ["name", "by", "desc", "domains", "level", "freq", "launched", "status", "web", "apple", "spotify", "youtube", "rss", "logo", "curator", "hidden", "published", "tagsLocked"];
    for (const k of allowed) if (k in patch) item[k] = patch[k] === "" ? undefined : patch[k];
    if (item.domains) item.domains = item.domains.filter(d => DOMAIN_KEYS.includes(d));
    if (item.freq && !FREQ_KEYS.includes(item.freq)) return json(400, { error: "Unknown frequency." });
    if ("domains" in patch) item.tagsLocked = true; // a human edited the tags; the refresh job leaves them alone
    await items.updateEntity({ ...itemToRow(item, r) }, "Replace", { etag: r.etag });
    return json(200, { item });
  })
});
