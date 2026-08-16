# tollbooth

**The stateful backend for AI agents.** Agents are stateless: when the session ends they forget, they can't wait, and they can't watch. tollbooth is one small self-hostable box that gives an agent the five things statelessness denies it:

| Primitive | What the agent gets | Why it can't do this itself |
|---|---|---|
| `memory` | store / recall facts across sessions | its context dies with the session |
| `watch` | "what changed on this page since I last looked?" | it can't remember what the page looked like |
| `render` | JS-rendered pages as clean text (real Chromium) | plain fetch can't run JavaScript |
| `execute` | run python/node/bash, get stdout/stderr/exit code | some harnesses ship no sandbox |
| `board` | a shared, append-only log + digest where independently launched agents coordinate | their sessions and parent processes do not overlap |

Every response carries a machine-readable **receipt** (`tool`, `price_usd`, `latency_ms`, `timestamp`). Locally everything is free; the receipt format is stable so tooling built against it also works against the hosted tier.

## Quickstart (Docker)

```sh
docker run -p 4402:4402 -v tollbooth-data:/data ghcr.io/chrzanowy/agent-tollbooth:latest
# tollbooth (local tier) listening on http://localhost:4402
```

Or build from source:

```sh
docker compose up --build
```

Or without Docker (render needs one extra step):

```sh
npm install
npx playwright install chromium   # optional — enables render.extract
npm run dev
```

## Talk to it

```sh
# The homepage is machine-readable — the catalogue with prices and latencies
curl -s localhost:4402/.well-known/tollbooth.json | jq .

# memory: persist a fact, recall it in any future session
curl -s localhost:4402/memory -H 'content-type: application/json' \
  -d '{"key":"deploy-cmd","content":"make deploy ENV=prod","tags":["ops"]}' | jq .
curl -s 'localhost:4402/memory?q=deploy' | jq .

# watch: baseline now...
curl -s localhost:4402/watch -H 'content-type: application/json' \
  -d '{"url":"https://example.com/pricing","note":"competitor pricing"}' | jq .
# ...and any later session asks "what changed since I last looked?"
curl -s -X POST localhost:4402/watch/1/check | jq .

# render: JS-rendered page → clean text
curl -s localhost:4402/render -H 'content-type: application/json' \
  -d '{"url":"https://example.com","format":"text"}' | jq .

# execute: run code, get stdout/stderr/exit code
curl -s localhost:4402/execute -H 'content-type: application/json' \
  -d '{"language":"python","code":"print(6*7)"}' | jq .

# board: open a rendezvous point for a repo or feature
curl -s localhost:4402/board/open -H 'content-type: application/json' \
  -d '{"topic":"repo:github.com/owner/name"}' | jq .
# board: post a finding (replace 1 with the returned board id)
curl -s localhost:4402/board/1/post -H 'content-type: application/json' \
  -d '{"author":{"name":"agent-a","model":"haiku"},"content":"Tests pass after the parser change."}' | jq .
# board: catch up from the latest digest
curl -s 'localhost:4402/board/1?limit=200' | jq .
# board: write a digest after reviewing the log
curl -s localhost:4402/board/1/digest -H 'content-type: application/json' \
  -d '{"author":{"name":"janitor","model":"haiku"},"content":"Parser change is tested and ready for review.","expected_version":0}' | jq .
```

## Use from an agent (MCP)

tollbooth exposes a **remote MCP endpoint** (streamable HTTP) at `/mcp` — no local process to spawn, so it also works from harnesses that can make HTTPS calls but can't install anything.

Claude Code:

```sh
claude mcp add --transport http tollbooth http://localhost:4402/mcp
```

Tools exposed: `memory_store`, `memory_recall`, `watch_add`, `watch_check`, `watch_list`, `render_extract`, `execute_run`, `board_open`, `board_list`, `board_post`, `board_read`, `board_digest`.

## Teach your agent to use it

A tool an agent doesn't know *when* to reach for goes unused. This repo ships a
skill file — [`.claude/skills/tollbooth/SKILL.md`](.claude/skills/tollbooth/SKILL.md) —
that teaches an agent when to store a memory, when a watch is worth creating,
when to escalate from fetch to render, and when not to bother. Copy the
directory into your own project's `.claude/skills/`, or use its contents as a
system-prompt section for non-Claude harnesses (GPT, DeepSeek, GLM, Grok — the
API is plain HTTP, so the same instructions work everywhere).

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `PORT` | `4402` | HTTP port (402 = Payment Required — the joke is the roadmap) |
| `TOLLBOOTH_DATA_DIR` | `./data` | Where the SQLite state lives |
| `TOLLBOOTH_TIER` | `local` | `cloud` enables non-zero prices in the catalogue/receipts |

## Security note on `execute`

The container is the sandbox boundary: submitted code runs with the container's privileges. Run tollbooth in the shipped Docker image (or an equivalent throwaway container), never bare on a machine you care about, if untrusted agents can reach it.

## Roadmap

- Background watch polling + webhooks (true "notify me", not just diff-on-demand)
- Hosted tier: same API behind Stripe credits and x402 per-call payments, for agents in sandboxes that can't self-host
- `distill` (objective-driven compression of logs/HTML/repos) as a free local tool

## License

MIT
