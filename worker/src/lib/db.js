// Database helpers shared by the Worker and the Node scripts.
// Everything talks to a D1-shaped object: db.prepare(sql).bind(...).all() / .first() / .run(), and db.batch([...]).
// In the Worker that is the D1 binding; in scripts it is the HTTP client or the local SQLite shim (scripts/d1.mjs).

export function rowToItem(r) {
  return { ...JSON.parse(r.data), id: r.id, hidden: !!r.hidden, community: { up: r.up || 0, down: r.down || 0 } };
}
/** Splits an item into its stored columns. Tallies are never written from here. */
export function itemData(item) {
  const { community, hidden, id, ...data } = item;
  return { id, data: JSON.stringify(data), hidden: hidden ? 1 : 0 };
}

export async function listItems(db, { includeHidden = true } = {}) {
  const sql = includeHidden ? "SELECT * FROM items ORDER BY id" : "SELECT * FROM items WHERE hidden = 0 ORDER BY id";
  const { results } = await db.prepare(sql).all();
  return results.map(rowToItem);
}
export async function getItemRow(db, id) {
  return db.prepare("SELECT * FROM items WHERE id = ?").bind(id).first();
}
/** Insert a new item (tallies start at zero). Returns false if the id already exists. */
export async function insertItem(db, item) {
  const d = itemData(item);
  const r = await db.prepare("INSERT INTO items (id, data, hidden, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING")
    .bind(d.id, d.data, d.hidden, new Date().toISOString()).run();
  return (r.meta?.changes ?? 0) > 0;
}
/** Insert or replace an item's content, keeping its vote tallies. */
export async function upsertItem(db, item) {
  const d = itemData(item);
  await db.prepare(`INSERT INTO items (id, data, hidden, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET data = excluded.data, hidden = excluded.hidden, updated_at = excluded.updated_at`)
    .bind(d.id, d.data, d.hidden, new Date().toISOString()).run();
}
export async function deleteItem(db, id) {
  await db.batch([
    db.prepare("DELETE FROM votes WHERE item_id = ?").bind(id),
    db.prepare("DELETE FROM items WHERE id = ?").bind(id)
  ]);
}
