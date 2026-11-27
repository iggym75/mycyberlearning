import test from "node:test";
import assert from "node:assert/strict";
import { recentEpisodes } from "../pure.mjs";

test("recentEpisodes: last 8 days only, newest first, plain trimmed titles, at most 6", () => {
  const now = Date.parse("2026-11-30T07:00:00Z");
  const day = d => new Date(now - d * 864e5).toUTCString();
  const items = [
    { title: "Old one", pubDate: day(9) },
    { title: "  <b>Two</b>\n days   ago ", pubDate: day(2) },
    { title: { "#text": "CDATA title" }, pubDate: day(1) },
    { title: "No date" },
    { title: "", pubDate: day(1) },
    { title: "Far future", pubDate: new Date(now + 5 * 864e5).toUTCString() },
    { title: "X".repeat(300), pubDate: day(3) },
    ...Array.from({ length: 8 }, (_, k) => ({ title: `Daily ${k}`, pubDate: day(4 + k * 0.1) }))
  ];
  const r = recentEpisodes(items, { now });
  assert.equal(r.length, 6);
  assert.deepEqual(r[0], { d: "2026-11-29", t: "CDATA title" });
  assert.deepEqual(r[1], { d: "2026-11-28", t: "Two days ago" });
  assert.equal(r[2].t.length, 160);
  assert.ok(!r.some(e => /Old one|No date|Far future/.test(e.t)));
  assert.deepEqual(recentEpisodes(null), []);
});
