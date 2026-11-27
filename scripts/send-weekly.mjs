// Sends the weekly My List update (Mondays 08:00 UK) to account holders who ticked it, with a confirmed address.
//   node scripts/send-weekly.mjs             send (only on Monday between 08:00 and 08:59 London time)
//   node scripts/send-weekly.mjs --force     send now, whatever the day (still once a day per person)
//   node scripts/send-weekly.mjs --dry-run   say how many would get one, send nothing
//   node scripts/send-weekly.mjs --preview   write weekly-preview.html from the catalogue and the briefing files (no D1, no email)
// Podcasts only. A person is skipped when nothing happened for them (no new episodes from their podcasts, no new feature).
// The 08:30 briefing has priority: this leaves room in the day's email allowance for every briefing subscriber.
// Needs: the D1 settings (see scripts/d1.mjs), MAIL_PROVIDER, MAIL_API_KEY, MAIL_FROM, TOKEN_SECRET, SITE_URL
import { readFile, readdir, writeFile } from "node:fs/promises";
import { renderWeeklyEmail, sendMail, londonDate, londonHour } from "../worker/src/lib/mail.js";
import { weeklyDigest, weekStart } from "../worker/src/lib/weekly.js";
import { weeklyUnsubUrl } from "../worker/src/account-email.js";
import { listItems } from "../worker/src/lib/db.js";
import { pathOf } from "./site-pages.mjs";
import { sleep } from "./lib.mjs";

const args = process.argv.slice(2), dry = args.includes("--dry-run"), force = args.includes("--force"), preview = args.includes("--preview");
const SITE = (process.env.SITE_URL || "https://mycyberlearning.co.uk").replace(/\/$/, "");
const PER_MINUTE = Number(process.env.MAIL_RATE_PER_MINUTE) || 25;
const DAILY_LIMIT = Number(process.env.MAIL_DAILY_LIMIT) || ((process.env.MAIL_PROVIDER || "resend") === "brevo" ? 300 : 100);
const RESERVE = Number(process.env.MAIL_RESERVE) || 10;
const root = new URL("../", import.meta.url);
const taxonomy = JSON.parse(await readFile(new URL("data/taxonomy.json", root), "utf8"));

// Top stories from the last 7 published briefings (the same as news/week.json on the site).
async function weekStories() {
  const dir = new URL("frontend/news/", root);
  const days = (await readdir(dir).catch(() => [])).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().slice(-8).reverse();
  const out = [];
  for (const f of days) {
    const d = JSON.parse(await readFile(new URL(f, dir), "utf8").catch(() => "null"));
    for (const t of (d?.topStories || []).slice(0, 4)) if (t?.title) out.push({ date: d.date, title: String(t.title).slice(0, 160), domains: t.domains || [] });
  }
  return out;
}
const today = londonDate(), since = weekStart(today), stories = await weekStories();
const pagePath = i => pathOf(i);

if (preview) {
  process.env.TOKEN_SECRET ||= "preview-only-secret-not-used-for-real-mail-000";
  const cat = JSON.parse(await readFile(new URL("data/catalogue.json", root), "utf8"));
  // Recent episodes from the briefing files stand in for the live `recent` field.
  const recent = {};
  for (const f of (await readdir(new URL("frontend/news/", root))).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().slice(-7)) {
    const d = JSON.parse(await readFile(new URL(`frontend/news/${f}`, root), "utf8"));
    for (const e of d.episodes || []) (recent[e.show] ||= []).push({ d: d.date, t: e.title });
  }
  const items = cat.items.map(i => recent[i.id] ? { ...i, recent: recent[i.id] } : i);
  const ids = ["cyberwire-daily", "risky-business", "sans-stormcast", "security-now", "smashing-security", "darknet-diaries"].filter(id => items.some(i => i.id === id));
  const latest = Object.values(recent).flat().map(e => e.d).sort().pop() || today;
  const week = weeklyDigest({ items, listIds: ids, stories, domains: taxonomy.domains, since: weekStart(latest),
    whatsnew: [{ day: latest, title: "Weekly My List update", body: "Every Monday: new episodes from your podcasts, and what's new on the site." }] });
  const m = renderWeeklyEmail({ week, name: "Iggy", siteUrl: SITE, unsubscribeUrl: weeklyUnsubUrl(SITE, "A".repeat(22)), pagePath, today: latest });
  await writeFile(new URL("weekly-preview.html", root), m.html);
  console.log(`Preview written to weekly-preview.html (not part of the site)\nSubject: ${m.subject}`);
  process.exit(0);
}

