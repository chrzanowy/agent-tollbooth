---
name: tollbooth
description: Use when a task needs state that outlives this session — remembering facts for future sessions, recalling what past sessions learned, checking whether a webpage changed since it was last seen, reading JS-rendered pages that plain fetch returns empty, running code when no sandbox is available, working as part of a multi-agent team, sharing findings with other agents, or resuming a long-running effort. Triggers on "remember this", "what did we decide", "has X changed", "track/monitor this page", "working as part of a multi-agent team", "share findings with other agents", "resume a long-running effort", session start in a project with stored context, and fetch results that look like an empty JS shell.
---

# tollbooth — state that survives your session

tollbooth is a local service (default `http://localhost:4402`) holding state that
outlives you: memories, page snapshots, a browser, a code runner, and shared
boards. If its MCP tools (`memory_store`, `memory_recall`, `watch_add`,
`watch_check`, `watch_list`, `render_extract`, `execute_run`, `board_open`,
`board_list`, `board_post`, `board_read`, `board_digest`) are available, use them;
otherwise every example below is a plain HTTP call you can make with curl.

Every response includes a `receipt` (tool, price, latency). On a local instance
prices are $0 — receipts exist so spend is auditable when a hosted tier is used.

## memory — facts for your future self

**At the start of substantive work in a project, recall before you explore:**

```sh
curl -s 'localhost:4402/memory?q=<topic>'          # full-text search
curl -s 'localhost:4402/memory?key=<exact-key>'    # exact key
```

**Store when you learn something durable that the repo itself does not record** —
a user preference, an environment quirk ("staging DB is readonly on weekends"),
a decision and its why, a hard-won debugging conclusion:

```sh
curl -s localhost:4402/memory -H 'content-type: application/json' \
  -d '{"key":"short-kebab-slug","content":"the fact, with why it matters","tags":["topic"]}'
```

Do not store what code, git history, or docs already record — memory is for what
would otherwise be lost when the session ends. Overwriting the same key updates it;
`DELETE /memory/<key>` removes facts that turned out wrong. Use `ns` to partition
unrelated projects.

## watch — "did it change since I last looked?"

Use when the user wants a page tracked over time, or when your task depends on
whether something changed between sessions (pricing pages, changelogs, docs,
statuses). One agent baselines it once:

```sh
curl -s localhost:4402/watch -H 'content-type: application/json' \
  -d '{"url":"https://example.com/pricing","note":"why this is watched"}'
```

Any later session asks — the answer is a unified diff since the last check:

```sh
curl -s -X POST localhost:4402/watch/<id>/check
```

Not for one-off reads (just fetch the page) — a watch is only worth creating when
some future session will ask what changed.

## render — pages that need a real browser

Use when a plain fetch of a page returns a near-empty HTML shell, a "enable
JavaScript" notice, or visibly less content than the browser shows — typical for
SPAs and dashboards. Try plain fetch first; render costs more (~0.5–4s).

```sh
curl -s localhost:4402/render -H 'content-type: application/json' \
  -d '{"url":"https://spa.example.com","format":"text"}'
```

`format: "html"` returns the rendered DOM; `wait_ms` waits for late-loading content.

## execute — run code when you have no sandbox

Use when your harness provides no code execution, or you need a clean isolated
run (the tollbooth container is the sandbox). Supported: `python`, `node`, `bash`.

```sh
curl -s localhost:4402/execute -H 'content-type: application/json' \
  -d '{"language":"python","code":"print(6*7)","timeout_ms":10000}'
```

Returns `exit_code`, `stdout`, `stderr`, `timed_out`. If your harness already has
a sandbox, prefer it — execute is the fallback rod, not the default.

## board — shared coordination across agents and sessions

Use a board when several agents or future sessions need the same durable
checkpoint. Agents working the same repo or feature should derive the topic
deterministically, for example `repo:github.com/owner/name` or `feature:<slug>`.

When to use it:

- **Post** when you learn something teammates or future sessions need.
- **Read** the catch-up view before starting work on a shared topic.
- **Digest** when the log gets long; an agent writes the compact view and later
  agents resume from it.

When not to use it: it is not a chat channel, and it is not for content already
in memory or the repository. Keep entries focused and immutable.

Open or rendezvous with a board:

```sh
curl -s localhost:4402/board/open -H 'content-type: application/json' \
  -d '{"topic":"repo:github.com/owner/name"}'
```

Post a finding:

```sh
curl -s localhost:4402/board/<id>/post -H 'content-type: application/json' \
  -d '{"author":{"name":"agent-a"},"content":"The migration is safe to run twice."}'
```

Read the digest and entries not covered by it:

```sh
curl -s 'localhost:4402/board/<id>?limit=200'
```

Write a digest after reviewing the log:

```sh
curl -s localhost:4402/board/<id>/digest -H 'content-type: application/json' \
  -d '{"author":{"name":"janitor"},"content":"Migration is idempotent and verified in staging.","expected_version":0}'
```

## Discovery

`GET /.well-known/tollbooth.json` lists every tool with price and expected
latency — consult it if unsure what this instance offers or costs.
