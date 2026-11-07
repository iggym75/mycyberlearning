// One-off / on-demand: give experts a freely licensed photo from Wikimedia Commons, with its credit.
// Edits data/catalogue.json and frontend/covers/ only; the deploy publisher sends the changes to D1 once merged.
//   node scripts/commons.mjs [--include-nophoto] [--dry]
// --include-nophoto also tries experts marked noPhoto, except those whose noPhoto was set on request (noPhotoRequested).
// Every new photo still needs checking by eye before it's merged (right person, nobody else in the shot).
import { readFile, writeFile, unlink } from "node:fs/promises";
import { saveImage, sleep } from "./lib.mjs";
import { findCommonsPhoto } from "./enrich.mjs";

const args = new Set(process.argv.slice(2));
const dry = args.has("--dry"), withNoPhoto = args.has("--include-nophoto");
const path = new URL("../data/catalogue.json", import.meta.url);
const cat = JSON.parse(await readFile(path, "utf8"));
const items = Array.isArray(cat) ? cat : cat.items;
const done = [], none = [];
for (const item of items) {
  if (item.type !== "person" || item.hidden) continue;
  if (item.noPhoto && (!withNoPhoto || item.noPhotoRequested)) continue;
  if (item.logoSource === "Wikimedia Commons") continue;
  let found = null;
  try { found = await findCommonsPhoto(item); } catch (e) { console.log(`  ${item.id}: lookup failed (${e.message})`); }
  await sleep(400); // be gentle with Wikimedia's APIs
  if (!found) { none.push(item.id); continue; }
  const saved = dry ? "(dry run)" : await saveImage(found.url, `${item.id}-cc`);
  if (!saved) { none.push(`${item.id} (download failed)`); continue; }
  console.log(`FOUND ${item.id} -> ${found.credit.file} | ${found.credit.licence} | ${found.credit.author} | ${found.qid} ${found.linked ? "linked" : "by description"}: ${found.desc}`);
  if (dry) continue;
  const old = item.logo;
  item.logo = saved; item.logoSource = "Wikimedia Commons"; item.logoCredit = found.credit; delete item.noPhoto;
  if (old && old !== saved && old.startsWith("covers/")) await unlink(new URL(`../frontend/${old}`, import.meta.url)).catch(() => {});
  done.push(item.id);
}
if (!dry) await writeFile(path, JSON.stringify(cat, null, 2) + "\n");
console.log(`\nCommons photos added: ${done.length}\n${done.join("\n")}\n\nNo usable Commons photo: ${none.length}\n${none.join("\n")}`);
