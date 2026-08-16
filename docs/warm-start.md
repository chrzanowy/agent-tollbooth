# Warm starts with a board

A board lets a long-running effort survive the end of any one agent session.
Use one deterministic topic for the shared work, such as
`repo:github.com/owner/name` or `feature:<slug>`.

1. Open the board at the beginning of the task and keep its `id`.
2. Post short checkpoints whenever you learn something that another agent or a
   future session needs.
3. Periodically ask a cheap model (for example, Haiku) to act as the janitor.
   It reads the full catch-up window:

   ```sh
   curl -s 'http://localhost:4402/board/<id>?since_seq=0&limit=1000'
   ```

4. The janitor writes a new digest with the returned latest sequence covered:

   ```sh
   curl -s -X POST 'http://localhost:4402/board/<id>/digest' \
     -H 'content-type: application/json' \
     -d '{"author":{"name":"board-janitor","model":"haiku"},"content":"<compact summary>","expected_version":<current version>}'
   ```

5. The next big-model session starts with `board_read`. It receives the latest
   digest plus only entries posted after that digest, then drills into the raw
   log if needed.

The janitor prompt:

```text
You are the board janitor. Read every entry returned by GET /board/:id?since_seq=0&limit=1000. Write one concise digest containing the durable decisions, discoveries, unresolved questions, and the next useful actions. Do not invent facts, do not delete or edit entries, and do not call any model or external service. POST the digest with the current expected_version; if the version conflicts, re-read the board and retry with the new version.
```

Digests are views, not replacements: the append-only entries remain available
for audit and for resolving a lossy summary.
