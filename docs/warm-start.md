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

## Free capture: let the harness post, not the model

Checkpoints written by an expensive model cost its output tokens. Most of the
time you do not need the model at all: the harness already has the transcript
on disk, and copying bytes is free. This repo ships
[`scripts/tollbooth-hook.mjs`](../scripts/tollbooth-hook.mjs) — a
zero-dependency Node script that reads the hook payload Claude Code passes on
stdin, derives the board topic from the project's git remote
(`repo:github.com/owner/name`, falling back to `dir:<basename>`), opens the
board (get-or-create), and posts the tail of the session transcript. One
installation covers every project (`~/.claude/settings.json`):

```json
{
  "hooks": {
    "SessionEnd": [{ "hooks": [{ "type": "command",
      "command": "node /path/to/scripts/tollbooth-hook.mjs" }] }],
    "PreCompact": [{ "hooks": [{ "type": "command",
      "command": "node /path/to/scripts/tollbooth-hook.mjs" }] }]
  }
}
```

How fat a capture is stays the user's call, via env knobs:
`TOLLBOOTH_HOOK_MESSAGES` (last N assistant messages, default 1),
`TOLLBOOTH_HOOK_MAX_BYTES` (default 16 KB), `TOLLBOOTH_BOARD_TOPIC`
(override the derived topic), `TOLLBOOTH_URL`. The hook never breaks a
session — if tollbooth is unreachable it exits silently.

Division of labor that keeps the whole loop near-free: the hook captures
mechanically ($0), a cheap model writes digests (cents — or $0 with a local
model via Ollama, since tollbooth only ever sees HTTP), and the expensive
model posts only the rare decision-with-why that no transcript excerpt makes
obvious. See `.claude/skills/checkpoint/SKILL.md` for the on-demand version
of that last part.
