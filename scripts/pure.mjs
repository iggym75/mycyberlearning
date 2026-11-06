// Dependency-free helpers used by the refresh job (unit-tested).
const DAY = 86_400_000;

/** Work out release cadence, launch date and status from episode publish dates. */
export function inferCadence(dates, { now = Date.now(), complete = true } = {}) {
  const ts = dates.map(d => +new Date(d)).filter(Number.isFinite).sort((a, b) => a - b);
  if (!ts.length) return null;
  const last = ts[ts.length - 1];
  const sinceLast = (now - last) / DAY;
  const recent = ts.filter(t => now - t < 365 * DAY);
  const gaps = [];
  for (let i = 1; i < recent.length; i++) gaps.push((recent[i] - recent[i - 1]) / DAY);
  gaps.sort((a, b) => a - b);
  const median = gaps.length ? gaps[Math.floor(gaps.length / 2)] : Infinity;
  let freq;
  if (sinceLast > 365) freq = "ended";
  else if (sinceLast > 120 || recent.length < 4) freq = "irregular";
  else if (median <= 1.6) freq = "daily";
  else if (median <= 4.5) freq = "multiweekly";
  else if (median <= 10) freq = "weekly";
  else if (median <= 20) freq = "biweekly";
  else if (median <= 45) freq = "monthly";
  else freq = "irregular";
  return {
    freq,
    status: freq === "ended" ? "ended" : "active",
    lastEpisode: new Date(last).toISOString().slice(0, 10),
    launched: complete ? new Date(ts[0]).toISOString().slice(0, 7) : null,
    episodesSeen: ts.length
  };
}

/** Podnews shows "4.8 via 1,852 ratings in Apple Podcasts, Spotify…" for shows it tracks. */
export function parsePodnewsRating(html) {
  const m = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").match(/(\d(?:\.\d)?)\s+via\s+([\d,]+)\s+ratings?/i);
  if (!m) return null;
  const v = parseFloat(m[1]), n = parseInt(m[2].replace(/,/g, ""), 10);
  return v > 0 && v <= 5 && n > 0 ? { v, n } : null;
}

