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

// The briefing log is keyed by the London date and the counters by the UTC date; this runs at 10:17 UTC, when they agree.
const briefing = (await db.prepare("SELECT sent FROM digestlog WHERE date = ?").bind(today).first())?.sent || 0;
const other = (await db.prepare("SELECT COALESCE(SUM(n), 0) AS n FROM stats WHERE day = ? AND dim = 'mail' AND val IN ('confirm', 'test', 'update')").bind(day).first())?.n || 0;
let room = Math.max(0, DAILY_LIMIT - RESERVE - briefing - other);
console.log(`Daily limit ${DAILY_LIMIT}: briefing ${briefing}, other ${other}, reserve ${RESERVE} → room for ${room} update emails today`);

let summary = "";
for (const u of queued) {
  // Everyone opted in with a confirmed address who hasn't been sent this one (or failed fewer than 3 times).
  const { results: people } = await db.prepare(`SELECT a.id FROM accounts a
      WHERE a.updates_opt_in = 1 AND a.email IS NOT NULL AND a.email_verified_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM announce_log l WHERE l.announcement_id = ? AND l.account_id = a.id AND (l.status <> 'failed' OR l.attempts >= 3))
      ORDER BY a.created_at`).bind(u.id).all();
  let sent = 0, failed = 0;
  for (const { id } of people) {
    if (room <= 0) break;
    // Re-read just before sending, so anyone who unsubscribed during a long send is skipped.
    const p = await db.prepare("SELECT id, email, name FROM accounts WHERE id = ? AND updates_opt_in = 1 AND email IS NOT NULL AND email_verified_at IS NOT NULL").bind(id).first();
    if (!p) continue;
    if (dry) { sent++; room--; continue; }
    // Log first: if the log write failed after a successful send, the person would get the email again tomorrow.
    await db.prepare(`INSERT INTO announce_log (announcement_id, account_id, status, attempts, sent_at) VALUES (?, ?, 'sending', 1, ?)
      ON CONFLICT(announcement_id, account_id) DO UPDATE SET status = 'sending', attempts = attempts + 1, sent_at = excluded.sent_at`).bind(u.id, p.id, new Date().toISOString()).run();
    try {
      const unsub = updatesUnsubUrl(SITE, p.id);
      const m = renderUpdateEmail({ subject: u.subject, body: u.body, name: p.name, siteUrl: SITE, unsubscribeUrl: unsub });
      await sendMail({ to: p.email, ...m, headers: { "List-Unsubscribe": `<${unsub}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } });
      await db.batch([
        db.prepare("UPDATE announce_log SET status = 'sent' WHERE announcement_id = ? AND account_id = ?").bind(u.id, p.id),
        db.prepare("INSERT INTO stats (day, dim, val, n) VALUES (?, 'mail', 'update', 1) ON CONFLICT(day, dim, val) DO UPDATE SET n = n + 1").bind(day)
      ]).catch(e => console.warn(`logged as sending, not sent: ${e.message}`)); // stays 'sending', so it isn't retried
      sent++; room--;
    } catch (e) {
      failed++; console.warn(`update send failed for one recipient: ${e.message}`); // never log addresses
      await db.prepare("UPDATE announce_log SET status = 'failed' WHERE announcement_id = ? AND account_id = ?").bind(u.id, p.id).run().catch(() => {});
    }
    await sleep(Math.ceil(60000 / PER_MINUTE));
  }
  const left = (await db.prepare(`SELECT COUNT(*) AS n FROM accounts a WHERE a.updates_opt_in = 1 AND a.email IS NOT NULL AND a.email_verified_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM announce_log l WHERE l.announcement_id = ? AND l.account_id = a.id AND (l.status <> 'failed' OR l.attempts >= 3))`).bind(u.id).first())?.n || 0;
  if (!dry) await db.prepare(`UPDATE announcements SET sent = sent + ?, failed = failed + ?, status = ?, finished_at = ? WHERE id = ?`)
    .bind(sent, failed, left > 0 ? "queued" : "done", left > 0 ? null : new Date().toISOString(), u.id).run();
  const line = `"${u.subject}": sent ${sent}, failed ${failed}, still to send ${left}${left ? " (continues tomorrow)" : ""}`;
  console.log((dry ? "[dry run] " : "") + line); summary += `- ${line}\n`;
  if (room <= 0) break;
}
if (process.env.GITHUB_STEP_SUMMARY) await writeFile(process.env.GITHUB_STEP_SUMMARY, `## Update emails\n\n${summary}`, { flag: "a" });
