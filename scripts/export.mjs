// Exports the live catalogue from D1 to data/catalogue.json, so the Git repo always holds a reviewable,
// version-controlled backup and the site's offline fallback stays current.
import { readFile, writeFile } from "node:fs/promises";
import { listItems } from "./lib.mjs";

const TYPE_ORDER = ["podcast", "book", "platform", "person"];

const path = new URL("../data/catalogue.json", import.meta.url);
const current = JSON.parse(await readFile(path, "utf8"));
const items = (await listItems()).map(item => { const { community, ...rest } = item; if (!rest.hidden) delete rest.hidden; return rest; })
  .sort((a, b) => (TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type)) || (b.curator - a.curator) || a.name.localeCompare(b.name));
current.items = items;
current.meta.generated = new Date().toISOString().slice(0, 10);
await writeFile(path, JSON.stringify(current, null, 2) + "\n");
console.log(`Exported ${items.length} items to data/catalogue.json`);
