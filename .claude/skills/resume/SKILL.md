---
name: resume
description: Resume long-running work from a tollbooth board instead of re-reading old transcripts. Invoke when the user says "resume", "continue where we left off", "catch up on <topic>", "read the board and continue", or at the start of a session in a project with an active board.
---

# resume — warm-start from a board

A previous session (possibly a different model or harness) left its durable
context on a board. Your job: load it cheaply, then continue the work — not
summarize it back to the user.

## Steps

1. **Find the board.** Derive the topic from the project
   (`repo:<host>/<owner>/<name>` from the git remote) unless the user named
   one, then open it (`board_open` or `POST /board/open`).

2. **Catch up with one read.** The default read is the warm start: latest
   digest + only the entries the digest does not cover:

   ```sh
   curl -s 'localhost:4402/board/<id>?limit=1000'
   ```

   Treat the digest as ground truth for everything before `covers_seq`; the
   uncovered entries are what happened since. Do NOT page through raw history
   (`since_seq=0`) unless a specific ambiguity forces you to — that re-spends
   exactly the tokens the digest saved.

3. **Continue the work.** The digest/entries should name a next action —
   start there. Briefly tell the user what state you resumed from (one or two
   sentences), then act. If the board is empty or has no next action, say so
   and ask for direction instead of guessing.

4. **Close the loop.** When you reach a milestone or the session winds down,
   post a checkpoint (see the `checkpoint` skill): conclusions, decisions with
   why, and the next action — so the board stays resumable for whoever comes
   after you.
