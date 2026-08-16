import { db } from "../db.js";

export interface Memory {
  ns: string;
  key: string;
  content: string;
  tags: string[];
  created_at: string;
  updated_at: string;
}

interface MemoryRow {
  ns: string;
  key: string;
  content: string;
  tags: string;
  created_at: string;
  updated_at: string;
}

function rowToMemory(r: MemoryRow): Memory {
  return { ...r, tags: JSON.parse(r.tags) as string[] };
}

export function store(
  key: string,
  content: string,
  ns = "default",
  tags: string[] = [],
): Memory {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO memories (ns, key, content, tags, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(ns, key) DO UPDATE SET
       content = excluded.content,
       tags = excluded.tags,
       updated_at = excluded.updated_at`,
  ).run(ns, key, content, JSON.stringify(tags), now, now);
  return get(key, ns)!;
}

export function get(key: string, ns = "default"): Memory | null {
  const row = db
    .prepare(`SELECT * FROM memories WHERE ns = ? AND key = ?`)
    .get(ns, key) as MemoryRow | undefined;
  return row ? rowToMemory(row) : null;
}

export function search(query: string, ns?: string, limit = 20): Memory[] {
  const like = `%${query}%`;
  const rows = (
    ns
      ? db
          .prepare(
            `SELECT * FROM memories WHERE ns = ? AND (key LIKE ? OR content LIKE ? OR tags LIKE ?)
             ORDER BY updated_at DESC LIMIT ?`,
          )
          .all(ns, like, like, like, limit)
      : db
          .prepare(
            `SELECT * FROM memories WHERE key LIKE ? OR content LIKE ? OR tags LIKE ?
             ORDER BY updated_at DESC LIMIT ?`,
          )
          .all(like, like, like, limit)
  ) as unknown as MemoryRow[];
  return rows.map(rowToMemory);
}

export function forget(key: string, ns = "default"): boolean {
  const res = db.prepare(`DELETE FROM memories WHERE ns = ? AND key = ?`).run(ns, key);
  return res.changes > 0;
}
