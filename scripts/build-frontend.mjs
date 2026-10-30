// Builds the static site: injects the seed catalogue into the page template.
// Usage: node scripts/build-frontend.mjs [--bare <outfile>]
//   default  -> frontend/dist/index.html (full HTML document for Azure Static Web Apps)
//   --bare   -> page body only (used for previews)
import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tpl = await readFile(join(root, "frontend/index.template.html"), "utf8");
const catalogue = JSON.parse(await readFile(join(root, "data/catalogue.json"), "utf8"));
const taxonomy = JSON.parse(await readFile(join(root, "data/taxonomy.json"), "utf8"));

// Keep the API's copy of the taxonomy in sync (the API is deployed on its own).
await copyFile(join(root, "data/taxonomy.json"), join(root, "api/src/lib/taxonomy.json"));

const seed = { taxonomy, items: catalogue.items, sourceLists: catalogue.sourceLists };
// Escape "</" so catalogue text can never close the script tag.
const json = JSON.stringify(seed).replace(/<\//g, "<\\/");
const body = tpl.replace("/*__SEED__*/null", json);

const bareIdx = process.argv.indexOf("--bare");
if (bareIdx > -1) {
  const out = process.argv[bareIdx + 1];
  await writeFile(out, body);
  console.log("wrote", out);
} else {
  const doc = `<!doctype html>\n<html lang="en-GB">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n${body.slice(0, body.indexOf("</style>") + 8)}\n</head>\n<body>\n${body.slice(body.indexOf("</style>") + 8)}\n</body>\n</html>\n`;
  await mkdir(join(root, "frontend/dist"), { recursive: true });
  await writeFile(join(root, "frontend/dist/index.html"), doc);
  await copyFile(join(root, "frontend/staticwebapp.config.json"), join(root, "frontend/dist/staticwebapp.config.json"));
  console.log("wrote frontend/dist/index.html");
}
