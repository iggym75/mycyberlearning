// Read-only Spotify report (run by .github/workflows/spotify-report.yml; needs SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET).
//   1. Candidates for catalogue podcasts that still have no Spotify link, for a person to confirm.
//   2. Discovery: English-language security podcasts on Spotify that aren't in the catalogue, from one
//      search per taxonomy domain plus a few general queries. Nothing is written anywhere.
// Prints Markdown to stdout and, in GitHub Actions, to the job summary.
import { readFileSync, appendFileSync } from "node:fs";
import { spotifyShows } from "./enrich.mjs";
import { titlesMatch, decodeEntities } from "./pure.mjs";
import { sleep } from "./lib.mjs";

const cat = JSON.parse(readFileSync(new URL("../data/catalogue.json", import.meta.url), "utf8"));
const taxonomy = JSON.parse(readFileSync(new URL("../data/taxonomy.json", import.meta.url), "utf8"));
const items = (Array.isArray(cat) ? cat : cat.items).filter(i => i.type === "podcast");
const out = [];
const say = s => out.push(s);
const cell = s => decodeEntities(String(s ?? "")).replace(/\s+/g, " ").replace(/\|/g, "/").trim();
const blurb = s => { const t = cell(s); return t.length > 140 ? t.slice(0, 137) + "…" : t; };
const link = s => s.external_urls?.spotify?.split("?")[0];

if (!(await spotifyShows("security", { limit: 1 }))) { console.log("No Spotify credentials; nothing to report."); process.exit(0); }

say("## 1. Catalogue podcasts without a Spotify link\n");
for (const it of items.filter(i => !i.spotify && !i.hidden)) {
  const shows = (await spotifyShows(it.name).catch(() => [])).filter(s => titlesMatch(it.name, s.name)).slice(0, 3);
  say(`**${cell(it.name)}** (${cell(it.by)})`);
  if (!shows.length) say("- no show with this name on Spotify (UK)");
  for (const s of shows) say(`- ${link(s)} — "${cell(s.name)}"${s.publisher ? ` by ${cell(s.publisher)}` : ""}, ${s.total_episodes ?? "?"} episodes — ${blurb(s.description)}`);
  say("");
  await sleep(150);
}

say("## 2. Security podcasts on Spotify not in the catalogue\n");
const queries = [...taxonomy.domains.map(d => `${d.label.replace(/[&/]/g, " ")} security podcast`),
  "cybersecurity podcast", "infosec podcast", "hacking podcast", "ransomware", "cyber security news", "penetration testing", "bug bounty", "security operations center"];
const seen = new Map();
for (const q of queries) {
  for (const offset of [0, 10, 20]) {
    const shows = await spotifyShows(q, { limit: 10, offset }).catch(() => []);
    for (const s of shows) {
      const id = link(s); if (!id) continue;
      const e = seen.get(id) || { s, queries: new Set() }; e.queries.add(q); seen.set(id, e);
    }
    await sleep(150);
  }
}
const known = s => items.some(i => titlesMatch(i.name, s.name) || i.spotify?.split("?")[0] === link(s));
const english = s => !s.languages?.length || s.languages.some(l => /^en/i.test(l));
const securityish = s => /secur|cyber|hack|infosec|threat|privacy|ransom|malware|breach|ciso|pentest|vuln|osint|forensic|incident|soc\b|devsecops|appsec|red team|blue team/i.test(`${s.name} ${s.description}`);
const found = [...seen.values()].map(e => e.s).filter(s => !known(s) && english(s) && securityish(s) && (s.total_episodes ?? 0) >= 20 && !s.explicit_content_only)
  .map(s => ({ s, hits: seen.get(link(s)).queries.size })).sort((a, b) => b.hits - a.hits || (b.s.total_episodes ?? 0) - (a.s.total_episodes ?? 0));
say(`${found.length} shows found (English, at least 20 episodes, security in the title or description), most-matched first. Spotify's search has no popularity ranking, so check each before adding.\n`);
say("| Show | Publisher | Episodes | Matched searches | About | Link |");
say("|---|---|---|---|---|---|");
for (const { s, hits } of found.slice(0, 60)) say(`| ${cell(s.name)} | ${cell(s.publisher) || "-"} | ${s.total_episodes ?? "?"} | ${hits} | ${blurb(s.description)} | ${link(s)} |`);

const md = out.join("\n");
console.log(md);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n");