if (!force && !dry && (new Date().toLocaleDateString("en-GB", { weekday: "long", timeZone: "Europe/London" }) !== "Monday" || londonHour() !== 8)) {
  console.log(`Not Monday 08:00-08:59 in London; skipping.`); process.exit(0);
}

const { openD1 } = await import("./d1.mjs");
const db = await openD1();
const items = await listItems(db);
const whatsnew = (await db.prepare("SELECT day, title, body FROM whatsnew WHERE day >= ? ORDER BY day DESC, id DESC").bind(since).all()).results || [];
const day = new Date().toISOString().slice(0, 10);
// Keep room for the briefing at 08:30 (every active subscriber), for confirmation and sign-in emails, and for anything sent today.
const subscribers = (await db.prepare("SELECT COUNT(*) AS n FROM subscribers WHERE status = 'active'").first())?.n || 0;
const briefingSent = (await db.prepare("SELECT sent FROM digestlog WHERE date = ?").bind(today).first())?.sent || 0;
const other = (await db.prepare("SELECT COALESCE(SUM(n), 0) AS n FROM stats WHERE day = ? AND dim = 'mail'").bind(day).first())?.n || 0;
let room = Math.max(0, DAILY_LIMIT - RESERVE - Math.max(0, subscribers - briefingSent) - briefingSent - other);
console.log(`Daily limit ${DAILY_LIMIT}: briefing subscribers ${subscribers}, other mail today ${other}, reserve ${RESERVE} → room for ${room} weekly emails`);

const { results: people } = await db.prepare(`SELECT id FROM accounts WHERE weekly_opt_in = 1 AND email IS NOT NULL AND email_verified_at IS NOT NULL
    AND (weekly_last_sent IS NULL OR weekly_last_sent < ?) ORDER BY created_at`).bind(today).all();
let sent = 0, skipped = 0, failed = 0, capped = 0;
for (const { id } of people) {
  // Re-read just before sending, so anyone who unsubscribed during the run is skipped.
  const p = await db.prepare("SELECT id, email, name, weekly_last_sent FROM accounts WHERE id = ? AND weekly_opt_in = 1 AND email IS NOT NULL AND email_verified_at IS NOT NULL").bind(id).first();
  if (!p || (p.weekly_last_sent && p.weekly_last_sent >= today)) continue;
  const listIds = ((await db.prepare("SELECT item_id FROM favourites WHERE account_id = ?").bind(id).all()).results || []).map(r => r.item_id);
  const week = weeklyDigest({ items, listIds, stories, whatsnew, domains: taxonomy.domains, since });
  if (!week.podcasts || !week.worthSending) { skipped++; if (!dry) await db.prepare("UPDATE accounts SET weekly_last_sent = ? WHERE id = ?").bind(today, id).run(); continue; }
  if (room <= 0) { capped++; continue; }
  if (dry) { sent++; room--; continue; }
  // Mark first, so a re-run never sends twice; put it back if the send fails.
  await db.prepare("UPDATE accounts SET weekly_last_sent = ? WHERE id = ?").bind(today, id).run();
  try {
    const unsub = weeklyUnsubUrl(SITE, id);
    const m = renderWeeklyEmail({ week, name: p.name, siteUrl: SITE, unsubscribeUrl: unsub, pagePath, today });
    await sendMail({ to: p.email, ...m, headers: { "List-Unsubscribe": `<${unsub}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } });
    await db.prepare("INSERT INTO stats (day, dim, val, n) VALUES (?, 'mail', 'weekly', 1) ON CONFLICT(day, dim, val) DO UPDATE SET n = n + 1").bind(day).run().catch(() => {});
    sent++; room--;
  } catch (e) {
    failed++; console.warn(`weekly send failed for one recipient: ${e.message}`); // never log addresses
    await db.prepare("UPDATE accounts SET weekly_last_sent = ? WHERE id = ?").bind(p.weekly_last_sent, id).run().catch(() => {});
  }
  await sleep(Math.ceil(60000 / PER_MINUTE));
}
const line = `Weekly update ${today}: sent ${sent}, nothing new for ${skipped}, failed ${failed}, over daily limit ${capped}`;
console.log((dry ? "[dry run] " : "") + line);
if (capped) console.log(`${capped} people didn't get this week's update because of the daily email limit.`);
if (failed) process.exitCode = 1;
if (process.env.GITHUB_STEP_SUMMARY) await writeFile(process.env.GITHUB_STEP_SUMMARY, `## Weekly My List update\n\n- ${line}\n`, { flag: "a" });
