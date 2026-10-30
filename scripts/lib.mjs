// Helpers shared by the seed, refresh and export scripts.
import { TableClient, odata } from "@azure/data-tables";
export { odata };

export async function itemsTable() {
  const c = process.env.STORAGE_CONNECTION_STRING;
  if (!c) throw new Error("Set STORAGE_CONNECTION_STRING (Azure Storage account connection string).");
  const t = TableClient.fromConnectionString(c, "items");
  try { await t.createTable(); } catch (e) { if (e.statusCode !== 409) throw e; }
  return t;
}
export const rowToItem = r => ({ ...JSON.parse(r.data), id: r.rowKey, hidden: !!r.hidden, community: { up: r.up || 0, down: r.down || 0 } });
export function itemToRow(item, existing = {}) {
  const { community, hidden, id, ...data } = item;
  return { partitionKey: "item", rowKey: id, data: JSON.stringify(data), hidden: !!(hidden ?? existing.hidden), up: existing.up ?? 0, down: existing.down ?? 0 };
}
export async function listItems(t) {
  const out = [];
  for await (const r of t.listEntities({ queryOptions: { filter: odata`PartitionKey eq 'item'` } })) out.push({ row: r, item: rowToItem(r) });
  return out;
}
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const UA = "MyCyberLearningBot/1.0 (+https://mycyberlearning.co.uk/about)";
export async function getText(url, { timeoutMs = 15000 } = {}) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: { "user-agent": UA, accept: "*/*" }, signal: ctrl.signal, redirect: "follow" });
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    return await r.text();
  } finally { clearTimeout(t); }
}
export const getJson = async (url, o) => JSON.parse(await getText(url, o));
