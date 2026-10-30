// Loads data/catalogue.json into the Azure Table. Safe to re-run: existing votes, hidden flags
// and admin edits to tags (tagsLocked) are preserved; new items are added.
// Usage: STORAGE_CONNECTION_STRING=... node scripts/seed.mjs [--overwrite]
import { readFile } from "node:fs/promises";
import { itemsTable, itemToRow, rowToItem } from "./lib.mjs";

const overwrite = process.argv.includes("--overwrite");
const { items } = JSON.parse(await readFile(new URL("../data/catalogue.json", import.meta.url), "utf8"));
const t = await itemsTable();
let added = 0, updated = 0, kept = 0;
for (const item of items) {
  let existing = null;
  try { existing = await t.getEntity("item", item.id); } catch (e) { if (e.statusCode !== 404) throw e; }
  if (!existing) { await t.createEntity(itemToRow(item)); added++; continue; }
  if (!overwrite) { kept++; continue; }
  const cur = rowToItem(existing);
  const merged = { ...item, ...(cur.tagsLocked ? { domains: cur.domains, tagsLocked: true } : {}) };
  await t.updateEntity(itemToRow(merged, existing), "Replace");
  updated++;
}
console.log(`Seed complete: ${added} added, ${updated} updated, ${kept} unchanged (use --overwrite to update existing).`);
