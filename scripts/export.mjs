// Exports the live catalogue from Azure Table storage to data/catalogue.json, so the Git repo
// always holds a reviewable, version-controlled backup and the site's offline fallback stays current.
import { readFile, writeFile } from "node:fs/promises";
import { itemsTable, listItems } from "./lib.mjs";

const path = new URL("../data/catalogue.json", import.meta.url);
const current = JSON.parse(await readFile(path, "utf8"));
const rows = await listItems(await itemsTable());
const items = rows.map(({ item }) => { const { community, ...rest } = item; return rest; })
  .sort((a, b) => (a.type === b.type ? 0 : a.type === "podcast" ? -1 : 1) || (b.curator - a.curator) || a.name.localeCompare(b.name));
current.items = items;
current.meta.generated = new Date().toISOString().slice(0, 10);
await writeFile(path, JSON.stringify(current, null, 2) + "\n");
console.log(`Exported ${items.length} items to data/catalogue.json`);
