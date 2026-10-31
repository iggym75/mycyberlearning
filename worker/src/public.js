// Public endpoints: list items, vote, submit a suggestion.
import { json, sha, clientIp, rateLimited, isHttpUrl, isAmazonMusicUrl, normaliseIsbn, clean, slug, claudeReview, DOMAIN_KEYS, FREQ_KEYS } from "./lib/shared.js";
import { listItems, getItemRow } from "./lib/db.js";
import { isAdmin } from "./auth.js";

// GET /api/items: the full catalogue with community tallies. Hidden items only for admins.
export async function items(req, env, ctx) {
  const admin = isAdmin(req);
  if (admin) return json(200, { items: await listItems(env.DB, { includeHidden: true }) });
  // Public list: cached at the edge for 60 s to save CPU and database reads (votes show within a minute).
  const cache = globalThis.caches?.default, key = new Request(new URL("/api/items", req.url).href);
  const hit = cache && await cache.match(key).catch(() => null);
  if (hit) return hit;
  const res = json(200, { items: await listItems(env.DB, { includeHidden: false }) }, { "cache-control": "public, max-age=60", vary: "cookie" });
  if (cache) ctx.waitUntil(cache.put(key, res.clone()).catch(() => {}));
  return res;
}

// POST /api/vote { id, dir: 1 | 0 | -1, voterId }
// One vote per item per browser. The voter id is salted and hashed; IPs are only used for rate limiting.
export async function vote(req, env) {
  if (rateLimited("vote:" + clientIp(req), 60, 60_000)) return json(429, { error: "Too many votes in a short time. Try again in a minute." });
  let body; try { body = await req.json(); } catch { return json(400, { error: "Invalid request." }); }
  const id = clean(body.id, 100), dir = Number(body.dir), voter = clean(body.voterId, 100);
  if (!id || ![1, 0, -1].includes(dir) || voter.length < 8) return json(400, { error: "Invalid vote." });

  const db = env.DB, voterHash = sha((process.env.VOTE_SALT || "") + voter);
  const row = await getItemRow(db, id);
  if (!row || row.hidden) return json(404, { error: "That resource no longer exists." });
  const prev = (await db.prepare("SELECT dir FROM votes WHERE item_id = ? AND voter = ?").bind(id, voterHash).first())?.dir || 0;
  if (prev !== dir) {
    const dUp = (dir === 1 ? 1 : 0) - (prev === 1 ? 1 : 0), dDown = (dir === -1 ? 1 : 0) - (prev === -1 ? 1 : 0);
    // One batch = one transaction: the tally and the vote record change together.
    await db.batch([
      db.prepare("UPDATE items SET up = MAX(0, up + ?), down = MAX(0, down + ?) WHERE id = ?").bind(dUp, dDown, id),
      dir === 0
        ? db.prepare("DELETE FROM votes WHERE item_id = ? AND voter = ?").bind(id, voterHash)
        : db.prepare("INSERT INTO votes (item_id, voter, dir, at) VALUES (?, ?, ?, ?) ON CONFLICT(item_id, voter) DO UPDATE SET dir = excluded.dir, at = excluded.at")
            .bind(id, voterHash, dir, new Date().toISOString())
    ]);
  }
  const r = await db.prepare("SELECT up, down FROM items WHERE id = ?").bind(id).first();
  return json(200, { community: { up: r?.up || 0, down: r?.down || 0 } });
}

// POST /api/submissions: visitor suggestions go to a review queue, never straight to the site.
export async function submit(req, env) {
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
    s.amazon = "";
  } else { s.isbn = ""; s.publisher = ""; }
  if (s.type === "podcast" && !s.web) errs.push("Add the podcast's official website.");
  if (s.type === "podcast" && !(s.apple || s.spotify || s.youtube || s.amazon)) errs.push("Add at least one of Apple Podcasts, Spotify, YouTube or Amazon Music.");
  if (errs.length) return json(400, { error: errs.join(" ") });

  if (await getItemRow(env.DB, slug(s.name))) return json(409, { error: `"${s.name}" is already in the library.` });

  const review = await claudeReview({ name: s.name, by: s.by, desc: s.desc, links: { web: s.web, apple: s.apple, spotify: s.spotify, amazon: s.amazon, youtube: s.youtube } });
  const id = `${Date.now().toString(36)}-${slug(s.name).slice(0, 30)}`;
  await env.DB.prepare(`INSERT INTO submissions (id, status, data, suggested_domains, suggested_level, review, ip_hash, submitted)
    VALUES (?, 'pending', ?, ?, ?, ?, ?, ?)`).bind(
    id, JSON.stringify(s), JSON.stringify(review?.domains || []), JSON.stringify(review?.level || []),
    review ? `${review.relevant ? "Looks relevant" : "May not be a security resource"}${review.spam_or_abuse ? " · possible spam" : ""}. ${review.note}` : "",
    sha((process.env.VOTE_SALT || "") + ip), new Date().toISOString()
  ).run();
  return json(202, { ok: true });
}
