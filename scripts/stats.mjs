// Site stats: totals only (never an email address or anything else personal). Same numbers as Admin → Subscribers & visitors.
//   node scripts/stats.mjs [--days 30]   (needs CLOUDFLARE_ACCOUNT_ID, D1_DATABASE_ID, CLOUDFLARE_API_TOKEN, or D1_LOCAL_FILE)
import { appendFile } from "node:fs/promises";
import { openD1 } from "./lib.mjs";

const i = process.argv.indexOf("--days"), days = Math.min(365, Math.max(1, Number(process.argv[i + 1]) || 30));
const db = await openD1(), since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
const one = async (sql, ...a) => (await db.prepare(sql).bind(...a).first().catch(() => null)) || {};
const all = async (sql, ...a) => (await db.prepare(sql).bind(...a).all().catch(() => ({ results: [] }))).results;

const subs = await all("SELECT status, COUNT(*) AS n FROM subscribers GROUP BY status");
const newSubs = await one("SELECT COUNT(*) AS n FROM subscribers WHERE status = 'active' AND confirmed_at >= ?", since);
const acc = await one("SELECT (SELECT COUNT(*) FROM accounts) AS total, (SELECT COUNT(*) FROM accounts WHERE last_seen >= ?) AS active, (SELECT COUNT(*) FROM accounts WHERE email_verified_at IS NOT NULL) AS withEmail, (SELECT COUNT(*) FROM accounts WHERE updates_opt_in = 1) AS updates, (SELECT COUNT(*) FROM favourites) AS saved", since);
const visits = await all("SELECT dim, val, SUM(n) AS n FROM stats WHERE day >= ? GROUP BY dim, val ORDER BY n DESC", since);
const byDay = await all("SELECT day, SUM(n) AS n FROM stats WHERE day >= ? AND dim = 'total' GROUP BY day ORDER BY day", since);
const votes = await one("SELECT COUNT(*) AS n, COUNT(DISTINCT voter) AS voters FROM votes WHERE at >= ?", since);
const subsQ = await one("SELECT COUNT(*) AS n FROM submissions WHERE submitted >= ?", since);
const reports = await one("SELECT COUNT(*) AS n FROM reports WHERE created >= ?", since);
const items = await all("SELECT json_extract(data, '$.type') AS type, COUNT(*) AS n FROM items WHERE hidden = 0 GROUP BY type");

const total = byDay.reduce((a, r) => a + r.n, 0), dims = d => visits.filter(v => v.dim === d).slice(0, 8);
const lines = [
  `## My Cyber Learning: last ${days} days (since ${since})`, "",
  `**Page views:** ${total} (about ${Math.round(total / days)} a day)`,
  `**Busiest days:** ${[...byDay].sort((a, b) => b.n - a.n).slice(0, 3).map(r => `${r.day} (${r.n})`).join(", ") || "none yet"}`, "",
  `**Daily briefing subscribers:** ${subs.map(r => `${r.status} ${r.n}`).join(", ") || "none"}; new in this period: ${newSubs.n ?? 0}`,
  `**My list accounts:** ${acc.total ?? 0} in all, ${acc.active ?? 0} active in this period, ${acc.withEmail ?? 0} with a confirmed email, ${acc.updates ?? 0} opted in to update emails, ${acc.saved ?? 0} items saved`,
  `**Engagement:** ${votes.n ?? 0} votes from ${votes.voters ?? 0} voters, ${subsQ.n ?? 0} suggestions, ${reports.n ?? 0} problem reports`,
  `**Catalogue:** ${items.map(r => `${r.n} ${r.type}s`).join(", ")}`, "",
  ...["page", "ref", "region", "device", "lang"].map(d => `**Top ${({ page: "pages", ref: "referrers", region: "regions", device: "devices", lang: "languages" })[d]}:** ${dims(d).map(v => `${v.val || "(none)"} ${v.n}`).join(", ") || "none"}`),
  "", "### Page views by day", "", ...byDay.map(r => `- ${r.day}: ${r.n}`)
];
console.log(lines.join("\n"));
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
