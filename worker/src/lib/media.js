// Serves the site tour video (/tour/*) with HTTP byte ranges. Workers static assets always answer 200 with the
// whole file, but Safari only plays video that answers "Range: bytes=0-1" with 206 Partial Content.
// Public, read-only files: no cookies, no personal data, nothing logged.

const MAX_AGE = 604800; // a week, like the covers: a replaced video needs a new file name

// One "bytes=a-b", "bytes=a-" or "bytes=-n" range → {start, end} (inclusive), "unsatisfiable", or null to send the
// whole file (no header, several ranges, or a header we don't understand, as RFC 9110 allows).
export function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  if (m[1] === "") { // the last n bytes
    const n = Number(m[2]);
    if (n === 0) return "unsatisfiable";
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  let end = m[2] === "" ? size - 1 : Number(m[2]);
  if (start >= size) return "unsatisfiable";
  if (end < start) return null;
  if (end >= size) end = size - 1;
  return { start, end };
}

// A stream of bytes start..end (inclusive) of `body`. It stops reading as soon as the range is sent.
export function sliceStream(body, start, end) {
  const reader = body.getReader();
  let pos = 0;
  return new ReadableStream({
    async pull(ctl) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) { ctl.close(); return; }
        const from = pos, to = pos + value.byteLength; pos = to;
        if (to <= start) continue; // still before the range
        const a = Math.max(start, from) - from, b = Math.min(end + 1, to) - from;
        if (b > a) ctl.enqueue(value.subarray(a, b));
        if (to > end) { ctl.close(); reader.cancel().catch(() => {}); }
        return;
      }
    },
    cancel(reason) { return reader.cancel(reason); }
  });
}

export async function serveMedia(req, env) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
  }
  const url = new URL(req.url);
  // Ask for the plain file (no Range, no compression) so the byte offsets are the file's own.
  const res = await env.ASSETS.fetch(new Request(url.origin + url.pathname, { method: "GET" }));
  if (res.status !== 200) {
    const h = new Headers(res.headers); h.set("cache-control", "no-store");
    return new Response(res.status === 404 ? "Not found" : res.body, { status: res.status, headers: h });
  }
  let size = Number(res.headers.get("content-length")), whole = null;
  if (!Number.isFinite(size) || size <= 0) { // no length given: read the file once to know it (a few MB)
    whole = new Uint8Array(await res.arrayBuffer()); size = whole.byteLength;
  }
  const source = () => whole ? new Response(whole).body : res.body;
  const h = new Headers(res.headers);
  h.set("accept-ranges", "bytes");
  h.set("cache-control", `public, max-age=${MAX_AGE}`);
  h.delete("content-encoding");
  h.set("x-content-type-options", "nosniff");
  h.set("cross-origin-resource-policy", "same-origin"); // our page only: no hot-linking from other sites
  h.set("content-length", String(size));
  const range = parseRange(req.headers.get("range"), size);
  if (range === "unsatisfiable") {
    res.body?.cancel();
    return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}`, "accept-ranges": "bytes" } });
  }
  if (!range) {
    return new Response(req.method === "HEAD" ? null : source(), { status: 200, headers: h });
  }
  const len = range.end - range.start + 1;
  h.set("content-range", `bytes ${range.start}-${range.end}/${size}`);
  h.set("content-length", String(len));
  if (req.method === "HEAD") { res.body?.cancel(); return new Response(null, { status: 206, headers: h }); }
  let body = whole ? new Response(whole.subarray(range.start, range.end + 1)).body : sliceStream(res.body, range.start, range.end);
  // In Workers, a FixedLengthStream sends Content-Length instead of chunked encoding, which Safari prefers.
  if (typeof FixedLengthStream === "function") {
    const fixed = new FixedLengthStream(len);
    body.pipeTo(fixed.writable).catch(() => {});
    body = fixed.readable;
  }
  return new Response(body, { status: 206, headers: h });
}
