// Emails the latest briefing to confirmed subscribers.
//   node scripts/send-digest.mjs             send (only between 08:00 and 08:59 London time, once per day)
//   node scripts/send-digest.mjs --force     ignore the time window (still once per day)
//   node scripts/send-digest.mjs --preview   write an HTML preview to email-preview.html (repo root, git-ignored) and send nothing
// Needs: the D1 settings (see scripts/d1.mjs), MAIL_PROVIDER, MAIL_API_KEY, MAIL_FROM, TOKEN_SECRET, SITE_URL
import { readFile, writeFile } from "node:fs/promises";
import { renderDigestEmail, sendMail, signToken, londonHour, londonDate } from "../worker/src/lib/mail.js";
import { openD1 } from "./d1.mjs";
import { sleep } from "./lib.mjs";

const args = process.argv.slice(2);
const force = args.includes("--force"), preview = args.includes("--preview");
const SITE = (process.env.SITE_URL || "https://mycyberlearning.co.uk").replace(/\/$/, "");
const PER_MINUTE = Number(process.env.MAIL_RATE_PER_MINUTE) || 25;
// Free email plans cap sends per day (Resend free: 100, Brevo free: 300). Stop cleanly at the cap instead of erroring per message.
const DAILY_LIMIT = Number(process.env.MAIL_DAILY_LIMIT) || ((process.env.MAIL_PROVIDER || "resend") === "brevo" ? 300 : 100);

const digest = JSON.parse(await readFile(new URL("../frontend/news/latest.json", import.meta.url), "utf8"));
const catalogue = JSON.parse(await readFile(new URL("../data/catalogue.json", import.meta.url), "utf8"));
const shows = Object.fromEntries(catalogue.items.filter(i => i.type === "podcast").map(i => [i.id, i.name]));
const unsubUrl = id => `${SITE}/api/unsubscribe?s=${id}&t=${signToken("unsubscribe", id)}`;

if (preview) {
  process.env.TOKEN_SECRET ||= "preview-only-secret-not-used-for-real-mail-000";
  const m = renderDigestEmail({ digest, shows, siteUrl: SITE, unsubscribeUrl: unsubUrl("0".repeat(40)), name: "Ian", interests: ["ai"] });
  await writeFile(new URL("../email-preview.html", import.meta.url), m.html);
  console.log(`Preview written to email-preview.html (not part of the site)\nSubject: ${m.subject}`);
  process.exit(0);
}

const today = londonDate();
if (!force && londonHour() !== 8) { console.log(`Not 08:00-08:59 in London (it's ${londonHour()}:xx); skipping.`); process.exit(0); }
if (digest.date !== today) { console.log(`Latest briefing is for ${digest.date}, not ${today}; not sending a stale briefing.`); process.exit(0); }

const db = await openD1();
// Claim today's send. If an earlier run stopped part-way, resume it: subscribers already sent today are skipped.
// (The workflow's concurrency group stops two runs sending at once.)
const claim = await db.prepare("SELECT * FROM digestlog WHERE date = ?").bind(today).first();
if (claim?.status === "done") { console.log(`Briefing for ${today} already sent; nothing to do.`); process.exit(0); }
if (claim) console.log(`Resuming an unfinished send for ${today}.`);
else await db.prepare("INSERT INTO digestlog (date, status, started_at) VALUES (?, 'sending', ?)").bind(today, new Date().toISOString()).run();

const { results: subs } = await db.prepare("SELECT id, status, email, name, interests, last_sent FROM subscribers WHERE status = 'active' ORDER BY confirmed_at").all();
let sent = 0, failed = 0, capped = 0;
for (const s of subs) {
  if (s.status !== "active" || !s.email) continue; // belt and braces: never mail unconfirmed or suppressed rows
  if (s.last_sent === today) continue;             // already sent in an earlier, interrupted run
  if ((claim?.sent || 0) + sent >= DAILY_LIMIT) { capped++; continue; }
  try {
    const m = renderDigestEmail({ digest, shows, siteUrl: SITE, unsubscribeUrl: unsubUrl(s.id), name: s.name, interests: JSON.parse(s.interests || "[]") });
    await sendMail({ to: s.email, ...m, headers: { "List-Unsubscribe": `<${unsubUrl(s.id)}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } });
    await db.prepare("UPDATE subscribers SET last_sent = ? WHERE id = ?").bind(today, s.id).run();
    sent++;
  } catch (e) { failed++; console.warn(`send failed for one subscriber: ${e.message}`); } // never log addresses
  await sleep(Math.ceil(60000 / PER_MINUTE));
}
await db.prepare("UPDATE digestlog SET status = ?, sent = ?, failed = ?, finished_at = ? WHERE date = ?")
  .bind(failed ? "sending" : "done", (claim?.sent || 0) + sent, failed, new Date().toISOString(), today).run();
if (capped) console.log(`Daily email limit (${DAILY_LIMIT}) reached: ${capped} subscribers were not sent today's briefing. Upgrade the email plan or raise MAIL_DAILY_LIMIT.`);
if (failed) { console.log(`${failed} sends failed; re-run the workflow to retry just those.`); process.exitCode = 1; }
console.log(`Briefing ${today}: sent ${sent}, failed ${failed}, over daily limit ${capped}`);
if (process.env.GITHUB_STEP_SUMMARY) await writeFile(process.env.GITHUB_STEP_SUMMARY, `## Daily briefing ${today}\n\n- Sent: ${sent}\n- Failed: ${failed}\n- Not sent (daily limit): ${capped}\n`, { flag: "a" });
