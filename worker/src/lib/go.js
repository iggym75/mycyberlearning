// /go/<date>/<ref>: the briefing email links each episode through our own domain (strict company mail filters
// distrust a new sender whose links all point elsewhere), and this forwards to that episode.
// Not an open redirect: it only forwards to a URL listed in that day's published briefing (frontend/news/<date>.json),
// looked up by the episode's ref. Nothing about the click is stored or logged.
const DATE = /^\d{4}-\d{2}-\d{2}$/, REF = /^[a-z0-9][a-z0-9-]{0,79}$/;

export function goPath(date, ref) {
  return DATE.test(String(date)) && REF.test(String(ref)) ? `/go/${date}/${ref}` : null;
}

export async function go(req, env) {
  const url = new URL(req.url);
  const back = () => new Response(null, { status: 302, headers: { location: "/#news", "cache-control": "no-store", "referrer-policy": "no-referrer" } });
  if (req.method !== "GET" && req.method !== "HEAD") return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
  const [, , date, ref, extra] = url.pathname.split("/");
  if (extra !== undefined || !goPath(date, ref)) return back();
  const res = await env.ASSETS.fetch(new Request(`${url.origin}/news/${date}.json`)).catch(() => null);
  if (!res || !res.ok) return back();
  const digest = await res.json().catch(() => null);
  const ep = (digest?.episodes || []).find(e => e && e.ref === ref);
  let target = null;
  try { const u = new URL(ep?.url); if (u.protocol === "https:" || u.protocol === "http:") target = u.href; } catch {}
  if (!target) return back();
  return new Response(null, { status: 302, headers: { location: target, "cache-control": "public, max-age=86400", "referrer-policy": "no-referrer" } });
}
