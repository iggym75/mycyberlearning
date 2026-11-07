// Data retention (runs daily from the news workflow). Matches the privacy notice:
//  - unconfirmed sign-ups are deleted after 7 days
//  - aggregate visit counters older than 13 months are deleted
//  - suggestions pending over 90 days lose the submitter's email and IP hash
//  - My list accounts not used for two years are deleted with their passkeys and list; expired passkey challenges go
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
const cutoff = iso(now - 730 * 864e5);
const staleRows = (await db.prepare("SELECT id, email_id FROM accounts WHERE COALESCE(last_seen, created_at) < ?").bind(cutoff).all()).results;
const stale = staleRows.map(r => r.id);
// An unused account's briefing stops with it, as the privacy notice says (suppress clears every personal field).
for (const r of staleRows) if (r.email_id) await db.prepare(`UPDATE subscribers SET status = 'suppressed', email = NULL, name = NULL, country = NULL, interests = NULL,
  token_hash = NULL, token_expires = NULL, consent_text = NULL, requested_at = NULL, window_start = NULL, sends = 0, confirmed_at = NULL, last_sent = NULL,
  suppressed_at = ?, reason = 'account deleted (unused)' WHERE id = ?`).bind(iso(now), r.email_id).run();
for (const id of stale) await db.batch([
  db.prepare("DELETE FROM login_links WHERE account_id = ?").bind(id),
  db.prepare("DELETE FROM favourites WHERE account_id = ?").bind(id),
  db.prepare("DELETE FROM passkeys WHERE account_id = ?").bind(id),
  db.prepare("DELETE FROM accounts WHERE id = ?").bind(id)
]);
await db.prepare("DELETE FROM webauthn_challenges WHERE expires < ?").bind(now).run();
// Unconfirmed account email addresses and stale sign-in links are removed once their links expire.
await db.prepare("UPDATE accounts SET email_pending = NULL, email_token_hash = NULL, email_token_expires = NULL WHERE email_token_expires < ?").bind(iso(now)).run();
await db.prepare("DELETE FROM login_links WHERE expires < ?").bind(iso(now)).run();
console.log(`Retention: ${stale.length} unused My list accounts deleted.`);
console.log(`Retention: deleted ${pending.meta.changes ?? 0} unconfirmed sign-ups and ${old.meta.changes ?? 0} old visit counters; removed contact details from ${scrubbed} old suggestions.`);