const norm = s => String(s).toLowerCase().replace(/^the\s+/, "").replace(/[^a-z0-9]+/g, " ").trim();
/** Pick the search result whose title matches the catalogue name. */
export function bestMatch(name, results, key = "collectionName") {
  const n = norm(name);
  return results.find(r => norm(r[key]) === n) || results.find(r => norm(r[key]).startsWith(n) || n.startsWith(norm(r[key]))) || null;
}
/** The show's Spotify link from a Podnews page: only when the page names exactly one show, so it can't be another show's. */
export function parsePodnewsSpotify(html) {
  // Only links that start an attribute value (href="https://open.spotify.com/show/…"), never one embedded in another URL.
  const links = [...new Set([...String(html).matchAll(/["'](https:\/\/open\.spotify\.com\/show\/[A-Za-z0-9]{22})/g)].map(m => m[1]))];
  return links.length === 1 ? links[0] : null;
}
// Words that don't identify a publisher on their own ("Cyber Security Media" vs "Security Weekly Media").
const ORG_STOP = new Set(["the", "and", "with", "podcast", "podcasts", "security", "cyber", "cybersecurity", "media", "network", "networks", "inc", "llc", "ltd", "show", "radio", "studio", "studios", "team"]);
const orgWords = s => new Set(String(s ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").split(" ").filter(w => w.length >= 3 && !ORG_STOP.has(w)));
/** True when two publisher/host strings share a distinctive word (e.g. "N2K Networks" and "Dave Bittner · N2K Networks"). */
export function sameOrg(a, b) {
  const x = orgWords(a); for (const w of orgWords(b)) if (x.has(w)) return true;
  return false;
}
/**
 * Pick the Spotify show for a catalogue podcast from Spotify search results. The name must match, plus either the
 * publisher (against Apple's author or our "by") or the episode count (within 15%, or 3). Returns
 * { url } for a confident single match, { near } describing a name-only match that was not used, or null.
 */
export function pickSpotifyShow(item, shows, { author, episodes } = {}) {
  const named = (shows || []).filter(s => s?.name && s.external_urls?.spotify && titlesMatch(item.name, s.name));
  const epsOk = s => episodes > 0 && s.total_episodes > 0 && Math.abs(s.total_episodes - episodes) <= Math.max(3, episodes * 0.15);
  let ok = named.filter(s => sameOrg(s.publisher, author) || sameOrg(s.publisher, item.by) || epsOk(s));
  if (ok.length > 1) { const exact = ok.filter(s => norm(s.name) === norm(item.name)); if (exact.length) ok = exact; }
  if (ok.length === 1) return { url: ok[0].external_urls.spotify.split("?")[0] };
  if (named.length) return { near: named.slice(0, 2).map(s => `"${s.name}" by ${s.publisher} (${s.total_episodes} eps)`).join("; ") };
  return null;
}
/** og:title from a page (Spotify's show pages carry the show name there; its oEmbed title is the latest episode). */
export const ogTitle = html => {
  const t = String(html).match(/<meta property="og:title" content="([^"]*)"/)?.[1];
  return t ? decodeEntities(t) : null;
};
/** Decode the character references that turn up in page titles (&amp; &#x27; &#39; &quot; ...). */
export function decodeEntities(s) {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) =>
    e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : named[e.toLowerCase()] ?? m);
}
export const appleId = url => url?.match(/id(\d{5,})/)?.[1] || null;


/** Returns the ISBN without hyphens/spaces if its check digit is valid, otherwise null. */
export function normaliseIsbn(raw) {
  const s = String(raw ?? "").replace(/[-\s]/g, "").toUpperCase();
  if (/^\d{13}$/.test(s)) return [...s].reduce((t, d, k) => t + Number(d) * (k % 2 ? 3 : 1), 0) % 10 === 0 ? s : null;
  if (/^\d{9}[\dX]$/.test(s)) return [...s].reduce((t, d, k) => t + (d === "X" ? 10 : Number(d)) * (10 - k), 0) % 11 === 0 ? s : null;
  return null;
}
/** Loose title comparison used to confirm an ISBN belongs to the book we think it does. */
export function titlesMatch(a, b) {
  const n = s => String(s ?? "").toLowerCase().split(":")[0].replace(/\(.*?\)/g, "").replace(/^the\s+/, "").replace(/[^a-z0-9]+/g, " ").trim();
  const x = n(a), y = n(b);
  return !!x && !!y && (x === y || x.startsWith(y) || y.startsWith(x));
}

const PUBLISHERS = [[/packt/i, "Packt"], [/no starch/i, "No Starch Press"], [/wiley|sybex/i, "Wiley"], [/o.?reilly/i, "O'Reilly Media"],
  [/addison/i, "Addison-Wesley"], [/pearson it cert/i, "Pearson IT Certification"], [/cisco press/i, "Cisco Press"], [/^pearson/i, "Pearson"],
  [/microsoft press/i, "Microsoft Press"], [/mcgraw/i, "McGraw Hill"], [/apress/i, "Apress"], [/manning/i, "Manning"],
  [/crc press|taylor/i, "CRC Press"], [/mit press/i, "MIT Press"], [/bpb/i, "BPB Publications"]];
/** One label per publisher so the publisher filter doesn't split ("Packt Publishing" -> "Packt"). */
export function canonPublisher(name) {
  if (!name) return undefined;
  for (const [re, label] of PUBLISHERS) if (re.test(name)) return label;
  return String(name).trim().replace(/,?\s+(inc|ltd|llc|limited|publishing|publishers)\.?$/i, "");
}

/** Apple artwork URLs end in e.g. /600x600bb.jpg; ask for a specific square size instead. */
export function appleArtworkUrl(url, size = 300) {
  return url ? String(url).replace(/\/\d+x\d+(bb|cc|sr)?\.(jpg|png|webp)$/i, `/${size}x${size}bb.jpg`) : null;
}
/** True when an item already uses an image stored with the site (not a remote URL). */
/** Width and height of a PNG, JPEG, GIF or WebP from its bytes (no image library needed); null for anything else. */
export function imageSize(buf) {
  const b = Buffer.from(buf);
  if (b.length > 24 && b.toString("latin1", 1, 4) === "PNG") return { type: "png", w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  if (b.length > 10 && b.toString("latin1", 0, 3) === "GIF") return { type: "gif", w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
  if (b.length > 30 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") {
    const kind = b.toString("latin1", 12, 16);
    if (kind === "VP8X") return { type: "webp", w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
    if (kind === "VP8L") { const v = b.readUInt32LE(21); return { type: "webp", w: 1 + (v & 0x3fff), h: 1 + ((v >> 14) & 0x3fff) }; }
    if (kind === "VP8 ") return { type: "webp", w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    for (let i = 2; i + 9 < b.length;) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1], len = b.readUInt16BE(i + 2);
      if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { type: "jpeg", w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
      i += 2 + len;
    }
  }
  return null;
}
/**
 * Choose a platform's logo from measured candidates ({ url, from, w, h }): the largest roughly square app icon of
 * at least 120 px, else a roughly square social image of at least 200 px. SVG and ICO are never candidates
 * (covers are stored as raster files). Returns the chosen candidate or null.
 */
export function pickLogo(cands) {
  const square = c => c.w && c.h && Math.max(c.w, c.h) / Math.min(c.w, c.h) <= 1.25;
  const icons = cands.filter(c => c.from !== "og:image" && square(c) && c.w >= 120).sort((a, b) => b.w - a.w);
  if (icons.length) return icons[0];
  return cands.filter(c => c.from === "og:image" && square(c) && c.w >= 200).sort((a, b) => b.w - a.w)[0] || null;
}
export const hasLocalImage = item => typeof item.logo === "string" && item.logo.startsWith("covers/");

/**
 * fast-xml-parser settings for podcast feeds (untrusted input).
 * - htmlEntities: decode numeric and HTML character references. Some hosts write the "+" in pubDate as &#43;,
 *   which otherwise leaves every date unreadable (no cadence for that show).
 * - This parser version counts every built-in escape (&amp;, &lt; …) towards maxTotalExpansions, so its default of
 *   1000 rejects ordinary feeds with long HTML show notes. Those escapes never make text longer, so that count is
 *   raised; the limits that stop entity-expansion attacks (custom DOCTYPE entities) stay at the library defaults.
 */
export const FEED_XML = {
  htmlEntities: true,
  processEntities: { enabled: true, maxEntitySize: 10000, maxExpansionDepth: 10, maxTotalExpansions: 1_000_000, maxExpandedLength: 100000 }
};

/**
 * Where to look for an expert's photo, best first: the profile picture they chose on a profile they publish
 * themselves (Bluesky, then GitHub, then Mastodon, then their YouTube channel). Returns [{ source, ...lookup }].
 * Nothing is guessed from a name, and X/LinkedIn are never used (they block automated access).
 */
export function expertPhotoPlan(item) {
  const plan = [];
  const m = (re, v) => (typeof v === "string" ? v.match(re) : null);
  const bsky = m(/^https:\/\/bsky\.app\/profile\/([A-Za-z0-9.:_-]+)\/?$/, item.bluesky);
  if (bsky) plan.push({ source: "Bluesky", actor: bsky[1] });
  const gh = m(/^https:\/\/github\.com\/([A-Za-z0-9-]{1,39})\/?$/, item.github);
  if (gh) plan.push({ source: "GitHub", url: `https://github.com/${gh[1]}.png?size=240` });
  const masto = m(/^https:\/\/([a-z0-9.-]+\.[a-z]{2,})\/@([A-Za-z0-9_]{1,30})\/?$/, item.mastodon);
  if (masto) plan.push({ source: "Mastodon", host: masto[1], acct: masto[2] });
  if (typeof item.youtube === "string" && /^https:\/\/(www\.)?youtube\.com\/(@|c\/|channel\/|user\/)/.test(item.youtube)) plan.push({ source: "YouTube", page: item.youtube });
  return plan;
}
/** A Bluesky avatar URL at thumbnail size (plenty for a 60px tile on a high-density screen). */
export const bskyThumb = url => typeof url === "string" ? url.replace("/img/avatar/plain/", "/img/avatar_thumbnail/plain/") : null;
/** A YouTube channel avatar (og:image on yt3.googleusercontent.com / yt3.ggpht.com) resized to 240px. */
export function youtubeAvatar(html) {
  const u = String(html).match(/<meta property="og:image" content="(https:\/\/yt3\.(?:googleusercontent|ggpht)\.com\/[^"]+)"/)?.[1];
  return u ? u.replace(/=s\d+[^"]*$/, "=s240-c-k-c0x00ffffff-no-rj") : null;
}
