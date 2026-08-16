import { db } from "../db.js";

export interface Author {
  name: string;
  model?: string;
  harness?: string;
}

export interface Board {
  id: number;
  topic: string;
  created_at: string;
}

export interface Entry {
  seq: number;
  author: Author;
  content: string;
  created_at: string;
}

export interface Digest {
  version: number;
  covers_seq: number;
  author: Author;
  content: string;
  created_at: string;
}

interface BoardRow {
  id: number;
  topic: string;
  created_at: string;
  latest_seq?: number;
  digest_version?: number | null;
}

interface EntryRow {
  seq: number;
  author: string;
  content: string;
  created_at: string;
}

interface DigestRow {
  version: number;
  covers_seq: number;
  author: string;
  content: string;
  created_at: string;
}

export class DigestConflictError extends Error {
  readonly currentVersion: number;

  constructor(currentVersion: number) {
    super(`digest version conflict: current version is ${currentVersion}`);
    this.name = "DigestConflictError";
    this.currentVersion = currentVersion;
  }
}

function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function canonicalAuthor(value: Author): { value: Author; json: string } {
  assertObject(value, "author");
  const allowed = new Set(["name", "model", "harness"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error("author contains unknown fields");
  }

  const name = value.name;
  if (typeof name !== "string" || name.length < 1 || name.length > 200) {
    throw new Error("author.name must be a string of 1-200 characters");
  }

  const author: Author = { name };
  for (const key of ["model", "harness"] as const) {
    const field = value[key];
    if (field !== undefined) {
      if (typeof field !== "string") throw new Error(`author.${key} must be a string`);
      author[key] = field;
    }
  }
  return { value: author, json: JSON.stringify(author) };
}

function assertContent(content: string, max: number): void {
  if (typeof content !== "string" || content.length < 1 || content.length > max) {
    throw new Error(`content must be a string of 1-${max} characters`);
  }
}

function assertBoardId(boardId: number): void {
  if (!Number.isInteger(boardId) || boardId < 1) throw new Error("board_id must be a positive integer");
}

function rowToBoard(row: BoardRow): Board {
  return { id: Number(row.id), topic: row.topic, created_at: row.created_at };
}

function rowToEntry(row: EntryRow): Entry {
  return {
    seq: Number(row.seq),
    author: JSON.parse(row.author) as Author,
    content: row.content,
    created_at: row.created_at,
  };
}

function rowToDigest(row: DigestRow): Digest {
  return {
    version: Number(row.version),
    covers_seq: Number(row.covers_seq),
    author: JSON.parse(row.author) as Author,
    content: row.content,
    created_at: row.created_at,
  };
}

function getBoard(boardId: number): Board | null {
  const row = db.prepare(`SELECT id, topic, created_at FROM boards WHERE id = ?`).get(boardId) as
    | BoardRow
    | undefined;
  return row ? rowToBoard(row) : null;
}

function requireBoard(boardId: number): Board {
  assertBoardId(boardId);
  const board = getBoard(boardId);
  if (!board) throw new Error(`board ${boardId} not found`);
  return board;
}

export function open(topic: string): Board & { latest_seq: number; digest_version: number | null } {
  if (typeof topic !== "string") throw new Error("topic (string) is required");
  const normalizedTopic = topic.trim();
  if (normalizedTopic.length < 1 || normalizedTopic.length > 512) {
    throw new Error("topic must be a string of 1-512 characters");
  }

  db.prepare(`INSERT OR IGNORE INTO boards (topic, created_at) VALUES (?, ?)`).run(
    normalizedTopic,
    new Date().toISOString(),
  );
  const row = db
    .prepare(
      `SELECT b.id, b.topic, b.created_at,
              COALESCE((SELECT MAX(e.seq) FROM board_entries e WHERE e.board_id = b.id), 0) AS latest_seq,
              (SELECT MAX(d.version) FROM board_digests d WHERE d.board_id = b.id) AS digest_version
       FROM boards b WHERE b.topic = ?`,
    )
    .get(normalizedTopic) as unknown as BoardRow;
  return {
    ...rowToBoard(row),
    latest_seq: Number(row.latest_seq ?? 0),
    digest_version: row.digest_version === null || row.digest_version === undefined ? null : Number(row.digest_version),
  };
}

export function listBoards(query?: string): Array<Board & { latest_seq: number }> {
  if (query !== undefined && typeof query !== "string") throw new Error("query must be a string");
  const like = query === undefined ? undefined : `%${query}%`;
  const rows = (
    like === undefined
      ? db
          .prepare(
            `SELECT b.id, b.topic, b.created_at,
                    COALESCE((SELECT MAX(e.seq) FROM board_entries e WHERE e.board_id = b.id), 0) AS latest_seq
             FROM boards b ORDER BY b.created_at DESC, b.id DESC LIMIT 100`,
          )
          .all()
      : db
          .prepare(
            `SELECT b.id, b.topic, b.created_at,
                    COALESCE((SELECT MAX(e.seq) FROM board_entries e WHERE e.board_id = b.id), 0) AS latest_seq
             FROM boards b WHERE b.topic LIKE ?
             ORDER BY b.created_at DESC, b.id DESC LIMIT 100`,
          )
          .all(like)
  ) as unknown as BoardRow[];
  return rows.map((row) => ({ ...rowToBoard(row), latest_seq: Number(row.latest_seq ?? 0) }));
}

export function post(boardId: number, author: Author, content: string): { seq: number } {
  const canonical = canonicalAuthor(author);
  assertContent(content, 65_536);
  assertBoardId(boardId);

  db.exec("BEGIN IMMEDIATE");
  try {
    requireBoard(boardId);
    const row = db
      .prepare(`SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM board_entries WHERE board_id = ?`)
      .get(boardId) as { next_seq: number };
    const seq = Number(row.next_seq);
    db.prepare(
      `INSERT INTO board_entries (board_id, seq, author, content, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(boardId, seq, canonical.json, content, new Date().toISOString());
    db.exec("COMMIT");
    return { seq };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function read(
  boardId: number,
  sinceSeq?: number,
  limit = 200,
): {
  board: Board;
  digest: Digest | null;
  entries: Entry[];
  latest_seq: number;
  next_seq: number;
} {
  const board = requireBoard(boardId);
  if (sinceSeq !== undefined && (!Number.isInteger(sinceSeq) || sinceSeq < 0)) {
    throw new Error("since_seq must be a non-negative integer");
  }
  if (!Number.isInteger(limit) || limit < 1) throw new Error("limit must be a positive integer");
  const cappedLimit = Math.min(limit, 1000);

  const digestRow = db
    .prepare(
      `SELECT version, covers_seq, author, content, created_at
       FROM board_digests WHERE board_id = ? ORDER BY version DESC LIMIT 1`,
    )
    .get(boardId) as DigestRow | undefined;
  const digest = digestRow ? rowToDigest(digestRow) : null;
  const latestRow = db
    .prepare(`SELECT COALESCE(MAX(seq), 0) AS latest_seq FROM board_entries WHERE board_id = ?`)
    .get(boardId) as { latest_seq: number };
  const latestSeq = Number(latestRow.latest_seq);
  const effectiveCursor = sinceSeq ?? digest?.covers_seq ?? 0;
  const rows = db
    .prepare(
      `SELECT seq, author, content, created_at
       FROM board_entries WHERE board_id = ? AND seq > ?
       ORDER BY seq ASC LIMIT ?`,
    )
    .all(boardId, effectiveCursor, cappedLimit) as unknown as EntryRow[];
  const entries = rows.map(rowToEntry);
  return {
    board,
    digest,
    entries,
    latest_seq: latestSeq,
    next_seq: entries.length ? entries[entries.length - 1].seq : effectiveCursor,
  };
}

export function writeDigest(
  boardId: number,
  author: Author,
  content: string,
  expectedVersion: number,
): Digest {
  const canonical = canonicalAuthor(author);
  assertContent(content, 262_144);
  assertBoardId(boardId);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
    throw new Error("expected_version must be a non-negative integer");
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    requireBoard(boardId);
    const currentRow = db
      .prepare(`SELECT COALESCE(MAX(version), 0) AS version FROM board_digests WHERE board_id = ?`)
      .get(boardId) as { version: number };
    const currentVersion = Number(currentRow.version);
    if (expectedVersion !== currentVersion) throw new DigestConflictError(currentVersion);

    const latestRow = db
      .prepare(`SELECT COALESCE(MAX(seq), 0) AS latest_seq FROM board_entries WHERE board_id = ?`)
      .get(boardId) as { latest_seq: number };
    const createdAt = new Date().toISOString();
    db.prepare(
      `INSERT INTO board_digests (board_id, version, covers_seq, author, content, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(boardId, currentVersion + 1, Number(latestRow.latest_seq), canonical.json, content, createdAt);
    db.exec("COMMIT");
    return {
      version: currentVersion + 1,
      covers_seq: Number(latestRow.latest_seq),
      author: canonical.value,
      content,
      created_at: createdAt,
    };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function listDigests(boardId: number): Digest[] {
  requireBoard(boardId);
  const rows = db
    .prepare(
      `SELECT version, covers_seq, author, content, created_at
       FROM board_digests WHERE board_id = ? ORDER BY version DESC`,
    )
    .all(boardId) as unknown as DigestRow[];
  return rows.map(rowToDigest);
}

export function removeBoard(boardId: number): boolean {
  assertBoardId(boardId);
  db.exec("BEGIN IMMEDIATE");
  try {
    const exists = getBoard(boardId) !== null;
    if (!exists) {
      db.exec("COMMIT");
      return false;
    }
    db.prepare(`DELETE FROM boards WHERE id = ?`).run(boardId);
    db.exec("COMMIT");
    return true;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
