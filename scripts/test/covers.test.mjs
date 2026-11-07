import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

test("every catalogue image points at a file that exists", () => {
  const { items } = JSON.parse(readFileSync(new URL("../../data/catalogue.json", import.meta.url), "utf8"));
  const missing = items.filter(i => typeof i.logo === "string" && i.logo.startsWith("covers/") && !existsSync(new URL(`../../frontend/${i.logo}`, import.meta.url))).map(i => `${i.id} -> ${i.logo}`);
  assert.deepEqual(missing, []);
});
