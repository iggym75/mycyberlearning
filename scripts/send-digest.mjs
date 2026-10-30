// Emails the latest briefing to confirmed subscribers.
//   node scripts/send-digest.mjs             send (only between 06:00 and 06:59 London time, once per day)
//   node scripts/send-digest.mjs --force     ignore the time window (still once per day)
//   node scripts/send-digest.mjs --preview   write an HTML preview to email-preview.html (repo root, git-ignored) and send nothing
// Needs: STORAGE_CONNECTION_STRING, ACS_CONNECTION_STRING, MAIL_FROM, TOKEN_SECRET, SITE_URL
import { readFile, writeFile } from "node:fs/promises";
import { TableClient, odata } from "@azure/data-tables";
import { renderDigestEmail, sendMail, signToken, londonHour, londonDate } from "../api/src/lib/mail.js";
import { sleep } from "./lib.mjs";

const args = process.argv.slice(2);
const force = args.includes("--force"), preview = args.includes("--preview");
const SITE = (process.env.SITE_URL || "https://mycyberlearning.co.uk").replace(/\/$/, "");
const PER_MINUTE = Number(process.env.MAIL_RATE_PER_MINUTE) || 25; // ACS default limits are low; raise after a support request

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
if (!force && londonHour() !== 6) { console.log(`Not 06:00-06:59 in London (it's ${londonHour()}:xx); skipping.`); process.exit(0); }
if (digest.date !== today) { console.log(`Latest briefing is for ${digest.date}, not ${today}; not sending a stale briefing.`); process.exit(0); }

const conn = process.env.STORAGE_CONNECTION_STRING;
const log = TableClient.fromConnectionString(conn, "digestlog");
try { await log.createTable(); } catch (e) { if (e.statusCode !== 409) throw e; }
// Claim today's send. If an earlier run stopped part-way, resume it: subscribers already sent today are skipped.
// (The workflow's concurrency group stops two runs sending at once.)
let claim = null;
try { claim = await log.getEntity("sent", today); } catch (e) { if (e.statusCode !== 404) throw e; }
if (claim?.status === "done") { console.log(`Briefing for ${today} already sent; nothing to do.`); process.exit(0); }
if (claim) console.log(`Resuming an unfinished send for ${today}.`);
else await log.createEntity({ partitionKey: "sent", rowKey: today, startedAt: new Date().toISOString(), status: "sending" });

const subs = TableClient.fromConnectionString(conn, "subscribers");
let sent = 0, failed = 0;
for await (const s of subs.listEntities({ queryOptions: { filter: odata`PartitionKey eq 'sub' and status eq 'active'` } })) {
  if (s.partitionKey !== "sub" || s.status !== "active") continue; // belt and braces: never mail unconfirmed addresses
  if (s.lastSent === today) continue;                               // already sent in an earlier, interrupted run
  try {
    const m = renderDigestEmail({ digest, shows, siteUrl: SITE, unsubscribeUrl: unsubUrl(s.rowKey), name: s.name, interests: JSON.parse(s.interests || "[]") });
    await sendMail({ to: s.email, ...m, headers: { "List-Unsubscribe": `<${unsubUrl(s.rowKey)}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } }, { wait: false });
    await subs.updateEntity({ partitionKey: "sub", rowKey: s.rowKey, lastSent: today }, "Merge");
    sent++;
  } catch (e) { failed++; console.warn(`send failed for one subscriber: ${e.message}`); } // never log addresses
  await sleep(Math.ceil(60000 / PER_MINUTE));
}
await log.updateEntity({ partitionKey: "sent", rowKey: today, status: failed ? "sending" : "done", sent: (claim?.sent || 0) + sent, failed, finishedAt: new Date().toISOString() }, "Merge");
if (failed) { console.log(`${failed} sends failed; re-run the workflow to retry just those.`); process.exitCode = 1; }
console.log(`Briefing ${today}: sent ${sent}, failed ${failed}`);
if (process.env.GITHUB_STEP_SUMMARY) await writeFile(process.env.GITHUB_STEP_SUMMARY, `## Daily briefing ${today}\n\n- Sent: ${sent}\n- Failed: ${failed}\n`, { flag: "a" });
