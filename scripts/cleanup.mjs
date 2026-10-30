// Data retention (runs daily from the news workflow). Matches the privacy notice:
//  - unconfirmed sign-ups are deleted after 7 days
//  - aggregate visit counters older than 13 months are deleted
//  - suggestions pending over 90 days lose the submitter's email and IP hash
import { TableClient, odata } from "@azure/data-tables";

const conn = process.env.STORAGE_CONNECTION_STRING;
if (!conn) throw new Error("STORAGE_CONNECTION_STRING is not set");
const now = Date.now();
const subs = TableClient.fromConnectionString(conn, "subscribers");
let pending = 0;
try {
  for await (const r of subs.listEntities({ queryOptions: { filter: odata`PartitionKey eq 'sub' and status eq 'pending'` } })) {
    if (r.status === "pending" && Date.parse(r.requestedAt || 0) < now - 7 * 864e5) { await subs.deleteEntity("sub", r.rowKey); pending++; }
  }
} catch (e) { if (e.statusCode !== 404) throw e; }

const stats = TableClient.fromConnectionString(conn, "stats");
const cutoff = new Date(now - 395 * 864e5).toISOString().slice(0, 10);
let old = 0;
try {
  for await (const r of stats.listEntities({ queryOptions: { filter: odata`PartitionKey lt ${cutoff}` } })) { await stats.deleteEntity(r.partitionKey, r.rowKey); old++; }
} catch (e) { if (e.statusCode !== 404) throw e; }
// Suggestions waiting more than 90 days: drop the submitter's email and IP hash, keep the suggestion itself.
const subsT = TableClient.fromConnectionString(conn, "submissions");
let scrubbed = 0;
try {
  for await (const r of subsT.listEntities({ queryOptions: { filter: odata`PartitionKey eq 'pending'` } })) {
    if (Date.parse(r.submitted || 0) >= now - 90 * 864e5) continue;
    const { email, ...rest } = JSON.parse(r.data || "{}");
    if (!email && !r.ipHash) continue;
    await subsT.updateEntity({ partitionKey: r.partitionKey, rowKey: r.rowKey, data: JSON.stringify(rest), ipHash: "" }, "Merge"); scrubbed++;
  }
} catch (e) { if (e.statusCode !== 404) throw e; }
console.log(`Retention: deleted ${pending} unconfirmed sign-ups and ${old} old visit counters; removed contact details from ${scrubbed} old suggestions.`);
