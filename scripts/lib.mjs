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

/** Downloads an image into the site's covers folder. Returns the site-relative path, or null. */
export async function saveImage(url, name) {
  const { writeFile, mkdir } = await import("node:fs/promises");
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(url, { headers: { "user-agent": UA }, signal: ctrl.signal });
    const type = r.headers.get("content-type") || "";
    if (!r.ok || !type.startsWith("image/")) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 1500 || buf.length > 3_000_000) return null; // skip placeholders and oversized files
    const dir = new URL("../frontend/covers/", import.meta.url);
    await mkdir(dir, { recursive: true });
    await writeFile(new URL(`${name}.jpg`, dir), buf);
    return `covers/${name}.jpg`;
  } catch { return null; } finally { clearTimeout(t); }
}
