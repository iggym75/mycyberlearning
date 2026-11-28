// Starts the daily briefing at 08:30 UK time. GitHub's own schedule is often hours late or skipped entirely, so
// Cloudflare's cron (reliable, free) asks GitHub Actions to run news.yml. Two UTC crons cover GMT and BST; only the
// one that lands in the 08:00-08:59 London hour acts. The workflow builds and emails at most once a day, so the
// GitHub schedule can stay on as a fallback without sending twice.
// Each cron fires at :30 and :50. At :30 it starts the briefing; at :50 it checks that a run started today and,
// if GitHub dropped the first request (as on 28 Nov 2026, when the briefing went out at 16:32), asks again.
import { londonHour, londonDate } from "./lib/mail.js";

export async function dispatchBriefing(now = new Date(), { fetchImpl = fetch, sleep } = {}) {
  if (londonHour(now) !== 8) return { skipped: "not 08:xx in London" };
  if (now.getUTCMinutes() >= 45) {
    const started = await briefingStartedToday(now, fetchImpl);
    if (started === true) return { skipped: "already started today" };
    // Not started, or GitHub couldn't say: ask anyway. news.yml builds and emails at most once a day.
  }
  return dispatchWorkflow("news.yml", { send: "true" }, { fetchImpl, sleep });
}

/** true/false: has news.yml been started by the Worker today (London date)? null if GitHub couldn't be asked. */
export async function briefingStartedToday(now, fetchImpl = fetch) {
  const token = process.env.GH_DISPATCH_TOKEN, repo = process.env.GITHUB_REPO;
  if (!token || !repo) return null;
  const day = londonDate(now);
  try {
    const r = await fetchImpl(`https://api.github.com/repos/${repo}/actions/workflows/news.yml/runs?event=workflow_dispatch&per_page=5&created=${encodeURIComponent(">=" + day + "T00:00:00Z")}`,
      { headers: ghHeaders(token) });
    if (!r.ok) { console.error(`news.yml check: GitHub answered ${r.status}`); return null; }
    const j = await r.json();
    return Number(j.total_count) > 0;
  } catch (e) { console.error("news.yml check failed"); return null; }
}

const ghHeaders = token => ({ authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28",
  "user-agent": "mycyberlearning-worker", "content-type": "application/json" });

/** Asks GitHub Actions to run a workflow on main (used for the briefing and for sending admin update emails). */
// Retries network errors, 5xx and 429 three times (after 5 s, 30 s, 90 s); a 4xx such as an expired token is not retried.
// The admin "Send an update" button passes retry: false so its request never waits.
export async function dispatchWorkflow(file, inputs = {}, { fetchImpl = fetch, sleep = ms => new Promise(r => setTimeout(r, ms)), retry = true } = {}) {
  const token = process.env.GH_DISPATCH_TOKEN, repo = process.env.GITHUB_REPO;
  if (!token || !repo) { console.log(`${file} trigger: GH_DISPATCH_TOKEN or GITHUB_REPO is not set`); return { skipped: "not configured" }; }
  const waits = retry ? [5000, 30000, 90000] : []; // only the cron retries; a web request answers at once
  for (let attempt = 0; ; attempt++) {
    let status = 0;
    try {
      const r = await fetchImpl(`https://api.github.com/repos/${repo}/actions/workflows/${file}/dispatches`, {
        method: "POST", headers: ghHeaders(token), body: JSON.stringify({ ref: "main", inputs })
      });
      status = r.status;
    } catch { status = 0; }
    if (status === 204) { console.log(`${file} trigger: dispatched${attempt ? ` (attempt ${attempt + 1})` : ""}`); return { ok: true, attempts: attempt + 1 }; }
    console.error(`${file} trigger: GitHub answered ${status || "no response"}`); // never log the token or response body
    const retryable = status === 0 || status === 429 || status >= 500;
    if (!retryable || attempt >= waits.length) return { error: status || "network" };
    await sleep(waits[attempt]);
  }
}
