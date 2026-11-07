// Loads data/catalogue.json into D1. Safe to re-run: existing items (and their votes, hidden flags and
// admin tag edits) are kept; new items are added. --overwrite replaces content but keeps votes and locked tags.
// Usage: CLOUDFLARE_ACCOUNT_ID=... D1_DATABASE_ID=... CLOUDFLARE_API_TOKEN=... node scripts/seed.mjs [--overwrite]
//        node scripts/seed.mjs --only-new-since <older catalogue.json>
//   adds only items that the older copy didn't have (used by the deploy job), so an item the admin deleted on the
//   site isn't brought back by a change that was based on an older catalogue.
import { readFile } from "node:fs/promises";
import { openD1 } from "./d1.mjs";
import { insertItem, upsertItem, getItemRow, rowToItem } from "../worker/src/lib/db.js";

const overwrite = process.argv.includes("--overwrite");
const sinceArg = process.argv.indexOf("--only-new-since");
let { items } = JSON.parse(await readFile(new URL("../data/catalogue.json", import.meta.url), "utf8"));
if (sinceArg > 0) {
  if (overwrite) throw new Error("--only-new-since can't be combined with --overwrite");
  const before = new Set(JSON.parse(await readFile(process.argv[sinceArg + 1], "utf8")).items.map(i => i.id));
  items = items.filter(i => !before.has(i.id));
  console.log(items.length ? `New in this change: ${items.map(i => i.id).join(", ")}` : "No new catalogue items in this change.");
  if (!items.length) process.exit(0);
}
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
