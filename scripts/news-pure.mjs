// Dependency-free helpers for the daily briefing (unit-tested in scripts/test/news.test.mjs).

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", ndash: "–", mdash: "—", hellip: "…" };
/** Plain text from RSS HTML: drops tags/scripts/styles, decodes common entities, collapses whitespace. */
export function stripHtml(s, max = 1200) {
  return String(s ?? "")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/p>|<\/li>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => e[0] === "#" ? String.fromCodePoint(parseInt(e.slice(1).replace(/^x/i, ""), /^#x/i.test(e) ? 16 : 10) || 32) : (ENTITIES[e.toLowerCase()] ?? m))
    .replace(/[​-‍⁠﻿]/g, "")
    .replace(/[<>"`]/g, " ")   // after decoding: encoded markup can't become tags or prompt delimiters
    .replace(/\s+/g, " ").trim().slice(0, max);
}

/** Removes things a manipulated feed could use to phish readers: URLs, bare domains with paths, emails, phone numbers. */
export function scrubContacts(s) {
  return String(s ?? "")
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, "")
    .replace(/\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/gi, "")
    .replace(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|co|uk|info|biz|xyz|ru|cn|top|click|link|app|dev)\/\S*/gi, "")
    .replace(/(?<![\w-])(?:\+\d{1,3}[\s.-]?\(?\d{1,4}\)?|\(?0\d{2,4}\)?)(?:[\s.-]?\d{2,4}){2,3}(?![\w-])/g, "") // phone numbers starting + or 0 (not CVE ids or versions)
    .replace(/\s+([,.;:!?])/g, "$1").replace(/\s{2,}/g, " ").trim();
}

/** Parses "1:02:03", "62:03", "3723" (seconds) into whole minutes. */
export function durationMinutes(v) {
  if (v == null || v === "") return null;
  const parts = String(v).trim().split(":").map(Number);
  if (parts.some(n => !Number.isFinite(n))) return null;
  const secs = parts.length === 1 ? parts[0] : parts.reduce((t, n) => t * 60 + n, 0);
  return secs > 0 ? Math.max(1, Math.round(secs / 60)) : null;
}

/** Episodes published inside (now - hours, now]; newest first; capped per show. Future-dated items are excluded. */
export function inWindow(episodes, { now = Date.now(), hours = 24, perShow = 3 } = {}) {
  const from = now - hours * 3600e3;
  const seen = {};
  return episodes
    .map(e => ({ ...e, t: Date.parse(e.publishedAt) }))
    .filter(e => Number.isFinite(e.t) && e.t > from && e.t <= now)
    .sort((a, b) => b.t - a.t)
    .filter(e => (seen[e.show] = (seen[e.show] || 0) + 1) <= perShow)
    .map(({ t, ...e }) => e);
}

/** Fallback summary when Claude isn't available: first one or two sentences, no URLs, max ~220 chars. */
export function fallbackSummary(text, max = 220) {
  const clean = stripHtml(text, 2000).replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  const sentences = clean.match(/[^.!?]+[.!?]+/g) || [clean];
  let out = "";
  for (const s of sentences) { if ((out + s).length > max) break; out += s; }
  out = (out || clean.slice(0, max)).trim();
  return out.length < clean.length && !/[.!?]$/.test(out) ? out.replace(/\s+\S*$/, "") + "…" : out;
}

/** Keeps only well-formed output from the model: known refs and domains, bounded string lengths. */
export function validateDigest(raw, episodes, domainKeys) {
  const refs = new Set(episodes.map(e => e.ref));
  const str = (v, n) => typeof v === "string" ? scrubContacts(stripHtml(v, n * 2)).slice(0, n) : "";
  const doms = d => (Array.isArray(d) ? d : []).filter(x => domainKeys.includes(x)).slice(0, 4);
  const summaries = new Map((raw?.episodes || []).filter(e => refs.has(e?.ref)).map(e => [e.ref, { summary: str(e.summary, 400), domains: doms(e.domains) }]));
  return {
    headline: str(raw?.headline, 120),
    overview: str(raw?.overview, 600),
    topStories: (raw?.topStories || []).slice(0, 6).map(s => ({
      title: str(s?.title, 120), summary: str(s?.summary, 400),
      refs: (Array.isArray(s?.refs) ? s.refs : []).filter(r => refs.has(r)).slice(0, 6), domains: doms(s?.domains)
    })).filter(s => s.title && s.summary && s.refs.length),
    episodes: episodes.map(e => ({ ...e, summary: summaries.get(e.ref)?.summary || e.summary, domains: summaries.get(e.ref)?.domains?.length ? summaries.get(e.ref).domains : e.domains }))
  };
}

/** Archive maintenance: newest-first list of dates, keeping `keep` days. Returns { keepDates, dropDates }. */
export function pruneDates(dates, keep = 30) {
  const sorted = [...new Set(dates)].filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse();
  return { keepDates: sorted.slice(0, keep), dropDates: sorted.slice(keep) };
}
