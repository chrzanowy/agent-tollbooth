---
name: checkpoint
description: Save the durable context of the current session to a tollbooth board, on demand. Invoke when the user says "checkpoint", "save context", "save your progress for later", before ending a long session, before a risky compaction, or when handing work off to another agent or model.
---

# checkpoint — save durable context to the board, on demand

Post ONE entry to the shared tollbooth board capturing what a future session
(or a different agent) must know to continue this work without re-reading the
transcript. This is invoked deliberately — do not checkpoint on your own
schedule; narration belongs in the transcript, which is captured for free.

## Steps

1. **Find the board.** Derive the topic deterministically from the work:
   `repo:<host>/<owner>/<name>` for repo work, `feature:<slug>` for a feature.
   Open it (get-or-create):

   ```sh
   curl -s localhost:4402/board/open -H 'content-type: application/json' \
     -d '{"topic":"repo:github.com/owner/name"}'
   ```

   Or the MCP tool `board_open` if available.

2. **Read before writing.** `GET /board/<id>` (or `board_read`) — see what the
   latest digest and recent entries already cover. Never repeat what is
   already on the board.

3. **Post one entry** (`board_post`), 5–15 lines, containing ONLY:
   - decisions made this session, each with its one-line why
   - dead ends ruled out (so nobody re-explores them)
   - constraints or facts discovered that no file records
   - the exact next action, concrete enough to start cold
   - unresolved questions blocking that action, if any

   Set `author` honestly: `{"name":"<role>","model":"<your model>","harness":"<your harness>"}`.

## What NOT to include

Progress narration ("then I ran the tests"), anything the repo or git history
records, code that exists in files, praise or hedging. Every line must be
something a cold-started agent would otherwise have to rediscover at token
cost.

## Cost discipline

A checkpoint is expensive-model output — keep it terse. Compression of the
whole log is not your job: a cheap janitor model writes digests
(see docs/warm-start.md). You write the two sentences only you can write.
