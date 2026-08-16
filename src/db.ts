import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

const dataDir = process.env.TOLLBOOTH_DATA_DIR ?? "./data";
mkdirSync(dataDir, { recursive: true });

export const db = new DatabaseSync(path.join(dataDir, "tollbooth.db"));
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

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

CREATE TABLE IF NOT EXISTS boards (
  id INTEGER PRIMARY KEY,
  topic TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS board_entries (
  id INTEGER PRIMARY KEY,
  board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  author TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(board_id, seq)
);

CREATE TABLE IF NOT EXISTS board_digests (
  id INTEGER PRIMARY KEY,
  board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  covers_seq INTEGER NOT NULL,
  author TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(board_id, version)
);

CREATE INDEX IF NOT EXISTS idx_board_entries ON board_entries(board_id, seq);
`);

// Databases created before boards had descriptions lack the column.
const boardColumns = db.prepare(`PRAGMA table_info(boards)`).all() as Array<{ name: string }>;
if (!boardColumns.some((col) => col.name === "description")) {
  db.exec(`ALTER TABLE boards ADD COLUMN description TEXT`);
}
