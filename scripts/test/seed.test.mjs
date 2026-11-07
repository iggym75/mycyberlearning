// scripts/seed.mjs --only-new-since: what the deploy job publishes from a catalogue change.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localD1 } from "../d1.mjs";
import { insertItem, getItemRow, rowToItem } from "../../worker/src/lib/db.js";

test("deploy publishing: new items added, edited fields applied, everything else on the live item kept", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mcl-seed-")), file = join(dir, "d1.sqlite"), before = join(dir, "before.json");
  const cat = JSON.parse(readFileSync(new URL("../../data/catalogue.json", import.meta.url), "utf8"));
  const pick = cat.items.find(i => i.type === "person");
  const db = await localD1(file);
  const deletedId = cat.items.find(i => i.type === "book").id;
  for (const i of cat.items) if (i.id !== deletedId) await insertItem(db, i);
  // Live state the change must not disturb: votes, a hidden flag, an admin edit to another field
  await db.prepare("UPDATE items SET up = 9, hidden = 1 WHERE id = ?").bind(pick.id).run();
  const row = rowToItem(await getItemRow(db, pick.id));
  await db.prepare("UPDATE items SET data = ? WHERE id = ?").bind(JSON.stringify({ ...row, by: "Edited by the admin" }), pick.id).run();
  // "Before" is the catalogue without one new item and with the old photo; "after" (the repo copy) has both changes.
  const newItem = cat.items.at(-1);
  writeFileSync(before, JSON.stringify({ items: cat.items.filter(i => i.id !== newItem.id).map(i => i.id === pick.id ? { ...i, logo: "covers/old.webp" } : i) }));
  await db.prepare("DELETE FROM items WHERE id = ?").bind(newItem.id).run();
  const out = execFileSync(process.execPath, ["--no-warnings", new URL("../seed.mjs", import.meta.url).pathname, "--only-new-since", before], { env: { ...process.env, D1_LOCAL_FILE: file }, encoding: "utf8" });
  assert.match(out, new RegExp(`added ${newItem.id}`));
  assert.match(out, new RegExp(`updated ${pick.id}: logo`));
  const live = await getItemRow(db, pick.id), item = rowToItem(live);
  assert.equal(item.logo, pick.logo);                 // the edited field arrived
  assert.equal(item.by, "Edited by the admin");       // untouched fields keep their live value
  assert.equal(live.up, 9); assert.equal(live.hidden, 1);
  assert.equal(await getItemRow(db, deletedId), null); // deleted on the site: not brought back (it didn't change)
});
