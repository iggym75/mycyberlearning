// Public endpoints: list items, vote, submit a suggestion.
import { app } from "@azure/functions";
import { table, T, odata, rowToItem, json, sha, clientIp, rateLimited, isHttpUrl, isAmazonMusicUrl, normaliseIsbn, clean, slug, claudeReview, DOMAIN_KEYS, FREQ_KEYS, isAdmin } from "../lib/shared.js";

// GET /api/items — the full catalogue with community tallies. Hidden items only for admins.
app.http("items", {
  route: "items", methods: ["GET"], authLevel: "anonymous",
  handler: async (req) => {
    const t = await table(T.items);
    const admin = isAdmin(req);
    const items = [];
    for await (const r of t.listEntities({ queryOptions: { filter: odata`PartitionKey eq 'item'` } })) {
      if (r.hidden && !admin) continue;
      items.push(rowToItem(r));
    }
    // Short public cache; votes show up within a minute for other visitors.
    return json(200, { items }, admin ? {} : { "cache-control": "public, max-age=60" });
  }
});

// POST /api/vote { id, dir: 1 | 0 | -1, voterId }
// One vote per item per browser. The voter id is salted and hashed; IPs are only used for rate limiting.
app.http("vote", {
  route: "vote", methods: ["POST"], authLevel: "anonymous",
  handler: async (req, ctx) => {
    const ip = clientIp(req);
    if (rateLimited("vote:" + ip, 60, 60_000)) return json(429, { error: "Too many votes in a short time. Try again in a minute." });
    let body; try { body = await req.json(); } catch { return json(400, { error: "Invalid request." }); }
    const id = clean(body.id, 100), dir = Number(body.dir), voter = clean(body.voterId, 100);
    if (!id || ![1, 0, -1].includes(dir) || voter.length < 8) return json(400, { error: "Invalid vote." });

    const items = await table(T.items), votes = await table(T.votes);
    const voterHash = sha((process.env.VOTE_SALT || "") + voter);
    let prev = 0;
    try { prev = (await votes.getEntity(id, voterHash)).dir || 0; } catch (e) { if (e.statusCode !== 404) throw e; }
    if (prev === dir) {
      const r = await items.getEntity("item", id);
      return json(200, { community: { up: r.up || 0, down: r.down || 0 } });
    }

    // Optimistic concurrency on the tally so simultaneous votes don't overwrite each other.
    for (let attempt = 0; attempt < 5; attempt++) {
      let r;
      try { r = await items.getEntity("item", id); } catch (e) { if (e.statusCode === 404) return json(404, { error: "That resource no longer exists." }); throw e; }
      if (r.hidden) return json(404, { error: "That resource no longer exists." });
      const up = (r.up || 0) - (prev === 1 ? 1 : 0) + (dir === 1 ? 1 : 0);
      const down = (r.down || 0) - (prev === -1 ? 1 : 0) + (dir === -1 ? 1 : 0);
      try {
        await items.updateEntity({ partitionKey: "item", rowKey: id, up: Math.max(0, up), down: Math.max(0, down) }, "Merge", { etag: r.etag });
        if (dir === 0) await votes.deleteEntity(id, voterHash).catch(() => {});
        else await votes.upsertEntity({ partitionKey: id, rowKey: voterHash, dir, at: new Date().toISOString() }, "Replace");
        return json(200, { community: { up: Math.max(0, up), down: Math.max(0, down) } });
      } catch (e) { if (e.statusCode !== 412) throw e; }
    }
    ctx.warn("vote contention", id);
    return json(503, { error: "Busy right now. Please try again." });
  }
});

