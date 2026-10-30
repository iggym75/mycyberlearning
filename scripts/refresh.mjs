// Weekly refresh: keeps every entry current without manual work.
//   Podcasts: Apple directory (artwork, links, feed) -> RSS (cadence, launch, status, recent titles)
//             -> aggregated rating -> Claude tags (only where tags aren't locked by an admin)
//   Books:    Open Library (cover, rating)
// Usage:
//   STORAGE_CONNECTION_STRING=... ANTHROPIC_API_KEY=... node scripts/refresh.mjs
//   node scripts/refresh.mjs --dry-run [--limit 5] [--only darknet-diaries]   (reads data/catalogue.json, writes nothing)
//   --retag   re-run Claude tagging on all unlocked items, not just untagged/community ones
import { readFile, writeFile } from "node:fs/promises";
import { itemsTable, listItems, itemToRow, sleep } from "./lib.mjs";
import { lookupApple, readFeed, lookupRating, lookupBook, claudeTag } from "./enrich.mjs";

const args = process.argv.slice(2);
const flag = f => args.includes(f);
const opt = f => { const i = args.indexOf(f); return i > -1 ? args[i + 1] : null; };
const dry = flag("--dry-run"), retag = flag("--retag"), limit = Number(opt("--limit")) || Infinity, only = opt("--only");
const today = new Date().toISOString().slice(0, 10);

let rows;
if (dry) {
  const { items } = JSON.parse(await readFile(new URL("../data/catalogue.json", import.meta.url), "utf8"));
  rows = items.map(item => ({ item, row: {} }));
} else rows = await listItems(await itemsTable());
if (only) rows = rows.filter(r => r.item.id === only);
rows = rows.slice(0, limit);

const t = dry ? null : await itemsTable();
const report = { checked: 0, changed: 0, tagged: 0, failed: [] , notes: [] };

for (const { item, row } of rows) {
  report.checked++;
  const before = JSON.stringify(item);
  const next = { ...item };
  let titles = [];
  try {
    if (item.type === "podcast") {
      const a = await lookupApple(item).catch(e => { report.notes.push(`${item.id}: Apple lookup failed (${e.message})`); return null; });
      if (a) {
        next.apple ??= a.apple;
        if (a.logo) next.logo = a.logo;
        next.rss ??= a.rss;
        const feedUrl = next.rss;
        if (feedUrl) {
          const f = await readFeed(feedUrl, a.trackCount).catch(e => { report.notes.push(`${item.id}: feed unreadable (${e.message})`); return null; });
          if (f?.cadence) {
            next.freq = f.cadence.freq; next.status = f.cadence.status; next.lastEpisode = f.cadence.lastEpisode;
            if (f.cadence.launched && (!next.launched || f.cadence.launched < next.launched)) next.launched = f.cadence.launched;
            titles = f.titles;
          }
        }
        const rating = await lookupRating(a.appleId);
        if (rating) next.rating = { ...rating, asOf: today };
        next.verified = true;
      } else report.notes.push(`${item.id}: not found in Apple directory — check the name or add the Apple link`);
    } else {
      const b = await lookupBook(item).catch(() => null);
      if (b) {
        if (b.logo) next.logo = b.logo; next.openlibrary = b.openlibrary;
        if (b.rating) next.rating = { ...b.rating, asOf: today };
        if ("isbnVerified" in b) {
          next.isbnVerified = b.isbnVerified;
          if (!b.isbnVerified) report.notes.push(`${item.id}: ISBN ${item.isbn} is registered to "${b.isbnTitle}" — check the edition`);
          next.publisher ??= b.publisher; if (!next.published && b.year) next.published = b.year;
        } else {
          if (b.suggestedIsbn && !next.isbn) { next.isbn = b.suggestedIsbn; next.isbnVerified = false; report.notes.push(`${item.id}: ISBN ${b.suggestedIsbn} added from Open Library — confirm the edition`); }
          next.publisher ??= b.publisher; if (!next.published && b.year) next.published = b.year;
        }
      } else if (item.isbn) report.notes.push(`${item.id}: ISBN ${item.isbn} not found on Open Library`);
    }

    const needsTags = !item.tagsLocked && (retag || !item.domains?.length || item.sources?.includes("community") && !item.autoTagged);
    if (needsTags) {
      const tags = await claudeTag(next, titles);
      if (tags?.domains?.length) { next.domains = tags.domains; next.level = tags.level; next.autoTagged = today; report.tagged++; }
    }

    if (JSON.stringify(next) !== before) {
      report.changed++;
      if (!dry) await t.updateEntity(itemToRow(next, row), "Replace", { etag: row.etag });
      else console.log(`\n${item.id}`, JSON.stringify({ freq: next.freq, launched: next.launched, status: next.status, rating: next.rating, logo: !!next.logo, domains: next.domains }));
    }
  } catch (e) {
    report.failed.push(`${item.id}: ${e.message}`);
  }
  await sleep(1200); // be polite to the free public APIs
}

console.log(`\nRefresh ${dry ? "(dry run) " : ""}complete: ${report.checked} checked, ${report.changed} updated, ${report.tagged} auto-tagged, ${report.failed.length} failed.`);
if (report.notes.length) console.log("Notes:\n- " + report.notes.join("\n- "));
if (report.failed.length) console.log("Failures:\n- " + report.failed.join("\n- "));
if (process.env.GITHUB_STEP_SUMMARY) {
  await writeFile(process.env.GITHUB_STEP_SUMMARY, `## Catalogue refresh ${today}\n\n- Checked: ${report.checked}\n- Updated: ${report.changed}\n- Auto-tagged by Claude: ${report.tagged}\n- Failed: ${report.failed.length}\n\n${[...report.notes, ...report.failed].map(n => "- " + n).join("\n")}\n`, { flag: "a" });
}
