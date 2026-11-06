// Sends queued admin update emails ("new features and releases") to verified account emails that opted in.
//   node scripts/send-updates.mjs            send what today's email allowance leaves room for
//   node scripts/send-updates.mjs --dry-run  say who would be sent what, send nothing
// The daily briefing has priority: this only uses what's left of the plan's daily limit after the briefing and
// confirmation emails, and picks up where it left off the next day. Every recipient is logged so nobody gets one twice.
// Needs: the D1 settings (see scripts/d1.mjs), MAIL_PROVIDER, MAIL_API_KEY, MAIL_FROM, TOKEN_SECRET, SITE_URL
import { writeFile } from "node:fs/promises";
import { renderUpdateEmail, sendMail, londonDate } from "../worker/src/lib/mail.js";
import { updatesUnsubUrl } from "../worker/src/account-email.js";
import { openD1 } from "./d1.mjs";
import { sleep } from "./lib.mjs";

const dry = process.argv.includes("--dry-run");
const SITE = (process.env.SITE_URL || "https://mycyberlearning.co.uk").replace(/\/$/, "");
const PER_MINUTE = Number(process.env.MAIL_RATE_PER_MINUTE) || 25;
const DAILY_LIMIT = Number(process.env.MAIL_DAILY_LIMIT) || ((process.env.MAIL_PROVIDER || "resend") === "brevo" ? 300 : 100);
const RESERVE = Number(process.env.MAIL_RESERVE) || 10; // keep a few sends free for sign-up and sign-in emails later today

const db = await openD1();
const today = londonDate(), day = new Date().toISOString().slice(0, 10);
const queued = (await db.prepare("SELECT * FROM announcements WHERE status = 'queued' ORDER BY queued_at").all()).results;
if (!queued.length) { console.log("No update emails queued."); process.exit(0); }

const briefing = (await db.prepare("SELECT sent FROM digestlog WHERE date = ?").bind(today).first())?.sent || 0;
const other = (await db.prepare("SELECT COALESCE(SUM(n), 0) AS n FROM stats WHERE day = ? AND dim = 'mail' AND val IN ('confirm', 'test', 'update')").bind(day).first())?.n || 0;
let room = Math.max(0, DAILY_LIMIT - RESERVE - briefing - other);
console.log(`Daily limit ${DAILY_LIMIT}: briefing ${briefing}, other ${other}, reserve ${RESERVE} → room for ${room} update emails today`);

let summary = "";
for (const u of queued) {
  const { results: people } = await db.prepare(`SELECT a.id, a.email, a.name FROM accounts a
      WHERE a.updates_opt_in = 1 AND a.email IS NOT NULL AND a.email_verified_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM announce_log l WHERE l.announcement_id = ? AND l.account_id = a.id)
      ORDER BY a.created_at`).bind(u.id).all();
  let sent = 0, failed = 0;
  for (const p of people) {
    if (room <= 0) break;
    if (dry) { sent++; room--; continue; }
    try {
      const unsub = updatesUnsubUrl(SITE, p.id);
      const m = renderUpdateEmail({ subject: u.subject, body: u.body, name: p.name, siteUrl: SITE, unsubscribeUrl: unsub });
      await sendMail({ to: p.email, ...m, headers: { "List-Unsubscribe": `<${unsub}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } });
      await db.batch([
        db.prepare("INSERT INTO announce_log (announcement_id, account_id, sent_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING").bind(u.id, p.id, new Date().toISOString()),
        db.prepare("INSERT INTO stats (day, dim, val, n) VALUES (?, 'mail', 'update', 1) ON CONFLICT(day, dim, val) DO UPDATE SET n = n + 1").bind(day)
      ]);
      sent++; room--;
    } catch (e) { failed++; console.warn(`update send failed for one recipient: ${e.message}`); } // never log addresses
    await sleep(Math.ceil(60000 / PER_MINUTE));
  }
  const left = people.length - sent - failed;
  if (!dry) await db.prepare(`UPDATE announcements SET sent = sent + ?, failed = failed + ?, status = ?, finished_at = ? WHERE id = ?`)
    .bind(sent, failed, left > 0 || failed ? "queued" : "done", left > 0 || failed ? null : new Date().toISOString(), u.id).run();
  const line = `"${u.subject}": sent ${sent}, failed ${failed}, still to send ${left}${left ? " (continues tomorrow)" : ""}`;
  console.log((dry ? "[dry run] " : "") + line); summary += `- ${line}\n`;
  if (room <= 0) break;
}
if (process.env.GITHUB_STEP_SUMMARY) await writeFile(process.env.GITHUB_STEP_SUMMARY, `## Update emails\n\n${summary}`, { flag: "a" });
