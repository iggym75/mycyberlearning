import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSitePages, pathOf } from "../site-pages.mjs";

const taxonomy = { domains: [{ key: "cloud", label: "Cloud Security", hue: 200, hint: "Cloud things" }], levels: [{ key: "beginner", label: "Beginner" }], frequencies: [{ key: "weekly", label: "Weekly" }], platformKinds: [{ key: "lab", label: "Hands-on labs" }], costs: [{ key: "free", label: "Free" }], scope: {} };
const items = [
  { id: "evil-show", type: "podcast", name: `Evil <script>alert(1)</script> "Show"`, by: "A & B", desc: "Desc </title><img src=x onerror=alert(1)>", domains: ["cloud"], level: ["beginner"], freq: "weekly", web: "javascript:alert(1)", apple: "https://podcasts.apple.com/x", logo: "covers/podcast-evil.jpg" },
  { id: "book-good-book", type: "book", name: "Good Book", by: "C D", desc: "A book.", domains: ["cloud"], isbn: "9781234567897" },
  { id: "expert-jane-doe", type: "person", name: "Jane Doe", by: "Researcher", desc: "Person.", domains: ["cloud"], bluesky: "https://bsky.app/profile/jane" },
  { id: "secret", type: "podcast", name: "Hidden", desc: "x", domains: ["cloud"], hidden: true },
];

test("site pages: escaped, only http links, hidden items left out, sitemap and robots written", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcl-pages-"));
  try {
    const n = await buildSitePages(dir, { items }, taxonomy);
    assert.equal(pathOf(items[1]), "/books/good-book/"); assert.equal(pathOf(items[2]), "/experts/jane-doe/");
    const pod = await readFile(join(dir, "podcasts/evil-show/index.html"), "utf8");
    assert.ok(!pod.includes("<script>alert(1)"), "names are escaped");
    assert.ok(!/<img src=x/.test(pod), "descriptions are escaped");
    assert.ok(!pod.includes("javascript:"), "non-http links are dropped");
    assert.ok(pod.includes('href="https://podcasts.apple.com/x"'));
    assert.ok(pod.includes('<link rel="canonical" href="https://mycyberlearning.co.uk/podcasts/evil-show/">'));
    const open = '<script type="application/ld+json">', ld = pod.split(open).slice(1).map(part => JSON.parse(part.slice(0, part.indexOf("</" + "script>"))));
    assert.ok(ld.some(o => o["@type"] === "PodcastSeries" && o.name.startsWith("Evil")), "structured data parses");
    const sitemap = await readFile(join(dir, "sitemap.xml"), "utf8");
    assert.ok(sitemap.includes("/books/good-book/") && sitemap.includes("/topics/cloud/") && !sitemap.includes("secret"));
    assert.equal((sitemap.match(/<url>/g) || []).length, n);
    assert.match(await readFile(join(dir, "robots.txt"), "utf8"), /Disallow: \/api\/[\s\S]*Sitemap: https:\/\/mycyberlearning\.co\.uk\/sitemap\.xml/);
    await assert.rejects(readFile(join(dir, "podcasts/secret/index.html")), "hidden items get no page");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("site pages: /video/ is built from tour.json with no scripts and only our own files", async () => {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const dir = await mkdtemp(join(tmpdir(), "mcl-video-"));
  try {
    await mkdir(join(dir, "tour"), { recursive: true });
    await writeFile(join(dir, "tour", "tour.json"), JSON.stringify({ file: "mcl-tour-v9.mp4", hls: "hls-v9/index.m3u8", poster: "mcl-tour-v9.jpg", captions: "mcl-tour-v9.en.vtt", duration: "PT2M31S", uploaded: "2026-11-18", chapters: [["0:04", "Welcome <b>"]] }));
    await buildSitePages(dir, { items: [] }, { domains: [] });
    const html = await readFile(join(dir, "video", "index.html"), "utf8");
    assert.match(html, /<video class="tour"[^>]*preload="none"/);
    assert.match(html, /src="\/tour\/mcl-tour-v9\.mp4" type="video\/mp4"/);
    assert.match(html, /og:video" content="https:\/\/mycyberlearning\.co\.uk\/tour\/mcl-tour-v9\.mp4"/);
    assert.ok(html.includes("Welcome &lt;b&gt;"));
    assert.equal(html.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g, "").includes("<script"), false);
    assert.ok((await readFile(join(dir, "sitemap.xml"), "utf8")).includes("/video/"));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("site pages: header and breadcrumb links go to the library, not to the static section pages", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcl-nav-"));
  try {
    const item = { id: "nav-pod", type: "podcast", name: "Nav Pod", domains: [], level: [] };
    await buildSitePages(dir, { items: [item] }, { domains: [] });
    const html = await readFile(join(dir, "podcasts", "nav-pod", "index.html"), "utf8");
    const top = html.slice(html.indexOf("<header>"), html.indexOf('<p class="crumbs">') + 400);
    for (const h of ["/#podcasts", "/#books", "/#platforms", "/#experts", "/#news"]) assert.ok(top.includes(`href="${h}"`), h);
    assert.equal(/href="\/(podcasts|books|platforms|experts|topics)\/"/.test(top), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
