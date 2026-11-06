// D1 access for the Node scripts, with the same shape as the Worker's D1 binding:
//   db.prepare(sql).bind(...args).all() -> { results }   .first() -> row | null   .run() -> { meta: { changes } }
//   db.batch([stmt, ...])
//
// Remote (GitHub Actions, your laptop): Cloudflare's D1 HTTP API. Needs CLOUDFLARE_ACCOUNT_ID, D1_DATABASE_ID and
//   CLOUDFLARE_API_TOKEN (a token limited to "D1: Edit" on your account).
// Local (tests, offline work): set D1_LOCAL_FILE to a SQLite file path (or ":memory:"); uses Node's built-in sqlite.
import { readdir, readFile } from "node:fs/promises";

const MIGRATIONS = new URL("../worker/migrations/", import.meta.url);
const norm = v => (v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : v);

/* ---------- Local SQLite shim ---------- */
export async function localD1(file = ":memory:", { migrate = true } = {}) {
  const { DatabaseSync } = await import("node:sqlite");
  const sqlite = new DatabaseSync(file);
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a.map(norm)),
    all: async () => ({ results: sqlite.prepare(sql).all(...args).map(r => ({ ...r })) }),
    first: async col => { const r = sqlite.prepare(sql).get(...args); return r ? (col ? r[col] : { ...r }) : null; },
    run: async () => { const r = sqlite.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; },
    _exec: () => sqlite.prepare(sql).run(...args)
  });
  const db = {
    prepare: sql => stmt(sql),
    async batch(list) {
      sqlite.exec("BEGIN");
      try { const out = list.map(s => { const r = s._exec(); return { meta: { changes: Number(r.changes) } }; }); sqlite.exec("COMMIT"); return out; }
      catch (e) { sqlite.exec("ROLLBACK"); throw e; }
    },
    exec: async sql => sqlite.exec(sql),
    close: () => sqlite.close()
  };
  // Like wrangler, record applied migrations so reopening a local file doesn't re-run them (ALTER TABLE isn't repeatable).
  if (migrate) {
    sqlite.exec("CREATE TABLE IF NOT EXISTS d1_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
    const done = new Set(sqlite.prepare("SELECT name FROM d1_migrations").all().map(r => r.name));
    for (const f of (await readdir(MIGRATIONS)).filter(f => f.endsWith(".sql")).sort()) {
      if (done.has(f)) continue;
      sqlite.exec(await readFile(new URL(f, MIGRATIONS), "utf8"));
      sqlite.prepare("INSERT INTO d1_migrations (name, applied_at) VALUES (?, ?)").run(f, new Date().toISOString());
    }
  }
  return db;
}

/* ---------- Remote D1 over HTTPS ---------- */
export function remoteD1({ accountId = process.env.CLOUDFLARE_ACCOUNT_ID, databaseId = process.env.D1_DATABASE_ID, token = process.env.CLOUDFLARE_API_TOKEN } = {}) {
  if (!accountId || !databaseId || !token) throw new Error("Set CLOUDFLARE_ACCOUNT_ID, D1_DATABASE_ID and CLOUDFLARE_API_TOKEN (or D1_LOCAL_FILE for a local database).");
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(databaseId)}/query`;
  async function query(sql, params) {
    for (let attempt = 1; ; attempt++) {
      const r = await fetch(endpoint, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ sql, params }) });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.success) return j.result?.[0] || { results: [], meta: {} };
      if ((r.status === 429 || r.status >= 500) && attempt < 4) { await new Promise(res => setTimeout(res, attempt * 1500)); continue; }
      throw new Error(`D1 query failed (${r.status}): ${(j.errors || []).map(e => e.message).join("; ") || "unknown error"}`);
    }
  }
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a.map(norm)),
    all: async () => ({ results: (await query(sql, args)).results || [] }),
    first: async col => { const r = ((await query(sql, args)).results || [])[0]; return r ? (col ? r[col] : r) : null; },
    run: async () => ({ meta: (await query(sql, args)).meta || {} }),
    _q: () => query(sql, args)
  });
  return {
    prepare: sql => stmt(sql),
    // Not a single transaction over HTTP: statements run in order. Scripts only batch idempotent writes.
    async batch(list) { const out = []; for (const s of list) out.push({ meta: (await s._q()).meta || {} }); return out; }
  };
}

/** The scripts' database: local SQLite when D1_LOCAL_FILE is set, otherwise remote D1. */
export const openD1 = () => (process.env.D1_LOCAL_FILE ? localD1(process.env.D1_LOCAL_FILE) : remoteD1());
