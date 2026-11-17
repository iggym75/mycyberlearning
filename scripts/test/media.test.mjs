import test from "node:test";
import assert from "node:assert/strict";
import { parseRange, sliceStream, serveMedia } from "../../worker/src/lib/media.js";

test("parseRange", () => {
  assert.equal(parseRange(null, 100), null);
  assert.deepEqual(parseRange("bytes=0-1", 100), { start: 0, end: 1 });
  assert.deepEqual(parseRange("bytes=10-", 100), { start: 10, end: 99 });
  assert.deepEqual(parseRange("bytes=-10", 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange("bytes=-500", 100), { start: 0, end: 99 });
  assert.deepEqual(parseRange("bytes=50-5000", 100), { start: 50, end: 99 });
  assert.equal(parseRange("bytes=100-", 100), "unsatisfiable");
  assert.equal(parseRange("bytes=-0", 100), "unsatisfiable");
  assert.equal(parseRange("bytes=0-1,5-9", 100), null); // several ranges: whole file
  assert.equal(parseRange("bytes=9-5", 100), null);
  assert.equal(parseRange("items=0-1", 100), null);
  assert.equal(parseRange("bytes=-", 100), null);
});

const FILE = Uint8Array.from({ length: 1000 }, (_, i) => i % 251);
function chunked(bytes, size) {
  let i = 0;
  return new ReadableStream({ pull(c) { if (i >= bytes.length) return c.close(); c.enqueue(bytes.slice(i, i + size)); i += size; } });
}
const read = async s => new Uint8Array(await new Response(s).arrayBuffer());

test("sliceStream returns exactly the range across chunk edges", async () => {
  for (const [a, b] of [[0, 0], [0, 999], [63, 64], [64, 200], [999, 999], [10, 10]]) {
    assert.deepEqual(await read(sliceStream(chunked(FILE, 64), a, b)), FILE.slice(a, b + 1), `${a}-${b}`);
  }
});

const env = { ASSETS: { fetch: async r => {
  const p = new URL(r.url).pathname;
  assert.equal(r.headers.get("range"), null); // never forwards the range
  if (p !== "/tour/tour.mp4") return new Response("nope", { status: 404 });
  return new Response(chunked(FILE, 100), { headers: { "content-type": "video/mp4", "content-length": "1000" } });
} } };
const get = (range, method = "GET") => serveMedia(new Request("https://x.test/tour/tour.mp4", { method, headers: range ? { range } : {} }), env);

test("serveMedia answers ranges with 206", async () => {
  const r = await get("bytes=0-1");
  assert.equal(r.status, 206);
  assert.equal(r.headers.get("content-range"), "bytes 0-1/1000");
  assert.equal(r.headers.get("content-length"), "2");
  assert.equal(r.headers.get("accept-ranges"), "bytes");
  assert.match(r.headers.get("cache-control"), /max-age=604800/);
  assert.deepEqual(await read(r.body), FILE.slice(0, 2));
  const r2 = await get("bytes=950-");
  assert.deepEqual(await read(r2.body), FILE.slice(950));
});

test("serveMedia: whole file, HEAD, 416, 404 and methods", async () => {
  const full = await get();
  assert.equal(full.status, 200);
  assert.equal(full.headers.get("accept-ranges"), "bytes");
  assert.equal((await read(full.body)).length, 1000);
  const head = await get("bytes=0-9", "HEAD");
  assert.equal(head.status, 206); assert.equal(head.headers.get("content-length"), "10");
  const bad = await get("bytes=5000-");
  assert.equal(bad.status, 416); assert.equal(bad.headers.get("content-range"), "bytes */1000");
  const missing = await serveMedia(new Request("https://x.test/tour/nope.mp4"), env);
  assert.equal(missing.status, 404); assert.equal(missing.headers.get("cache-control"), "no-store");
  const post = await serveMedia(new Request("https://x.test/tour/tour.mp4", { method: "POST", body: "x" }), env);
  assert.equal(post.status, 405);
});

test("serveMedia works when the asset has no Content-Length", async () => {
  const env2 = { ASSETS: { fetch: async () => new Response(chunked(FILE, 128), { headers: { "content-type": "video/mp4" } }) } };
  const r = await serveMedia(new Request("https://x.test/tour/tour.mp4", { headers: { range: "bytes=100-199" } }), env2);
  assert.equal(r.status, 206); assert.equal(r.headers.get("content-range"), "bytes 100-199/1000");
  assert.deepEqual(await read(r.body), FILE.slice(100, 200));
});
