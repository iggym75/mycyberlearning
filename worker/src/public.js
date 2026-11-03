// Public endpoints: list items, vote, submit a suggestion.
import { json, sha, clientIp, rateLimited, isHttpUrl, isAmazonMusicUrl, isPlatformUrl, normaliseIsbn, clean, slug, claudeReview, DOMAIN_KEYS, FREQ_KEYS } from "./lib/shared.js";
import { listItems, getItemRow } from "./lib/db.js";
import { isAdmin } from "./auth.js";

// GET /api/items: the full catalogue with community tallies. Hidden items only for admins.
// The public list is cached for 60 s in this isolate's memory and at the edge, to stay well inside the
// free plan's 10 ms CPU and daily D1 read limits (votes show within a minute).
let memo = { at: 0, body: null };
export async function items(req, env, ctx) {
  if (isAdmin(req)) return json(200, { items: await listItems(env.DB, { includeHidden: true }) });
  const headers = { "cache-control": "public, max-age=60", vary: "cookie" };
  if (memo.body && Date.now() - memo.at < 60_000) return new Response(memo.body, { status: 200, headers: { ...JSON_HEADERS, ...headers } });
  const cache = globalThis.caches?.default, key = new Request(new URL("/api/items", req.url).href);
  const hit = cache && await cache.match(key).catch(() => null);
  if (hit) return hit;
  const body = JSON.stringify({ items: await listItems(env.DB, { includeHidden: false }) });
  memo = { at: Date.now(), body };
  const res = new Response(body, { status: 200, headers: { ...JSON_HEADERS, ...headers } });
  if (cache) ctx.waitUntil(cache.put(key, res.clone()).catch(() => {}));
  return res;
}
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "x-content-type-options": "nosniff", "referrer-policy": "strict-origin-when-cross-origin" };

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
  // One batch = one transaction: record the vote, then recount the tallies from the votes table, so
  // parallel or repeated requests can never inflate them.
  await db.batch([
    dir === 0
      ? db.prepare("DELETE FROM votes WHERE item_id = ? AND voter = ?").bind(id, voterHash)
      : db.prepare("INSERT INTO votes (item_id, voter, dir, at) VALUES (?, ?, ?, ?) ON CONFLICT(item_id, voter) DO UPDATE SET dir = excluded.dir, at = excluded.at")
          .bind(id, voterHash, dir, new Date().toISOString()),
    db.prepare(`UPDATE items SET up = (SELECT COUNT(*) FROM votes WHERE item_id = ?1 AND dir = 1),
      down = (SELECT COUNT(*) FROM votes WHERE item_id = ?1 AND dir = -1) WHERE id = ?1`).bind(id)
  ]);
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
  else if (!slug(s.name)) errs.push("Include some letters or numbers (A–Z, 0–9) in the name.");
  if (s.desc.length < 40) errs.push("Write a description of at least 40 characters.");
  for (const k of ["web", "apple", "spotify", "amazon", "youtube", "rss"]) if (s[k] && !isHttpUrl(s[k])) errs.push(`The ${k} link isn't a valid web address.`);
  if (s.amazon && !isAmazonMusicUrl(s.amazon)) errs.push("The Amazon Music link should be a podcast page, e.g. https://music.amazon.co.uk/podcasts/….");
  if (s.apple && !isPlatformUrl("apple", s.apple)) errs.push("The Apple link should start with https://podcasts.apple.com/.");
  if (s.spotify && !isPlatformUrl("spotify", s.spotify)) errs.push("The Spotify link should start with https://open.spotify.com/.");
  if (s.youtube && !isPlatformUrl("youtube", s.youtube)) errs.push("The YouTube link should be a youtube.com or youtu.be address.");
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
