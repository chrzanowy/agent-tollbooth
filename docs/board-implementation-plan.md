# Implementation plan: `board` — the fifth tollbooth primitive

**Audience:** an implementing agent with access to this repository and no other
context. Read this whole document, then read the existing source, then build.

## 1. What you are building and why

`board` is a **concurrent-safe, append-only shared log with versioned digests** —
a blackboard where AI agents coordinate without sharing a process, machine,
vendor, or even a lifetime. Three use cases, all served by one design:

1. **Subagent coordination** — parallel workers post discoveries mid-task instead
   of each re-exploring; an orchestrator's understanding survives its session.
2. **Independently launched agents** — agents started separately (different
   harnesses/vendors/machines/times) rendezvous on a *named* board and cooperate
   through it. No parent process exists, so boards must be discoverable by name.
3. **Warm restarts** — an agent checkpoints findings continuously; a cheap model
   periodically compacts the log into a digest; any later session resumes from
   the digest instead of re-reading a long transcript.

Two non-negotiable principles:

- **tollbooth never calls a model.** Digests are written *by agents* through the
  API. Do not add summarization, embeddings, or any LLM/API-key logic.
- **Entries are immutable and never silently dropped.** A digest is a *view*;
  the raw log stays readable so agents can drill past a lossy summary.

## 2. Repository conventions you must follow

Read these files first; new code must look like they do:

- `src/db.ts` — SQLite via **`node:sqlite`** (`DatabaseSync`). Add tables here.
  No new dependencies of any kind (runtime or dev).
- `src/primitives/memory.ts` and `watch.ts` — the shape of a primitive module:
  plain exported functions, typed rows, `as unknown as X[]` casts on `.all()`.
- `src/catalog.ts` — every callable tool has a catalogue entry (`name`,
  `description`, `price_usd` via the `cloudPrices` map, `expected_latency_ms`,
  `requires`). Add board entries here.
- `src/receipts.ts` — every HTTP/MCP response wraps results with `withReceipt`.
- `src/index.ts` — Express routes use the local `handle(tool, fn)` helper:
  validation errors become HTTP 400 with `{error, tool}`.
- `src/mcp.ts` — MCP tools registered with `server.registerTool(name,
  {description, inputSchema: <zod raw shape>}, handler)`; results serialized
  through the local `asText` helper; descriptions come from the catalogue via
  `describe()`.
- TypeScript strict, ESM (`.js` suffixes on relative imports), 2-space indent.
  `npm run typecheck` must pass with zero errors.

## 3. Data model

Add to `src/db.ts`:

```sql
CREATE TABLE IF NOT EXISTS boards (
  id INTEGER PRIMARY KEY,
  topic TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS board_entries (
  id INTEGER PRIMARY KEY,
  board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,            -- per-board, starts at 1, no gaps
  author TEXT NOT NULL,            -- JSON: {"name": string, "model"?: string, "harness"?: string}
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(board_id, seq)
);

CREATE TABLE IF NOT EXISTS board_digests (
  id INTEGER PRIMARY KEY,
  board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,        -- per-board, starts at 1
  covers_seq INTEGER NOT NULL,     -- highest entry seq summarized by this digest
  author TEXT NOT NULL,            -- same JSON shape as entries
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(board_id, version)
);
CREATE INDEX IF NOT EXISTS idx_board_entries ON board_entries(board_id, seq);
```

**Sequence assignment:** compute `seq = COALESCE(MAX(seq),0)+1` and insert
inside a single SQLite transaction (`db.exec("BEGIN IMMEDIATE") … COMMIT`, with
ROLLBACK on error). `node:sqlite` is synchronous and the server is a single
process, so this is race-free; the transaction still guards multi-statement
atomicity.

## 4. Module: `src/primitives/board.ts`

Exported surface (shapes indicative — adapt to house style):

