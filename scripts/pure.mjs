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
export const ogTitle = html => String(html).match(/<meta property="og:title" content="([^"]*)"/)?.[1] || null;
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
