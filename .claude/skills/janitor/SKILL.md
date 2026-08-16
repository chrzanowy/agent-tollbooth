---
name: janitor
description: Compact a tollbooth board into a fresh digest. Invoke when the user says "run the janitor", "compact the board", "digest the board", or "clean up board <topic>". Designed to be run by a cheap model (e.g. Haiku) — the whole point is that compaction does not cost expensive-model tokens.
---

# janitor — compact a board into a versioned digest

You compress a board's log into a digest that a future (expensive) session can
resume from instead of re-reading everything. You never delete or edit entries
— a digest is a view, the raw log stays.

## Steps

1. **Find the board.** If the user named a topic or id, use it. Otherwise
   derive the project prefix from the git remote and list its contexts:

   ```sh
   curl -s 'localhost:4402/board?query=repo:<host>/<owner>/<name>'
   ```

   If several boards match (project inbox plus `ctx:<slug>` workstreams), ask
   which to compact, showing each board's `description` and `latest_seq` —
   digests are per-board, so each workstream is compacted on its own. Then
   open the chosen one:

   ```sh
   curl -s localhost:4402/board/open -H 'content-type: application/json' \
     -d '{"topic":"repo:github.com/owner/name"}'
   ```

   (or MCP `board_open`). Note the returned `digest_version` — you will need
   it as `expected_version`.

2. **Read incrementally.** The default read returns the latest digest plus
   only the entries it does not cover:

   ```sh
   curl -s 'localhost:4402/board/<id>?limit=1000'
   ```

   If there are no uncovered entries, say so and stop — do not write a
   digest that adds nothing.

3. **Write the new digest** by merging the previous digest with the new
   entries. Keep only: durable decisions with their why, discoveries,
   constraints, unresolved questions, and the next useful actions. Drop
   narration, greetings, duplicates, and anything superseded. Do not invent
   facts. Target: the digest should be a fraction of the raw log's size while
   losing nothing a resuming agent would need.

   ```sh
   curl -s localhost:4402/board/<id>/digest -H 'content-type: application/json' \
     -d '{"author":{"name":"janitor","model":"<your model>"},"content":"<the digest>","expected_version":<digest_version from step 1, 0 if null>}'
   ```

4. **On HTTP 409** (someone digested concurrently): re-read the board, merge
   again on top of the now-current digest, and retry once with the
   `current_version` from the error body.

5. **Report** the new version, `covers_seq`, and the rough compression ratio
   (entry characters in vs digest characters out).
