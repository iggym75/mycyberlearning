// Search-friendly static pages, built from data/catalogue.json at deploy time (called by build-frontend.mjs).
//   /podcasts/ /books/ /platforms/ /experts/           section lists
//   /podcasts/<slug>/ …                                  one page per item: our description, topics, links, related items
//   /topics/<domain>/                                    everything in one security domain
//   /sitemap.xml, /robots.txt
// Plain HTML and inline CSS, no scripts: fast, readable by every crawler, and allowed by the site's CSP.
// Every value from the catalogue is escaped; only http(s) links are written.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const SITE = "https://mycyberlearning.co.uk";
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const isHttp = u => typeof u === "string" && /^https?:\/\/[^\s"<>]+$/i.test(u);
const jsonLd = o => `<script type="application/ld+json">${JSON.stringify(o).replace(/</g, "\\u003c")}</script>`;
const clip = (s, n) => { s = String(s || "").replace(/\s+/g, " ").trim(); if (s.length <= n) return s; const c = s.slice(0, n - 1); return c.slice(0, Math.max(c.lastIndexOf(" "), n * 0.6)).replace(/[,;:.\s]+$/, "") + "…"; };

export const SECTIONS = {
  podcast: { path: "podcasts", label: "Podcasts", one: "podcast", title: "Cyber security podcasts", hash: "#podcasts" },
  book: { path: "books", label: "Books", one: "book", title: "Cyber security books", hash: "#books" },
  platform: { path: "platforms", label: "Platforms", one: "learning platform", title: "Free and low-cost cyber security learning platforms", hash: "#platforms" },
  person: { path: "experts", label: "Experts", one: "expert", title: "Cyber security experts worth following", hash: "#experts" },
};
// Header and breadcrumb links go to the library's own sections, not to these static pages.
const LIB = Object.fromEntries(Object.values(SECTIONS).map(s => [`/${s.path}/`, `/${s.hash}`]));
export const slugOf = i => String(i.id).replace(/^(book|expert|platform|podcast)-/, "");
export const pathOf = i => `/${SECTIONS[i.type].path}/${slugOf(i)}/`;

const LINKS = [ // [field, label]; experts' social links are their own public profiles
  ["web", "Website"], ["apple", "Apple Podcasts"], ["spotify", "Spotify"], ["amazon", "Amazon Music"], ["youtube", "YouTube"], ["twitch", "Twitch"],
  ["bluesky", "Bluesky"], ["mastodon", "Mastodon"], ["linkedin", "LinkedIn"], ["github", "GitHub"], ["medium", "Medium"], ["x", "X"], ["discord", "Discord"],
];
const SOCIAL = ["bluesky", "mastodon", "linkedin", "github", "medium", "x", "discord", "youtube"];

function credit(i) {
  if (!i.logo) return "";
  const s = String(i.logoSource || "");
  if (i.type === "person" && s === "Wikimedia Commons" && i.logoCredit) {
    const c = i.logoCredit, page = isHttp(c.page) ? c.page : null, lic = isHttp(c.licenceUrl) ? c.licenceUrl : null;
    return `Photo${c.author ? ` by ${esc(c.author)}` : ""}${c.year ? ` (${esc(c.year)})` : ""}, ${lic ? `<a href="${esc(lic)}" rel="license noopener">${esc(c.licence)}</a>` : esc(c.licence)}${c.cropped || c.shareAlike ? ", cropped and resized" : ""}${page ? `, via <a href="${esc(page)}" rel="noopener">Wikimedia Commons</a>` : ""}`;
  }
  if (i.type === "person") return `Picture from ${esc(({ Bluesky: "their Bluesky profile", Mastodon: "their Mastodon profile", GitHub: "their GitHub profile", YouTube: "their YouTube channel", "own website": "their own website" })[s] || "a profile of their own")}`;
  if (i.type === "podcast") return "Artwork: Apple Podcasts";
  if (i.type === "book") return /Open Library/.test(s) ? "Cover: Open Library (publisher's cover)" : "Cover: the publisher's cover";
  return "Logo: the site's own icon";
}
const initials = n => String(n).replace(/\s*\(.*?\)\s*/g, " ").replace(/^(the|a)\s+/i, "").split(/[\s\-:.]+/).filter(w => /[A-Za-z0-9]/.test(w)).slice(0, 2).map(w => w[0].toUpperCase()).join("");
function ring(i, hue, size) { // experts without a picture: one coloured arc per topic, as on the main page
  const d = (i.domains || []).slice(0, 4), r = 27, C = 2 * Math.PI * r, seg = C / Math.max(1, d.length);
  const arcs = (d.length ? d : ["_"]).map((t, k) => `<circle cx="32" cy="32" r="${r}" fill="none" stroke="hsl(${hue[t] ?? 180} 58% 46%)" stroke-width="6"${d.length > 1 ? ` stroke-dasharray="${(seg - 3).toFixed(2)} ${(C - seg + 3).toFixed(2)}" stroke-dashoffset="${(-k * seg).toFixed(2)}" stroke-linecap="round"` : ""} transform="rotate(-90 32 32)"/>`).join("");
  return `<svg class="ring" width="${size}" height="${size}" viewBox="0 0 64 64" role="img" aria-label="${esc(i.name)}"><circle cx="32" cy="32" r="31" fill="var(--surface)"/>${arcs}<text x="32" y="39.5" text-anchor="middle" font-family="Georgia,serif" font-weight="700" font-size="20" fill="var(--ink)">${esc(initials(i.name))}</text></svg>`;
}
function thumb(i, hue, size, eager = false) {
  if (i.logo && /^covers\/[a-z0-9-]+\.(jpg|png|webp|gif)$/.test(i.logo)) {
    const alt = i.type === "book" ? `Cover of ${i.name}` : i.type === "person" ? `Photo of ${i.name}` : i.type === "platform" ? `${i.name} logo` : `${i.name} artwork`;
    return `<img class="th ${i.type}" src="/${esc(i.logo)}" alt="${esc(alt)}" width="${size}" height="${i.type === "book" ? Math.round(size * 1.5) : size}"${eager ? "" : ' loading="lazy"'} decoding="async">`;
  }
  if (i.type === "person") return ring(i, hue, size);
  return `<span class="th ph ${i.type}" style="width:${size}px;height:${i.type === "book" ? Math.round(size * 1.5) : size}px" aria-hidden="true">${esc(initials(i.name))}</span>`;
}

const CSS = `:root{--paper:#f2f4f7;--surface:#fff;--sunk:#e7ebf0;--line:#d3d9e1;--ink:#0f1c2e;--ink-2:#4a5668;--ink-3:#6c7789;--signal:#0b7a75;--signal-ink:#fff;--signal-soft:#d5ecea;--pick:#b4690e;--pick-soft:#f6e6cf;
--f-display:"Bricolage Grotesque","Avenir Next","Segoe UI",system-ui,sans-serif;--f-body:"IBM Plex Sans","Segoe UI",system-ui,-apple-system,sans-serif;--f-mono:"IBM Plex Mono",ui-monospace,Menlo,Consolas,monospace}
@media (prefers-color-scheme:dark){:root{--paper:#0c131d;--surface:#131c28;--sunk:#1a2533;--line:#283546;--ink:#e6ebf2;--ink-2:#a7b2c2;--ink-3:#7f8b9c;--signal:#3cc0b6;--signal-ink:#06201e;--signal-soft:#123533;--pick:#e5a24a;--pick-soft:#3a2a14;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:15.5px/1.6 var(--f-body)}a{color:var(--signal)}:focus-visible{outline:2px solid var(--signal);outline-offset:2px}
.wrap{max-width:1100px;margin:0 auto;padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px))}
header{background:var(--surface);border-bottom:1px solid var(--line)}header .wrap{display:flex;align-items:center;gap:10px 18px;flex-wrap:wrap;padding-block:12px}
.brand{display:flex;align-items:center;gap:10px;color:var(--ink);text-decoration:none;font:800 19px/1 var(--f-display)}.brand b{color:var(--signal)}
nav{display:flex;gap:4px 14px;flex-wrap:wrap;font-weight:500}nav a{color:var(--ink-2);text-decoration:none;padding:4px 2px}nav a:hover,nav a[aria-current]{color:var(--signal)}
.open{margin-left:auto;background:var(--signal);color:var(--signal-ink);text-decoration:none;border-radius:999px;padding:8px 16px;font-weight:600}
main{padding-block:24px 48px}.crumbs{font-size:13px;color:var(--ink-3);margin:0 0 14px}.crumbs a{color:var(--ink-3)}
h1{font:800 clamp(28px,4vw,44px)/1.08 var(--f-display);letter-spacing:-.015em;margin:0 0 10px;text-wrap:balance}h2{font:700 20px/1.2 var(--f-display);margin:32px 0 12px}
.lede{color:var(--ink-2);max-width:68ch;margin:0 0 20px;font-size:16.5px}
.item{display:grid;grid-template-columns:auto minmax(0,1fr);gap:24px;align-items:start;background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:22px}
@media (max-width:640px){.item{grid-template-columns:minmax(0,1fr)}}
.th{display:block;border-radius:12px;object-fit:cover;background:var(--sunk);max-width:100%}.th.person,.ring{border-radius:50%}.th.platform{object-fit:contain;background:#fff;padding:6px}
.th.ph{display:grid;place-items:center;font:800 22px var(--f-display);color:#fff;background:linear-gradient(140deg,#0b7a75,#0f3f5c)}
figure{margin:0;display:grid;gap:6px;justify-items:start}figcaption{font-size:12px;color:var(--ink-3);max-width:220px}
.by{color:var(--ink-2);margin:0 0 12px;font-size:16px}.badges,.tags,.links{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 14px;padding:0;list-style:none}
.badge{font:500 11.5px/1 var(--f-mono);text-transform:uppercase;letter-spacing:.04em;border:1px solid var(--line);border-radius:6px;padding:5px 7px;color:var(--ink-2)}.badge.pick{background:var(--pick-soft);color:var(--pick);border-color:transparent}
.tags a{background:var(--signal-soft);color:var(--ink);text-decoration:none;border-radius:999px;padding:4px 11px;font-size:13.5px}
.links a{border:1px solid var(--line);border-radius:999px;padding:6px 13px;text-decoration:none;font-weight:500;font-size:14px;background:var(--surface)}
.desc{font-size:16.5px;max-width:65ch;margin:0 0 16px}dl{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px 18px;margin:0 0 16px}
dt{font:500 11.5px var(--f-mono);text-transform:uppercase;letter-spacing:.05em;color:var(--ink-3)}dd{margin:2px 0 0;font-variant-numeric:tabular-nums}
.list{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px;margin:0;padding:0;list-style:none}
.list li{display:grid;grid-template-columns:auto minmax(0,1fr);gap:14px;align-items:start;background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:14px}
.list h3{margin:0 0 2px;font:600 16px/1.3 var(--f-body)}.list h3 a{color:var(--ink);text-decoration:none}.list h3 a:hover{color:var(--signal);text-decoration:underline}
.list p{margin:0;color:var(--ink-2);font-size:14px}.list .sub{color:var(--ink-3);font-size:13px;margin-bottom:4px}
.topics{display:flex;flex-wrap:wrap;gap:8px;padding:0;list-style:none}.topics a{display:inline-block;border:1px solid var(--line);background:var(--surface);border-radius:999px;padding:6px 13px;text-decoration:none;color:var(--ink)}
.note{color:var(--ink-3);font-size:13px}footer{border-top:1px solid var(--line);color:var(--ink-3);font-size:13px}footer .wrap{padding-block:18px;display:flex;gap:10px 18px;flex-wrap:wrap}footer a{color:var(--ink-3)}
video.tour{display:block;width:100%;max-width:960px;height:auto;aspect-ratio:16/9;border-radius:14px;background:#0b1620;margin:8px 0 6px}
.chapters{list-style:none;padding:0;margin:0 0 20px;columns:2 320px;column-gap:28px}.chapters li{padding:4px 0;break-inside:avoid}.chapters span{font-family:"IBM Plex Mono",monospace;color:var(--ink-3);display:inline-block;min-width:3.2em}
.cta{display:flex;gap:16px;align-items:center;flex-wrap:wrap}.cta .open{margin-left:0}`;

function page({ path, title, description, h1, body, crumbs = [], image, ld = [], active, head = "" }) {
  const url = SITE + path;
  const crumbLd = { "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [{ name: "My Cyber Learning", path: "/" }, ...crumbs, { name: h1, path }].map((c, k) => ({ "@type": "ListItem", position: k + 1, name: c.name, item: SITE + c.path })) };
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(url)}">
<link rel="icon" href="/logo.svg" type="image/svg+xml">
<meta property="og:type" content="website"><meta property="og:site_name" content="My Cyber Learning">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(description)}"><meta property="og:url" content="${esc(url)}">
${image ? `<meta property="og:image" content="${esc(SITE + "/" + image)}">` : ""}
<meta name="twitter:card" content="${head ? "summary_large_image" : "summary"}">
${head}
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,700;12..96,800&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@500&display=swap">
<style>${CSS}</style>
${[crumbLd, ...ld].map(jsonLd).join("\n")}
</head>
<body>
<header><div class="wrap">
  <a class="brand" href="/"><img src="/logo.svg" alt="" width="32" height="32"><span>My <b>Cyber</b> Learning</span></a>
  <nav aria-label="Library sections">${Object.values(SECTIONS).map(s => `<a href="/${s.hash}">${s.label}</a>`).join("")}<a href="/#news">Daily briefing</a></nav>
  <a class="open" href="/">Open the library</a>
</div></header>
<main class="wrap">
<p class="crumbs"><a href="/">Home</a>${crumbs.map(c => ` › <a href="${esc(LIB[c.path] || c.path)}">${esc(c.name)}</a>`).join("")} › ${esc(h1)}</p>
${body}
</main>
<footer><div class="wrap"><span>My Cyber Learning: a free, vendor-neutral library of cyber security podcasts, books, platforms and experts.</span><a href="/">Library</a><a href="/#news">Daily briefing</a><a href="/video/">Site tour (video)</a><a href="/sitemap.xml">Sitemap</a><span>Essential cookies only: no tracking or advertising.</span></div></footer>
</body>
</html>
`;
}

function listItem(i, hue) {
  return `<li>${thumb(i, hue, 56)}<div><h3><a href="${pathOf(i)}">${esc(i.name)}</a></h3>${i.by ? `<div class="sub">${esc(i.by)}</div>` : ""}<p>${esc(clip(i.desc, 150))}</p></div></li>`;
}
const order = (a, b) => (!!b.curator - !!a.curator) || ((b.rating?.v ?? 0) - (a.rating?.v ?? 0)) || a.name.localeCompare(b.name);

export async function buildSitePages(dist, catalogue, taxonomy) {
  const items = catalogue.items.filter(i => !i.hidden && SECTIONS[i.type]);
  const DOM = Object.fromEntries(taxonomy.domains.map(d => [d.key, d])), hue = Object.fromEntries(taxonomy.domains.map(d => [d.key, d.hue ?? 180]));
  const LEVEL = Object.fromEntries((taxonomy.levels || []).map(l => [l.key, l.label]));
  const FREQ = Object.fromEntries((taxonomy.frequencies || []).map(f => [f.key, f.label]));
  const KIND = Object.fromEntries((taxonomy.platformKinds || []).map(k => [k.key, k.label]));
  const COST = Object.fromEntries((taxonomy.costs || []).map(k => [k.key, k.label]));
  const urls = ["/"];
  const write = async (path, html) => { await mkdir(join(dist, path), { recursive: true }); await writeFile(join(dist, path, "index.html"), html); urls.push(path); };

  // One page per item
  for (const i of items) {
    const S = SECTIONS[i.type], path = pathOf(i);
    const topics = (i.domains || []).filter(d => DOM[d]);
    const typeWord = i.type === "platform" ? (KIND[i.kind] || "Learning platform").replace(/s$/, "").replace(/&/g, "and") : S.one;
    const facts = [];
    if (i.type === "podcast") { if (FREQ[i.freq]) facts.push(["Releases", FREQ[i.freq]]); if (i.launched) facts.push(["On air since", String(i.launched).slice(0, 4)]); if (i.episodes) facts.push(["Episodes", String(i.episodes)]); if (i.status === "ended") facts.push(["Status", "Archive (no new episodes)"]); if (i.rating?.v) facts.push(["Listener rating", `${Number(i.rating.v).toFixed(1)} out of 5 (${i.rating.n} ratings)`]); }
    if (i.type === "book") { if (i.publisher) facts.push(["Publisher", i.publisher]); if (i.published) facts.push(["Published", String(i.published)]); if (i.isbn) facts.push(["ISBN", i.isbn]); if (i.rating?.v) facts.push(["Reader rating", `${Number(i.rating.v).toFixed(1)} out of 5`]); }
    if (i.type === "platform") { if (KIND[i.kind]) facts.push(["Type", KIND[i.kind]]); if (COST[i.cost]) facts.push(["Cost", COST[i.cost]]); }
    if ((i.level || []).length) facts.push(["Level", i.level.map(l => LEVEL[l] || l).join(", ")]);
    const links = LINKS.filter(([k]) => isHttp(i[k])).map(([k, label]) => `<li><a href="${esc(i[k])}" rel="noopener">${esc(i.type === "person" && k !== "web" ? `${label}` : label)}</a></li>`);
    if (i.type === "book" && /^\d{13}$/.test(i.isbn || "")) links.push(`<li><a href="https://openlibrary.org/isbn/${i.isbn}" rel="noopener">Open Library</a></li>`, `<li><a href="https://www.goodreads.com/search?q=${i.isbn}" rel="noopener">Goodreads</a></li>`);
    if (isHttp(i.bundle?.url)) links.push(`<li><a href="${esc(i.bundle.url)}" rel="noopener">${esc(i.bundle.name || "Bundle")}</a></li>`);
    const related = items.filter(x => x.id !== i.id).map(x => [x, (x.domains || []).filter(d => topics.includes(d)).length + (x.type === i.type ? 0.5 : 0) + (x.curator ? 0.2 : 0)])
      .filter(([, s]) => s >= 1).sort((a, b) => b[1] - a[1] || a[0].name.localeCompare(b[0].name)).slice(0, 6).map(([x]) => x);
    const img = i.logo && /^covers\//.test(i.logo) ? i.logo : null;
    const description = clip(`${i.name}${i.by && i.type !== "person" ? ` by ${i.by}` : ""}: ${i.desc}`, 158);
    const sameAs = LINKS.map(([k]) => i[k]).filter(isHttp);
    const ld = i.type === "podcast" ? { "@context": "https://schema.org", "@type": "PodcastSeries", name: i.name, description: i.desc, url: SITE + path, ...(isHttp(i.rss) ? { webFeed: i.rss } : {}), ...(img ? { image: SITE + "/" + img } : {}), ...(i.by ? { author: { "@type": "Organization", name: i.by } } : {}), sameAs }
      : i.type === "book" ? { "@context": "https://schema.org", "@type": "Book", name: i.name, description: i.desc, url: SITE + path, ...(i.by ? { author: i.by.split(/\s*(?:,|&| and )\s*/).filter(Boolean).map(n => ({ "@type": "Person", name: n })) } : {}), ...(i.isbn ? { isbn: i.isbn } : {}), ...(i.publisher ? { publisher: { "@type": "Organization", name: i.publisher } } : {}), ...(i.published ? { datePublished: String(i.published) } : {}), ...(img ? { image: SITE + "/" + img } : {}) }
      : i.type === "person" ? { "@context": "https://schema.org", "@type": "Person", name: i.name, description: i.desc, url: SITE + path, ...(i.by ? { jobTitle: i.by } : {}), ...(img ? { image: SITE + "/" + img } : {}), sameAs: SOCIAL.concat("web").map(k => i[k]).filter(isHttp) }
      : { "@context": "https://schema.org", "@type": "WebSite", name: i.name, description: i.desc, ...(isHttp(i.web) ? { url: i.web } : {}), ...(i.by ? { publisher: { "@type": "Organization", name: i.by } } : {}) };
    const body = `<article class="item">
  <figure>${thumb(i, hue, i.type === "book" ? 150 : 160, true)}${credit(i) ? `<figcaption>${credit(i)}</figcaption>` : ""}</figure>
  <div>
    <h1>${esc(i.name)}</h1>
    ${i.by ? `<p class="by">${esc(i.by)}</p>` : ""}
    <ul class="badges"><li class="badge">${esc(typeWord)}</li>${i.curator ? '<li class="badge pick">MCL Pick</li>' : ""}${i.type === "platform" && COST[i.cost] ? `<li class="badge">${esc(COST[i.cost])}</li>` : ""}</ul>
    <p class="desc">${esc(i.desc)}</p>
    ${facts.length ? `<dl>${facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>` : ""}
    ${topics.length ? `<ul class="tags" aria-label="Topics">${topics.map(d => `<li><a href="/topics/${d}/">${esc(DOM[d].label)}</a></li>`).join("")}</ul>` : ""}
    ${links.length ? `<ul class="links" aria-label="Links">${links.join("")}</ul>` : ""}
    <p class="note">${i.curator ? "An MCL Pick: hand-chosen by the site's curator. " : ""}${i.type === "podcast" ? "Listener ratings come from the podcast platforms; community votes are shown separately in the library. " : ""}<a href="/${S.hash}">See it with filters and community votes in the library</a>.</p>
  </div>
</article>
${related.length ? `<h2>Related</h2><ul class="list">${related.map(x => listItem(x, hue)).join("")}</ul>` : ""}`;
    await write(path, page({ path, title: `${i.name} · ${i.type === "person" ? "Cyber security expert" : `Cyber security ${S.one}`} · My Cyber Learning`, description, h1: i.name, body, crumbs: [{ name: S.label, path: `/${S.path}/` }], image: img, ld: [ld], active: S.path }));
  }

  // Section pages
  for (const [type, S] of Object.entries(SECTIONS)) {
    const list = items.filter(i => i.type === type).sort(order), path = `/${S.path}/`;
    const intro = taxonomy.scope?.[type]?.intro || "";
    const body = `<h1>${esc(S.title)}</h1><p class="lede">${esc(intro)} ${list.length} in the library, MCL Picks first.</p>
<ul class="topics" aria-label="Topics">${taxonomy.domains.filter(d => list.some(i => (i.domains || []).includes(d.key))).map(d => `<li><a href="/topics/${d.key}/">${esc(d.label)}</a></li>`).join("")}</ul>
<h2>All ${S.label.toLowerCase()}</h2><ul class="list">${list.map(i => listItem(i, hue)).join("")}</ul>`;
    await write(path, page({ path, title: `${S.title} · My Cyber Learning`, description: clip(`${S.title}: ${intro} A free, vendor-neutral library with ${list.length} ${S.label.toLowerCase()}.`, 158), h1: S.title, body, active: S.path,
      ld: [{ "@context": "https://schema.org", "@type": "CollectionPage", name: S.title, url: SITE + path, mainEntity: { "@type": "ItemList", numberOfItems: list.length, itemListElement: list.slice(0, 100).map((i, k) => ({ "@type": "ListItem", position: k + 1, url: SITE + pathOf(i), name: i.name })) } }] }));
  }

  // Topic pages
  const topicRows = [];
  for (const d of taxonomy.domains) {
    const list = items.filter(i => (i.domains || []).includes(d.key)).sort(order);
    if (!list.length) continue;
    const path = `/topics/${d.key}/`, h1 = `${d.label}: podcasts, books, platforms and experts`;
    topicRows.push(`<li><a href="${path}">${esc(d.label)}</a> <span class="note">${list.length}</span></li>`);
    const groups = Object.entries(SECTIONS).map(([type, S]) => [S, list.filter(i => i.type === type)]).filter(([, l]) => l.length);
    const body = `<h1>${esc(h1)}</h1><p class="lede">${esc(d.hint || "")}${d.hint ? ". " : ""}Hand-picked, vendor-neutral resources on ${esc(d.label.toLowerCase())}, MCL Picks first.</p>
${groups.map(([S, l]) => `<h2>${esc(S.label)} (${l.length})</h2><ul class="list">${l.map(i => listItem(i, hue)).join("")}</ul>`).join("\n")}`;
    await write(path, page({ path, title: `${d.label} podcasts, books and experts · My Cyber Learning`, description: clip(`The best ${d.label.toLowerCase()} podcasts, books, learning platforms and experts to follow, in a free, vendor-neutral library. ${d.hint || ""}`, 158), h1, body, crumbs: [{ name: "Topics", path: "/topics/" }], active: "topics" }));
  }
  await write("/topics/", page({ path: "/topics/", title: "Cyber security topics · My Cyber Learning", description: "Browse cyber security podcasts, books, learning platforms and experts by topic, from cloud and AppSec to threat intelligence and careers.", h1: "Browse by topic", active: "topics",
    body: `<h1>Browse by topic</h1><p class="lede">Every podcast, book, platform and expert in the library is tagged with the security topics it covers.</p><ul class="topics">${topicRows.join("")}</ul>` }));

  // The site tour on its own page, with a link that never changes (/video/), for sharing.
  // Details come from frontend/tour/tour.json, which is updated with each new cut.
  const tour = await readFile(join(dist, "tour", "tour.json"), "utf8").then(JSON.parse, () => null);
  if (tour) {
    const t = n => `/tour/${tour[n]}`, abs = n => SITE + t(n);
    const title = "A 2-minute tour of My Cyber Learning";
    const desc = "Find podcasts, books, learning platforms and experts, start with MCL Picks, use your learning map to spot gaps, get the Daily Briefing by email, and see how the site keeps your data private.";
    const body = `<h1>${esc(title)}</h1><p class="lede">${esc(desc)}</p>
<video class="tour" controls playsinline preload="none" poster="${esc(t("poster"))}" width="1280" height="720">
<source src="${esc(t("hls"))}" type="application/vnd.apple.mpegurl"><source src="${esc(t("file"))}" type="video/mp4">
<track kind="captions" srclang="en" label="English" src="${esc(t("captions"))}">
</video>
<p class="note">Captions are available from the CC button. The video is hosted on this site: no third-party player, no tracking.</p>
<h2>What it covers</h2><ul class="chapters">${tour.chapters.map(([at, what]) => `<li><span>${esc(at)}</span> ${esc(what)}</li>`).join("")}</ul>
<p class="cta"><a class="open" href="/">Open the library</a> <a href="/tour/latest.mp4">Download the video (MP4)</a></p>`;
    await write("/video/", page({ path: "/video/", title: `${title} · My Cyber Learning`, description: desc, h1: "Site tour", body, image: `tour/${tour.poster}`,
      head: `<meta property="og:video" content="${esc(abs("file"))}"><meta property="og:video:type" content="video/mp4"><meta property="og:video:width" content="1280"><meta property="og:video:height" content="720">`,
      ld: [{ "@context": "https://schema.org", "@type": "VideoObject", name: title, description: desc, thumbnailUrl: abs("poster"), contentUrl: abs("file"), embedUrl: SITE + "/video/", uploadDate: /^\d{4}-\d{2}-\d{2}$/.test(tour.uploaded || "") ? `${tour.uploaded}T12:00:00+00:00` : tour.uploaded, duration: tour.duration }] }));
  }

  // Sitemap and robots
  const today = new Date().toISOString().slice(0, 10);
  await writeFile(join(dist, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map(u => `  <url><loc>${SITE}${u}</loc><lastmod>${today}</lastmod></url>`).join("\n")}\n</urlset>\n`);
  await writeFile(join(dist, "robots.txt"), `User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /auth/\nDisallow: /admin\n\nSitemap: ${SITE}/sitemap.xml\n`);
  return urls.length;
}
