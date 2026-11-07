// Loads data/catalogue.json into D1. Safe to re-run: existing items (and their votes, hidden flags and
// admin tag edits) are kept; new items are added. --overwrite replaces content but keeps votes and locked tags.
// Usage: CLOUDFLARE_ACCOUNT_ID=... D1_DATABASE_ID=... CLOUDFLARE_API_TOKEN=... node scripts/seed.mjs [--overwrite]
//        node scripts/seed.mjs --only-new-since <older catalogue.json>
//   used by the deploy job: adds items the older copy didn't have, and for items that changed between the two copies
//   applies only the fields that changed (a new photo, a corrected link) to the live item. Items the admin deleted on
//   the site aren't brought back, and fields nobody touched in this change keep their live values (votes, hidden
//   flags, admin edits and refresh data all survive).
import { readFile } from "node:fs/promises";
import { openD1 } from "./d1.mjs";
import { insertItem, upsertItem, getItemRow, rowToItem } from "../worker/src/lib/db.js";

const overwrite = process.argv.includes("--overwrite");
const sinceArg = process.argv.indexOf("--only-new-since");
let { items } = JSON.parse(await readFile(new URL("../data/catalogue.json", import.meta.url), "utf8"));
if (sinceArg > 0) {
  if (overwrite) throw new Error("--only-new-since can't be combined with --overwrite");
  const before = new Map(JSON.parse(await readFile(process.argv[sinceArg + 1], "utf8")).items.map(i => [i.id, i]));
  const db = await openD1();
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  let added = 0, patched = 0;
  for (const item of items) {
    const old = before.get(item.id);
    if (!old) { if (await insertItem(db, item)) { added++; console.log(`added ${item.id}`); } continue; }
    if (same(old, item)) continue;
    const row = await getItemRow(db, item.id);
    if (!row) { console.log(`skipped ${item.id} (deleted on the site)`); continue; }
    const live = rowToItem(row), keys = new Set([...Object.keys(old), ...Object.keys(item)]);
    const next = { ...live };
    const changed = [];
    for (const k of keys) {
      if (["id", "hidden", "up", "down"].includes(k) || same(old[k], item[k])) continue;
      if (k === "domains" && live.tagsLocked) continue; // admin-locked tags win
      if (item[k] === undefined) delete next[k]; else next[k] = item[k];
      changed.push(k);
    }
    if (!changed.length) continue;
    await upsertItem(db, next);
    patched++; console.log(`updated ${item.id}: ${changed.join(", ")}`);
  }
  console.log(`Catalogue changes published: ${added} added, ${patched} updated.`);
  process.exit(0);
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
