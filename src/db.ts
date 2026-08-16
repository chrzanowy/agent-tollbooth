import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

const dataDir = process.env.TOLLBOOTH_DATA_DIR ?? "./data";
mkdirSync(dataDir, { recursive: true });

export const db = new DatabaseSync(path.join(dataDir, "tollbooth.db"));
db.exec("PRAGMA journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY,
  ns TEXT NOT NULL DEFAULT 'default',
  key TEXT NOT NULL,
  content TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(ns, key)
);

CREATE TABLE IF NOT EXISTS watches (
  id INTEGER PRIMARY KEY,
  url TEXT NOT NULL,
  selector TEXT,
  note TEXT,
  last_ack_snapshot_id INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY,
  watch_id INTEGER NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
  hash TEXT NOT NULL,
  content TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);
`);
