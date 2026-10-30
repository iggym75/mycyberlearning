import { test } from "node:test";
import assert from "node:assert/strict";
import { inferCadence, parsePodnewsRating, bestMatch, appleId, normaliseIsbn, titlesMatch } from "../pure.mjs";

const NOW = Date.parse("2026-10-30T12:00:00Z");
const series = (n, everyDays, endDaysAgo = 1) => Array.from({ length: n }, (_, i) => new Date(NOW - (endDaysAgo + i * everyDays) * 86_400_000).toUTCString());

test("cadence: daily, weekly, fortnightly, monthly", () => {
  assert.equal(inferCadence(series(60, 1), { now: NOW }).freq, "daily");
  assert.equal(inferCadence(series(30, 7), { now: NOW }).freq, "weekly");
  assert.equal(inferCadence(series(20, 14), { now: NOW }).freq, "biweekly");
  assert.equal(inferCadence(series(12, 30), { now: NOW }).freq, "monthly");
  assert.equal(inferCadence(series(40, 2.5), { now: NOW }).freq, "multiweekly");
});

test("cadence: stale shows become irregular, then ended", () => {
  assert.equal(inferCadence(series(30, 7, 200), { now: NOW }).freq, "irregular");
  const ended = inferCadence(series(30, 7, 500), { now: NOW });
  assert.equal(ended.freq, "ended");
  assert.equal(ended.status, "ended");
});

test("cadence: launch date only when the feed is complete", () => {
  const d = series(10, 7);
  assert.match(inferCadence(d, { now: NOW, complete: true }).launched, /^2026-0[89]$/);
  assert.equal(inferCadence(d, { now: NOW, complete: false }).launched, null);
  assert.equal(inferCadence([], { now: NOW }), null);
});

test("podnews rating parser", () => {
  assert.deepEqual(parsePodnewsRating('<p><span>★★★★★</span> 4.8 via 1,852 ratings in Apple Podcasts</p>'), { v: 4.8, n: 1852 });
  assert.deepEqual(parsePodnewsRating("5 via 3 ratings"), { v: 5, n: 3 });
  assert.equal(parsePodnewsRating("no ratings here"), null);
});

test("bestMatch prefers exact, then prefix", () => {
  const res = [{ collectionName: "Darknet Diaries Fan Show" }, { collectionName: "Darknet Diaries" }];
  assert.equal(bestMatch("Darknet Diaries", res).collectionName, "Darknet Diaries");
  assert.equal(bestMatch("The CyberWire Daily", [{ collectionName: "CyberWire Daily" }]).collectionName, "CyberWire Daily");
  assert.equal(bestMatch("Nothing", res), null);
});

test("appleId", () => {
  assert.equal(appleId("https://podcasts.apple.com/podcast/id1296350485"), "1296350485");
  assert.equal(appleId(undefined), null);
});

test("ISBN validation", () => {
  assert.equal(normaliseIsbn("978-1-4920-7621-6"), "9781492076216");
  assert.equal(normaliseIsbn("9781492076217"), null);
  assert.equal(normaliseIsbn("0-306-40615-2"), "0306406152");
  assert.equal(normaliseIsbn("123"), null);
  assert.equal(normaliseIsbn(undefined), null);
});

test("titlesMatch ignores subtitles, editions and leading 'The'", () => {
  assert.ok(titlesMatch("Zero Trust Networks (2nd ed.)", "Zero trust networks: building secure systems in untrusted networks"));
  assert.ok(titlesMatch("The Cybersecurity Manager's Guide", "Cybersecurity Manager's Guide"));
  assert.ok(!titlesMatch("Security as Code", "Learning Cloud Security"));
});
