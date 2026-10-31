// Data retention (runs daily from the news workflow). Matches the privacy notice:
//  - unconfirmed sign-ups are deleted after 7 days
//  - aggregate visit counters older than 13 months are deleted
//  - suggestions pending over 90 days lose the submitter's email and IP hash
import { openD1 } from "./d1.mjs";

const db = await openD1();
const now = Date.now(), iso = ms => new Date(ms).toISOString();
const pending = await db.prepare("DELETE FROM subscribers WHERE status = 'pending' AND (requested_at IS NULL OR requested_at < ?)").bind(iso(now - 7 * 864e5)).run();
const old = await db.prepare("DELETE FROM stats WHERE day < ?").bind(iso(now - 395 * 864e5).slice(0, 10)).run();
const { results } = await db.prepare("SELECT id, data, ip_hash FROM submissions WHERE status = 'pending' AND submitted < ?").bind(iso(now - 90 * 864e5)).all();
let scrubbed = 0;
for (const r of results) {
  let data = {}; try { data = JSON.parse(r.data || "{}"); } catch {}
  if (!data.email && !r.ip_hash) continue;
  const { email, ...rest } = data;
  await db.prepare("UPDATE submissions SET data = ?, ip_hash = NULL WHERE id = ?").bind(JSON.stringify(rest), r.id).run();
  scrubbed++;
}
console.log(`Retention: deleted ${pending.meta.changes ?? 0} unconfirmed sign-ups and ${old.meta.changes ?? 0} old visit counters; removed contact details from ${scrubbed} old suggestions.`);