```ts
interface Author { name: string; model?: string; harness?: string }
interface Board { id: number; topic: string; created_at: string }
interface Entry { seq: number; author: Author; content: string; created_at: string }
interface Digest { version: number; covers_seq: number; author: Author; content: string; created_at: string }

open(topic: string): Board & { latest_seq: number; digest_version: number | null }
  // get-or-create by exact topic (trimmed). Topic 1–512 chars.

listBoards(query?: string): Array<Board & { latest_seq: number }>
  // LIKE match on topic when query given; newest first; limit 100.

post(boardId: number, author: Author, content: string): { seq: number }
  // content 1–65_536 chars; author.name required (1–200 chars).
  // Throws if board does not exist.

read(boardId: number, sinceSeq?: number, limit = 200): {
  board: Board;
  digest: Digest | null;              // latest version only
  entries: Entry[];                    // seq ascending
  latest_seq: number;
  next_seq: number;                    // cursor the caller should pass next time
}
  // Default window: entries AFTER max(sinceSeq ?? digest.covers_seq ?? 0).
  // This is the catch-up read: digest + everything the digest doesn't cover.
  // limit capped at 1000. next_seq = seq of last returned entry, or the
  // effective cursor when no entries returned.

writeDigest(boardId: number, author: Author, content: string, expectedVersion: number): Digest
  // Optimistic lock: expectedVersion must equal current latest version
  // (0 when no digest exists yet). On mismatch throw DigestConflictError
  // carrying the current version — HTTP layer maps it to 409 so the caller
  // can re-read and retry. covers_seq = latest entry seq at write time.
  // content 1–262_144 chars. Old versions are kept (history).

listDigests(boardId: number): Digest[]        // all versions, newest first
removeBoard(boardId: number): boolean          // deletes board + entries + digests
```

Edge cases that must behave exactly as stated:

- `open` on an existing topic returns the same board id — this is the
  rendezvous guarantee for independently launched agents. Concurrent opens of
  the same new topic must not create duplicates (UNIQUE + `INSERT OR IGNORE`
  then SELECT).
- `read` with `sinceSeq` beyond `latest_seq` returns empty `entries`, not an error.
- `writeDigest` with `expectedVersion` stale → 409 (`DigestConflictError`),
  never a silent overwrite; response body includes the current version.
- A digest may cover zero entries (planning note before any posts) — allowed.
- Author is validated (name required, unknown fields rejected by schema at the
  edges, stored as canonical JSON).

## 5. HTTP routes (`src/index.ts`)

All wrapped in `handle(tool, fn)` like existing routes; tool names below map to
catalogue entries (§7):

| Route | Tool | Body / query |
|---|---|---|
| `POST /board/open` | `board.open` | `{topic}` |
| `GET /board?query=` | `board.open` | list boards |
| `POST /board/:id/post` | `board.post` | `{author, content}` |
| `GET /board/:id?since_seq=&limit=` | `board.read` | catch-up read |
| `POST /board/:id/digest` | `board.digest` | `{author, content, expected_version}` |
| `GET /board/:id/digests` | `board.read` | digest history |
| `DELETE /board/:id` | `board.open` | remove board |

`DigestConflictError` → HTTP **409** with `{error, tool, current_version}`.
Extend `handle` minimally (status selection) without changing existing behavior.

## 6. MCP tools (`src/mcp.ts`)

Register five tools mirroring the module; zod raw shapes; descriptions pulled
from the catalogue via the existing `describe()`:

- `board_open` — `{topic: string}`. Description must state the rendezvous
  convention: *"agents working the same repo/feature should derive the topic
  deterministically, e.g. `repo:github.com/owner/name` or `feature:<slug>`"*.
- `board_list` — `{query?: string}`
- `board_post` — `{board_id: number, author: {name, model?, harness?}, content: string}`
- `board_read` — `{board_id: number, since_seq?: number, limit?: number}`
- `board_digest` — `{board_id: number, author, content: string, expected_version: number}`

## 7. Catalogue (`src/catalog.ts`)

Add entries (cloud prices in the `cloudPrices` map; local tier stays $0):

