// scripts/send-updates.mjs against a local SQLite database, with the email provider stubbed out.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localD1 } from "../d1.mjs";
import { londonDate } from "../../worker/src/lib/mail.js";

const dir = mkdtempSync(join(tmpdir(), "mcl-updates-")), file = join(dir, "d1.sqlite"), outbox = join(dir, "outbox.jsonl");
const run = () => execFileSync(process.execPath, ["--no-warnings", "--import", new URL("./fixtures/stub-mail-fetch.mjs", import.meta.url).pathname, new URL("../send-updates.mjs", import.meta.url).pathname], {
  env: { ...process.env, D1_LOCAL_FILE: file, STUB_OUTBOX: outbox, TOKEN_SECRET: "t".repeat(48), MAIL_FROM: "My Cyber Learning <briefing@mycyberlearning.co.uk>",
    MAIL_PROVIDER: "resend", MAIL_API_KEY: "re_test", MAIL_DAILY_LIMIT: "100", MAIL_RATE_PER_MINUTE: "60000", SITE_URL: "https://mycyberlearning.co.uk" }, encoding: "utf8" });
const sent = () => existsSync(outbox) ? readFileSync(outbox, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)) : [];

test("update emails go only to confirmed, opted-in addresses, within the day's allowance, once each", async () => {
  const db = await localD1(file);
  const t = new Date().toISOString();
  const acct = (id, email, verified, optIn) => db.prepare("INSERT INTO accounts (id, created_at, session_gen, email, email_verified_at, updates_opt_in, name) VALUES (?, ?, 0, ?, ?, ?, ?)").bind(id, t, email, verified ? t : null, optIn ? 1 : 0, "Ada").run();
  await acct("a".repeat(22), "yes@example.com", true, true);
  await acct("b".repeat(22), "unconfirmed@example.com", false, true);
  await acct("c".repeat(22), "no@example.com", true, false);
  await db.prepare("INSERT INTO announcements (subject, body, status, created_at, updated_at, queued_at) VALUES ('New: My list', 'Hello there, friends.', 'queued', ?, ?, ?)").bind(t, t, t).run();
  // The briefing already used the whole allowance today: nothing goes out
  await db.prepare("INSERT INTO digestlog (date, status, sent) VALUES (?, 'done', 95)").bind(londonDate()).run();
  run();
  assert.equal(sent().length, 0);
  // Room again: exactly one email, to the right person, with one-click unsubscribe
  await db.prepare("UPDATE digestlog SET sent = 0").run();
  run();
  const out = sent();
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].to, ["yes@example.com"]);
  assert.equal(out[0].headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
  assert.match(out[0].headers["List-Unsubscribe"], /\/api\/account\/updates\/unsubscribe\?a=a{22}&t=/);
  assert.match(out[0].html, /Hi Ada,/);
  const a = await db.prepare("SELECT status, sent FROM announcements").first();
  assert.equal(a.status, "done"); assert.equal(a.sent, 1);
  // Running again sends nothing more
  run();
  assert.equal(sent().length, 1);
});
