// Starts the daily briefing at 08:30 UK time. GitHub's own schedule is often hours late or skipped entirely, so
// Cloudflare's cron (reliable, free) asks GitHub Actions to run news.yml. Two UTC crons cover GMT and BST; only the
// one that lands in the 08:00-08:59 London hour acts. The workflow builds and emails at most once a day, so the
// GitHub schedule can stay on as a fallback without sending twice.
import { londonHour } from "./lib/mail.js";

export async function dispatchBriefing(now = new Date()) {
  if (londonHour(now) !== 8) return { skipped: "not 08:xx in London" };
  const token = process.env.GH_DISPATCH_TOKEN, repo = process.env.GITHUB_REPO;
  if (!token || !repo) { console.log("briefing trigger: GH_DISPATCH_TOKEN or GITHUB_REPO is not set"); return { skipped: "not configured" }; }
  const r = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/news.yml/dispatches`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28",
      "user-agent": "mycyberlearning-worker", "content-type": "application/json" },
    body: JSON.stringify({ ref: "main", inputs: { send: "true" } })
  });
  if (r.status !== 204) { console.error(`briefing trigger: GitHub answered ${r.status}`); return { error: r.status }; } // never log the token or response body
  console.log("briefing trigger: news.yml dispatched");
  return { ok: true };
}
