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
    const ld = pod.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g).map(s => JSON.parse(s.replace(/^<script[^>]*>|<\/script>$/g, "")));
    assert.ok(ld.some(o => o["@type"] === "PodcastSeries" && o.name.startsWith("Evil")), "structured data parses");
    const sitemap = await readFile(join(dir, "sitemap.xml"), "utf8");
    assert.ok(sitemap.includes("/books/good-book/") && sitemap.includes("/topics/cloud/") && !sitemap.includes("secret"));
    assert.equal((sitemap.match(/<url>/g) || []).length, n);
    assert.match(await readFile(join(dir, "robots.txt"), "utf8"), /Disallow: \/api\/[\s\S]*Sitemap: https:\/\/mycyberlearning\.co\.uk\/sitemap\.xml/);
    await assert.rejects(readFile(join(dir, "podcasts/secret/index.html")), "hidden items get no page");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