| name | cloud price | expected_latency_ms | requires |
|---|---|---|---|
| `board.open` | 0.001 | 10 | "a rendezvous point agents can find without a shared parent" |
| `board.post` | 0.002 | 10 | "a concurrency-safe log that outlives every participant" |
| `board.read` | 0.002 | 10 | "catching up on what other agents learned while you did not exist" |
| `board.digest` | 0.005 | 15 | "a compacted view cheap models write and expensive models resume from" |

Descriptions in the catalogue should be one sentence each, written for an agent
deciding whether the call is worth making (see existing entries for register).

## 8. Bench scenarios (`scripts/bench.ts`)

Add scenarios in the existing `scenario(tool, name, fn)` style. All semantic
checks, not just status codes:

1. **rendezvous** — `POST /board/open` twice with the same topic → identical
   `id`; different topic → different id.
2. **concurrent posts** — fire 10 `board_post` calls with `Promise.all` from
   two distinct authors → all succeed; collected seqs are exactly 1..10 with no
   duplicates and no gaps (fetch via read and verify).
3. **cursor read** — `read` with `since_seq=7` returns only seqs 8..10;
   `since_seq=latest` returns empty entries; `next_seq` is correct in both.
4. **digest + optimistic lock** — write digest with `expected_version: 0` →
   version 1, `covers_seq` = 10; second write again with `expected_version: 0`
   → HTTP 409 including `current_version: 1`; write with `expected_version: 1`
   → version 2. Digest history lists both.
5. **catch-up semantics** — post 2 more entries after the digest; a `read`
   with no `since_seq` returns the latest digest **and only** the 2 entries
   past `covers_seq`.
6. **cleanup** — delete the bench boards at the end (as existing scenarios do).

The full bench must exit 0: existing 5 scenarios + new ones, all green, against
`npm run dev` locally (`TOLLBOOTH_URL=http://localhost:<port>` and
`BENCH_CALLBACK_HOST=localhost` when the server is not in Docker).

## 9. Documentation

- **README.md** — add `board` to the primitives table (one row: "a shared,
  append-only log + digest where independently launched agents coordinate")
  and a short curl section following the style of the existing ones: open →
  post → read → digest, four commands. Add one sentence to the intro: the
  four-things list becomes five.
- **`.claude/skills/tollbooth/SKILL.md`** — add a `## board` section teaching
  *when*: post when you learn something teammates or future sessions need;
  read (catch-up) before starting work on a shared topic; digest when the log
  gets long — and *when not*: not a chat channel, not for content already in
  memory/repo. Include the deterministic-topic convention and one curl example
  per operation. Update the frontmatter `description` triggers with: "working
  as part of a multi-agent team", "share findings with other agents", "resume
  a long-running effort".
- **`docs/warm-start.md`** (new, ~40 lines) — the recipe: agent checkpoints to
  a board while working; a cheap model (e.g. Haiku) reads
  `GET /board/:id?since_seq=0&limit=1000`, writes `POST /board/:id/digest`;
  the next big-model session starts with `board_read`. Include the janitor
  prompt verbatim as a copyable block.

## 10. Out of scope — do not build

Claims/leases, webhooks/push notification, per-agent authentication, threads,
reactions, entry editing/deletion, board archival/TTL, pagination beyond
`since_seq`/`limit`, any model invocation. If something seems missing, note it
in the PR/commit message rather than building it.

## 11. Acceptance checklist

- [ ] `npm run typecheck` clean
- [ ] `npm run bench` exits 0 with all scenarios green (old and new)
- [ ] `open` is idempotent per topic; concurrent posts yield gapless unique seqs
- [ ] Stale `expected_version` → 409 with `current_version`; no overwrite
- [ ] Default read = latest digest + entries past `covers_seq` only
- [ ] Entries immutable; digest history preserved across versions
- [ ] Catalogue lists 4 new board tools; `/.well-known/tollbooth.json` shows them
- [ ] MCP `tools/list` shows 12 tools; `board_post`→`board_read` roundtrip works over MCP
- [ ] README, SKILL.md, docs/warm-start.md updated as specified
- [ ] No new dependencies; no model calls; existing tests/behavior unchanged
