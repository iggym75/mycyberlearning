// Preload for child-process tests: records email-provider calls to $STUB_OUTBOX instead of sending anything.
import { appendFileSync } from "node:fs";
globalThis.fetch = async (url, init = {}) => {
  if (String(url) === "https://api.resend.com/emails") { appendFileSync(process.env.STUB_OUTBOX, init.body + "\n"); return new Response('{"id":"x"}', { status: 200 }); }
  throw new Error("unexpected fetch " + url);
};
