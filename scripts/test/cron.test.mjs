import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatchBriefing, dispatchWorkflow } from "../../worker/src/cron.js";

process.env.GH_DISPATCH_TOKEN = "test-token"; process.env.GITHUB_REPO = "o/r";
const noSleep = async () => {};
const fake = (answers) => { const calls = []; return { calls, fetchImpl: async (url, init = {}) => {
  calls.push({ url, method: init.method || "GET" }); const a = answers.shift();
  if (a instanceof Error) throw a; return typeof a === "number" ? new Response(null, { status: a }) : new Response(JSON.stringify(a), { status: 200 });
} }; };
const at = iso => new Date(iso);

test("cron: outside 08:xx London does nothing", async () => {
  const f = fake([]);
  assert.deepEqual(await dispatchBriefing(at("2026-11-28T07:30:00Z"), { ...f, sleep: noSleep }), { skipped: "not 08:xx in London" });
  assert.equal(f.calls.length, 0);
});

test("cron: 08:30 dispatches, retrying a 5xx and a network error", async () => {
  const f = fake([502, new Error("reset"), 204]);
  const r = await dispatchBriefing(at("2026-11-28T08:30:00Z"), { ...f, sleep: noSleep });
  assert.deepEqual(r, { ok: true, attempts: 3 });
  assert.ok(f.calls.every(c => c.method === "POST" && c.url.endsWith("/actions/workflows/news.yml/dispatches")));
});

test("cron: a 4xx (e.g. expired token) is not retried", async () => {
  const f = fake([401]);
  assert.deepEqual(await dispatchBriefing(at("2026-11-28T08:30:00Z"), { ...f, sleep: noSleep }), { error: 401 });
  assert.equal(f.calls.length, 1);
});

test("cron: gives up after four tries", async () => {
  const f = fake([500, 500, 500, 500, 204]);
  assert.deepEqual(await dispatchWorkflow("news.yml", {}, { ...f, sleep: noSleep }), { error: 500 });
  assert.equal(f.calls.length, 4);
});

test("cron: 08:50 asks again only if no run started today", async () => {
  const started = fake([{ total_count: 1 }]);
  assert.deepEqual(await dispatchBriefing(at("2026-11-28T08:50:00Z"), { ...started, sleep: noSleep }), { skipped: "already started today" });
  assert.equal(started.calls.length, 1); assert.ok(started.calls[0].url.includes("event=workflow_dispatch"));
  assert.ok(decodeURIComponent(started.calls[0].url).includes("created=>=2026-11-28"));
  const missing = fake([{ total_count: 0 }, 204]);
  assert.deepEqual(await dispatchBriefing(at("2026-11-28T08:50:00Z"), { ...missing, sleep: noSleep }), { ok: true, attempts: 1 });
  const unknown = fake([503, 204]); // can't tell: start it anyway (the workflow sends at most once a day)
  assert.deepEqual(await dispatchBriefing(at("2026-11-28T08:50:00Z"), { ...unknown, sleep: noSleep }), { ok: true, attempts: 1 });
});

test("cron: summer time uses the 07:xx UTC crons", async () => {
  const f = fake([204]);
  assert.deepEqual(await dispatchBriefing(at("2026-06-10T07:30:00Z"), { ...f, sleep: noSleep }), { ok: true, attempts: 1 });
});

test("cron: the admin button never waits", async () => {
  const f = fake([503, 204]);
  assert.deepEqual(await dispatchWorkflow("updates.yml", {}, { ...f, sleep: () => { throw new Error("slept"); }, retry: false }), { error: 503 });
});
