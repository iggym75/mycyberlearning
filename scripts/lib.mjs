// Helpers shared by the seed, refresh, export and news scripts.
import { openD1 } from "./d1.mjs";
import { listItems as listItemsDb, upsertItem } from "../worker/src/lib/db.js";
export { openD1, upsertItem };

/** All catalogue items from D1 (including hidden ones). */
export async function listItems(db) { return listItemsDb(db ?? await openD1(), { includeHidden: true }); }
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const UA = "MyCyberLearningBot/1.0 (+https://mycyberlearning.co.uk/about)";
export async function getText(url, { timeoutMs = 15000 } = {}) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: { "user-agent": UA, accept: "*/*" }, signal: ctrl.signal, redirect: "follow" });
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    return await r.text();
  } finally { clearTimeout(t); }
}
export const getJson = async (url, o) => JSON.parse(await getText(url, o));

/** Downloads an image into the site's covers folder. Returns the site-relative path, or null. */
export async function saveImage(url, name) {
  const { writeFile, mkdir } = await import("node:fs/promises");
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(url, { headers: { "user-agent": UA }, signal: ctrl.signal });
    const type = r.headers.get("content-type") || "";
    if (!r.ok || !type.startsWith("image/")) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 1500 || buf.length > 3_000_000) return null; // skip placeholders and oversized files
    const dir = new URL("../frontend/covers/", import.meta.url);
    await mkdir(dir, { recursive: true });
    await writeFile(new URL(`${name}.jpg`, dir), buf);
    return `covers/${name}.jpg`;
  } catch { return null; } finally { clearTimeout(t); }
}
