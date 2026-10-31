// Builds the static site: injects the seed catalogue into the page template.
// Usage: node scripts/build-frontend.mjs [--bare <outfile>]
//   default  -> frontend/dist/index.html (full HTML document served by the Cloudflare Worker)
//   --bare   -> page body only (used for previews)
import { readFile, writeFile, mkdir, copyFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tpl = await readFile(join(root, "frontend/index.template.html"), "utf8");
const catalogue = JSON.parse(await readFile(join(root, "data/catalogue.json"), "utf8"));
const taxonomy = JSON.parse(await readFile(join(root, "data/taxonomy.json"), "utf8"));

// Keep the Worker's copy of the taxonomy in sync.
await copyFile(join(root, "data/taxonomy.json"), join(root, "worker/src/lib/taxonomy.json"));

// Embed the latest briefing as an offline fallback (the live page fetches news/*.json).
const readJson = async f => JSON.parse(await readFile(join(root, f), "utf8"));
const news = await Promise.all([readJson("frontend/news/latest.json"), readJson("frontend/news/index.json")])
  .then(([latest, idx]) => ({ latest, index: idx.dates }), () => null);
const seed = { taxonomy, items: catalogue.items, sourceLists: catalogue.sourceLists, news };
// Escape every "<" (and U+2028/2029) so catalogue or news text can never close or confuse the script block.
const json = JSON.stringify(seed).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
const body = tpl.replace("/*__SEED__*/null", json);

const bareIdx = process.argv.indexOf("--bare");
if (bareIdx > -1) {
  const out = process.argv[bareIdx + 1];
  await writeFile(out, body);
  console.log("wrote", out);
} else {
  const doc = `<!doctype html>\n<html lang="en-GB">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n${body.slice(0, body.indexOf("</style>") + 8)}\n</head>\n<body>\n${body.slice(body.indexOf("</style>") + 8)}\n</body>\n</html>\n`;
  await rm(join(root, "frontend/dist"), { recursive: true, force: true }); // start clean so removed files are never deployed
  await mkdir(join(root, "frontend/dist"), { recursive: true });
  await writeFile(join(root, "frontend/dist/index.html"), doc);
  await copyFile(join(root, "frontend/_headers"), join(root, "frontend/dist/_headers"));
  await copyFile(join(root, "frontend/logo.svg"), join(root, "frontend/dist/logo.svg"));
  // Book cover thumbnails imported from Calibre (optional).
  const { cp, access } = await import("node:fs/promises");
  if (await access(join(root, "frontend/covers")).then(() => true, () => false))
    await cp(join(root, "frontend/covers"), join(root, "frontend/dist/covers"), { recursive: true });
  if (await access(join(root, "frontend/news")).then(() => true, () => false))
    await cp(join(root, "frontend/news"), join(root, "frontend/dist/news"), { recursive: true, filter: src => !src.endsWith("preview.html") });
  console.log("wrote frontend/dist/index.html");
}
