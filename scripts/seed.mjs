// Loads data/catalogue.json into D1. Safe to re-run: existing items (and their votes, hidden flags and
// admin tag edits) are kept; new items are added. --overwrite replaces content but keeps votes and locked tags.
// Usage: CLOUDFLARE_ACCOUNT_ID=... D1_DATABASE_ID=... CLOUDFLARE_API_TOKEN=... node scripts/seed.mjs [--overwrite]
import { readFile } from "node:fs/promises";
import { openD1 } from "./d1.mjs";
import { insertItem, upsertItem, getItemRow, rowToItem } from "../worker/src/lib/db.js";

const overwrite = process.argv.includes("--overwrite");
const { items } = JSON.parse(await readFile(new URL("../data/catalogue.json", import.meta.url), "utf8"));
const db = await openD1();
let added = 0, updated = 0, kept = 0;
for (const item of items) {
  if (await insertItem(db, item)) { added++; continue; }
  if (!overwrite) { kept++; continue; }
  const cur = rowToItem(await getItemRow(db, item.id));
  await upsertItem(db, { ...item, hidden: cur.hidden, ...(cur.tagsLocked ? { domains: cur.domains, tagsLocked: true } : {}) });
  updated++;
}
console.log(`Seed complete: ${added} added, ${updated} updated, ${kept} unchanged (use --overwrite to update existing).`);