// POST /api/submissions — visitor suggestions go to a review queue, never straight to the site.
app.http("submit", {
  route: "submissions", methods: ["POST"], authLevel: "anonymous",
  handler: async (req) => {
    const ip = clientIp(req);
    if (rateLimited("sub:" + ip, 5, 3_600_000)) return json(429, { error: "You've sent several suggestions already. Please try again later." });
    let b; try { b = await req.json(); } catch { return json(400, { error: "Invalid request." }); }
    if (b.website_url_confirm) return json(200, { ok: true }); // honeypot field for bots

    const s = {
      type: b.type === "book" ? "book" : "podcast",
      name: clean(b.name, 120), by: clean(b.by, 160), desc: clean(b.desc, 800),
      freq: FREQ_KEYS.includes(b.freq) ? b.freq : "irregular",
      domains: (Array.isArray(b.domains) ? b.domains : []).filter(d => DOMAIN_KEYS.includes(d)).slice(0, 6),
      web: clean(b.web, 400), apple: clean(b.apple, 400), spotify: clean(b.spotify, 400), amazon: clean(b.amazon, 400), youtube: clean(b.youtube, 400), rss: clean(b.rss, 400),
      email: clean(b.email, 200), isbn: clean(b.isbn, 20), publisher: clean(b.publisher, 120)
    };
    const errs = [];
    if (s.name.length < 2) errs.push("Add the name.");
    if (s.desc.length < 40) errs.push("Write a description of at least 40 characters.");
    for (const k of ["web", "apple", "spotify", "amazon", "youtube", "rss"]) if (s[k] && !isHttpUrl(s[k])) errs.push(`The ${k} link isn't a valid web address.`);
    if (s.amazon && !isAmazonMusicUrl(s.amazon)) errs.push("The Amazon Music link should be a podcast page, e.g. https://music.amazon.co.uk/podcasts/….");
    if (s.apple && !/^https:\/\/podcasts\.apple\.com\//.test(s.apple)) errs.push("The Apple link should start with https://podcasts.apple.com/.");
    if (s.spotify && !/^https:\/\/open\.spotify\.com\//.test(s.spotify)) errs.push("The Spotify link should start with https://open.spotify.com/.");
    if (s.youtube && !/^https:\/\/(www\.|music\.)?youtube\.com\/|^https:\/\/youtu\.be\//.test(s.youtube)) errs.push("The YouTube link should be a youtube.com address.");
    if (s.type === "book") {
      if (s.isbn) { const n = normaliseIsbn(s.isbn); if (!n) errs.push("That ISBN doesn't look right. Check the digits."); else s.isbn = n; }
      if (!s.publisher) errs.push("Add the publisher.");
    } else { s.isbn = ""; s.publisher = ""; }
    if (s.type === "podcast" && !s.web) errs.push("Add the podcast's official website.");
    if (s.type === "podcast" && !(s.apple || s.spotify || s.youtube || s.amazon)) errs.push("Add at least one of Apple Podcasts, Spotify, YouTube or Amazon Music.");
    if (s.type === "book") s.amazon = "";
    if (errs.length) return json(400, { error: errs.join(" ") });

    // Duplicate check against live items.
    const items = await table(T.items);
    try { await items.getEntity("item", slug(s.name)); return json(409, { error: `"${s.name}" is already in the library.` }); } catch (e) { if (e.statusCode !== 404) throw e; }

    const review = await claudeReview({ name: s.name, by: s.by, desc: s.desc, links: { web: s.web, apple: s.apple, spotify: s.spotify, amazon: s.amazon, youtube: s.youtube } });
    const id = `${Date.now().toString(36)}-${slug(s.name).slice(0, 30)}`;
    const subs = await table(T.submissions);
    await subs.createEntity({
      partitionKey: "pending", rowKey: id, data: JSON.stringify(s),
      suggestedDomains: JSON.stringify(review?.domains || []), suggestedLevel: JSON.stringify(review?.level || []),
      review: review ? `${review.relevant ? "Looks relevant" : "May not be a security resource"}${review.spam_or_abuse ? " · possible spam" : ""}. ${review.note}` : "",
      ipHash: sha((process.env.VOTE_SALT || "") + ip), submitted: new Date().toISOString()
    });
    return json(202, { ok: true });
  }
});
