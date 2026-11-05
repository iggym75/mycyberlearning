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

/** Shortens text to at most `max` characters at a sentence end (or a word end with "…"), never mid-word. */
export function clip(text, max) {
  const t = String(text ?? "").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  if (end > max * 0.4) return cut.slice(0, end + 1);
  return cut.slice(0, max - 1).replace(/\s+\S*$/, "").replace(/[,;:\s]+$/, "") + "…";
}

/** The model sometimes pastes structured data (e.g. "[{ title: …") into a prose field. Cut it off there. */
export function dropStructure(text) {
  const t = String(text ?? "");
  const i = t.search(/\[\s*\{|\{\s*"?(title|summary|refs|headline)"?\s*:/);
  return { text: (i >= 0 ? t.slice(0, i) : t).trim(), hadStructure: i >= 0 };
}

/** Window for this run: since the previous briefing (at least 24 h, at most 48 h), so late or early runs neither skip nor repeat episodes. */
export function windowHours(prevGeneratedAt, now = Date.now(), { min = 24, max = 48 } = {}) {
  const t = Date.parse(prevGeneratedAt);
  if (!Number.isFinite(t) || t >= now) return min;
  return Math.min(max, Math.max(min, Math.ceil((now - t) / 3600e3)));
}

export const epKey = e => `${e.show}|${String(e.title || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()}`;
/** Removes episodes already listed in earlier briefings (matched by show and title). */
export function dropSeen(episodes, previous = []) {
  const seen = new Set(previous.flatMap(b => (b?.episodes || []).map(epKey)));
  return episodes.filter(e => !seen.has(epKey(e)));
}

/** Core shows first, in the configured order; then the rest, newest first. */
export function orderEpisodes(episodes, core = []) {
  const rank = id => { const i = core.indexOf(id); return i < 0 ? core.length : i; };
  return [...episodes].sort((a, b) => rank(a.show) - rank(b.show) || Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
}

/** Plain text from a podcast transcript file (WebVTT, SRT, Podcasting 2.0 JSON, HTML or plain text). */
export function transcriptText(body, type = "") {
  const s = String(body ?? "");
  if (/json/i.test(type) || /^\s*\{/.test(s)) {
    try { const j = JSON.parse(s); return stripHtml((j.segments || []).map(x => x?.body || "").join(" "), 20000); } catch { /* fall through */ }
  }
  const CUE_TIME = /^\s*(?:\d+:)?\d{2}:\d{2}[.,]\d{3}\s/;   // a cue timing line starts with a timestamp, e.g. "00:00:01.000 …"
  if (/vtt|srt|subrip/i.test(type) || /^\s*WEBVTT/.test(s) || s.split(/\r?\n/).some(l => CUE_TIME.test(l))) {
    return stripHtml(s.replace(/^WEBVTT.*$/m, "").split(/\r?\n/)
      .filter(l => l.trim() && !CUE_TIME.test(l) && !/^\d+$/.test(l.trim()) && !/^(NOTE|STYLE|REGION)\b/.test(l))
      .map(l => l.replace(/<v\s+[^>]*>/g, "")).join(" "), 20000);
  }
  return stripHtml(s, 20000);
}

/** Keeps only well-formed output from the model: known refs and domains, bounded string lengths. */
export function validateDigest(raw, episodes, domainKeys) {
  const refs = new Set(episodes.map(e => e.ref));
  const str = (v, n) => typeof v === "string" ? clip(scrubContacts(dropStructure(stripHtml(v, n * 3)).text), n) : "";
  const doms = d => (Array.isArray(d) ? d : []).filter(x => domainKeys.includes(x)).slice(0, 4);
  const summaries = new Map((raw?.episodes || []).filter(e => refs.has(e?.ref)).map(e => [e.ref, { summary: str(e.summary, 400), domains: doms(e.domains) }]));
  return {
    headline: str(raw?.headline, 120),
    overview: str(raw?.overview, 700),
    malformed: [raw?.headline, raw?.overview].some(v => dropStructure(v).hadStructure),
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
