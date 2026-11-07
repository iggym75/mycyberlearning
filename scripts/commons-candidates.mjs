// Gathers recent, freely licensed Commons photos of every expert for choosing by eye.
// Writes review/commons/<id>/NN.<ext> plus review/commons/<id>.json (credit, year, file per photo). Never edits the catalogue.
//   node scripts/commons-candidates.mjs [--max 8]
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { saveImage, sleep } from "./lib.mjs";
import { commonsCandidates } from "./enrich.mjs";

const max = +(process.argv[process.argv.indexOf("--max") + 1] || 8) || 8;
const cat = JSON.parse(await readFile(new URL("../data/catalogue.json", import.meta.url), "utf8"));
const root = new URL("../review/commons/", import.meta.url);
await mkdir(root, { recursive: true });
for (const item of cat.items) {
  if (item.type !== "person" || item.hidden || item.noPhotoRequested) continue;
  let found = null;
  try { found = await commonsCandidates(item); } catch (e) { console.log(`${item.id}: lookup failed (${e.message})`); }
  await sleep(300);
  if (!found?.photos.length) { console.log(`${item.id}: none`); continue; }
  const keep = [];
  for (const [n, p] of found.photos.slice(0, max).entries()) {
    const tmp = await saveImage(p.url, `cand-${item.id}-${n}`); // lands in frontend/covers; moved into review/ below
    if (!tmp) continue;
    const name = `${String(n).padStart(2, "0")}.${tmp.split(".").pop()}`;
    await mkdir(new URL(`${item.id}/`, root), { recursive: true });
    await rename(new URL(`../frontend/${tmp}`, import.meta.url), new URL(`${item.id}/${name}`, root));
    keep.push({ n, name, year: p.year, wikidata: p.wikidata, credit: p.credit });
  }
  await writeFile(new URL(`${item.id}.json`, root), JSON.stringify({ qid: found.qid, category: found.category, total: found.photos.length, photos: keep }, null, 2));
  console.log(`${item.id}: ${found.photos.length} usable, newest ${found.photos[0].year ?? "?"}, kept ${keep.length}`);
}
