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
export const appleId = url => url?.match(/id(\d{5,})/)?.[1] || null;

