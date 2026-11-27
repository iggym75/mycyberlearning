// The weekly My List update: what to put in each person's Monday email. Pure functions (no I/O), so the send script
// and the tests share them. The "This week" panel in the page (renderWeek) follows the same rules.

// Some shows repeat the date at the end of every title, e.g. "… (Nov 25th 2026)": drop it.
export const epTitle = t => String(t ?? "").replace(/\s*\((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2}(?:st|nd|rd|th)?,? \d{4}\)\s*$/, "").trim();

/** Shorten to one email line at a word boundary, with an ellipsis. */
export function shortTitle(t, max = 64) {
  const s = epTitle(t);
  if (s.length <= max) return s;
  const cut = s.slice(0, max).replace(/\s+\S*$/, "").replace(/[\s;,:–-]+$/, "");
  return (cut || s.slice(0, max)) + "…";
}

const score = i => (i.rating?.v || 0) * Math.log10((i.rating?.n || 0) + 10);

/**
 * One person's week. `items` is the catalogue (with `recent` on podcasts), `listIds` their My List,
 * `stories` the top briefing stories ({date,title,domains}), `whatsnew` What's New entries ({day,title,body}),
 * `domains` the taxonomy domain list (for the "fill a gap" pick). `since` is the first day included (YYYY-MM-DD).
 */
export function weeklyDigest({ items, listIds, stories = [], whatsnew = [], domains = [], since }) {
  const saved = new Set(listIds);
  const pods = items.filter(i => i.type === "podcast" && saved.has(i.id) && !i.hidden);
  const shows = pods.map(i => ({ item: i, eps: (i.recent || []).filter(e => e && e.t && e.d >= since).sort((a, b) => b.d.localeCompare(a.d)) }))
    .sort((a, b) => (b.eps[0]?.d || "").localeCompare(a.eps[0]?.d || "") || b.eps.length - a.eps.length);
  const topics = new Set(pods.flatMap(i => i.domains || []));
  const newPods = items.filter(i => i.type === "podcast" && !i.hidden && !saved.has(i.id) && i.added && i.added >= since && (i.domains || []).some(d => topics.has(d))).slice(0, 3);
  const used = new Set(newPods.map(i => i.id));
  const size = k => items.filter(i => i.type === "podcast" && !i.hidden && (i.domains || []).includes(k)).length;
  let gap = null;
  for (const g of domains.filter(d => !topics.has(d.key)).sort((a, b) => size(b.key) - size(a.key))) {
    const p = items.filter(i => i.type === "podcast" && i.curator && !i.hidden && !saved.has(i.id) && !used.has(i.id) && (i.domains || []).includes(g.key)).sort((a, b) => score(b) - score(a))[0];
    if (p) { gap = { domain: g, item: p }; break; }
  }
  const seenDay = new Set();
  const highlights = stories.filter(t => t && t.title && t.date >= since && (t.domains || []).some(d => topics.has(d)) && !seenDay.has(t.date) && seenDay.add(t.date)).slice(0, 3);
  const news = whatsnew.filter(w => w && w.day >= since).slice(0, 3);
  const active = shows.filter(s => s.eps.length), quiet = shows.filter(s => !s.eps.length);
  const episodes = active.reduce((n, s) => n + s.eps.length, 0);
  // Worth sending only when something happened: new episodes from their podcasts, or a new feature.
  return { podcasts: pods.length, active, quiet, episodes, highlights, newPods, gap, news, worthSending: episodes > 0 || news.length > 0 };
}

/** The Monday a weekly email covers up to: the week is the 7 days before `today` (YYYY-MM-DD, London). */
export function weekStart(today) {
  const d = new Date(today + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() - 7);
  return d.toISOString().slice(0, 10);
}
