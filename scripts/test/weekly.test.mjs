import test from "node:test";
import assert from "node:assert/strict";
import { weeklyDigest, weekStart, shortTitle, epTitle } from "../../worker/src/lib/weekly.js";
import { renderWeeklyEmail } from "../../worker/src/lib/mail.js";

process.env.TOKEN_SECRET ||= "t".repeat(48);
const domains = [{ key: "cti", label: "Threat Intelligence" }, { key: "news", label: "News & Briefings" }, { key: "ai", label: "AI Security" }];
const items = [
  { id: "a", type: "podcast", name: "Alpha <Show>", domains: ["news"], recent: [{ d: "2026-11-27", t: "New one" }, { d: "2026-11-26", t: "Second (Nov 26th 2026)" }, { d: "2026-11-25", t: "Third" }, { d: "2026-11-10", t: "Too old" }] },
  { id: "b", type: "podcast", name: "Beta", domains: ["cti"], recent: [] },
  { id: "c", type: "podcast", name: "Gamma", domains: ["news"], added: "2026-11-25" },             // new in a covered topic
  { id: "d", type: "podcast", name: "Delta", domains: ["ai"], curator: true, rating: { v: 4.8, n: 50 } }, // gap pick
  { id: "e", type: "book", name: "A book", domains: ["ai"], curator: true },
  { id: "h", type: "podcast", name: "Hidden", domains: ["news"], hidden: true, added: "2026-11-25" }
];
const since = "2026-11-23";

test("weeklyDigest: podcasts only, last 7 days, new in your topics, one gap pick, one story a day", () => {
  const w = weeklyDigest({ items, listIds: ["a", "b", "e"], domains, since,
    stories: [{ date: "2026-11-27", title: "S1", domains: ["news"] }, { date: "2026-11-27", title: "S1b", domains: ["news"] }, { date: "2026-11-26", title: "Off topic", domains: ["ai"] }, { date: "2026-11-20", title: "Old", domains: ["news"] }],
    whatsnew: [{ day: "2026-11-27", title: "W", body: "B" }, { day: "2026-11-01", title: "Old", body: "x" }] });
  assert.equal(w.podcasts, 2);                       // the book isn't counted
  assert.equal(w.episodes, 3);
  assert.deepEqual(w.active.map(s => s.item.id), ["a"]);
  assert.deepEqual(w.quiet.map(s => s.item.id), ["b"]);
  assert.deepEqual(w.newPods.map(i => i.id), ["c"]); // hidden one left out
  assert.equal(w.gap.item.id, "d");
  assert.deepEqual(w.highlights.map(t => t.title), ["S1"]);
  assert.deepEqual(w.news.map(n => n.title), ["W"]);
  assert.equal(w.worthSending, true);
  const empty = weeklyDigest({ items, listIds: ["b"], domains, since, stories: [], whatsnew: [] });
  assert.equal(empty.worthSending, false);           // nothing happened: no email
});

test("weekly email: own-domain links only, podcast pages, escaped text, one-click unsubscribe", () => {
  const w = weeklyDigest({ items, listIds: ["a", "b"], domains, since, stories: [], whatsnew: [{ day: "2026-11-27", title: "<New>", body: "x & y" }] });
  const m = renderWeeklyEmail({ week: w, name: "Sam <b>", siteUrl: "https://mycyberlearning.co.uk", unsubscribeUrl: "https://mycyberlearning.co.uk/api/account/weekly/unsubscribe?a=A&t=B",
    pagePath: i => `/podcasts/${i.id}/`, today: "2026-11-30" });
  const hrefs = [...m.html.matchAll(/href="([^"]+)"/g)].map(x => x[1].replace(/&amp;/g, "&"));
  assert.ok(hrefs.length >= 3);
  assert.ok(hrefs.every(h => new URL(h).hostname === "mycyberlearning.co.uk"));
  assert.ok(hrefs.some(h => h === "https://mycyberlearning.co.uk/podcasts/a/"));
  assert.ok(m.html.includes("Alpha &lt;Show&gt;") && m.html.includes("Hi Sam &lt;b&gt;") && m.html.includes("&lt;New&gt;"));
  assert.ok(!m.html.includes("<Show>") && !m.html.includes("(Nov 26th 2026)"));
  assert.ok(m.html.includes("+ 1 more in My List"));
  assert.equal(m.subject, "MCL weekly: 3 new episodes from your podcasts");
  assert.ok(m.text.split("\n").some(l => l === "Stop the weekly update: https://mycyberlearning.co.uk/api/account/weekly/unsubscribe?a=A&t=B"));
  // A page path that isn't a plain site path falls back to My List, never somewhere else
  const m2 = renderWeeklyEmail({ week: w, siteUrl: "https://mycyberlearning.co.uk", unsubscribeUrl: "https://mycyberlearning.co.uk/u", pagePath: () => "//evil.test/", today: "2026-11-30" });
  assert.ok([...m2.html.matchAll(/href="([^"]+)"/g)].every(x => new URL(x[1].replace(/&amp;/g, "&")).hostname === "mycyberlearning.co.uk"));
});

test("weekly helpers", () => {
  assert.equal(weekStart("2026-11-30"), "2026-11-23");
  assert.equal(epTitle("Syslog; GL.iNet (Nov 23rd 2026)"), "Syslog; GL.iNet");
  assert.equal(shortTitle("Aggressive SSH Scanning from 109.160.32.0/24; VMware VMSA-2026-0011 vCenter Auth Bypass"), "Aggressive SSH Scanning from 109.160.32.0/24; VMware…");
});
