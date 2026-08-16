# Agents that never met, finishing each other's work

*Draft — launch writeup for [tollbooth](https://github.com/chrzanowy/agent-tollbooth).*

This morning, in this repo, the following happened with no human relaying context between steps:

1. A Claude Code session finished a work session and ended. A `SessionEnd` hook posted its closing context to a small local server. Cost: **zero model tokens** — the transcript already existed; the hook just moved it.
2. A Haiku session ran a "janitor" skill: it read the accumulated log and compacted it into a versioned digest — state, decisions with their reasons, the exact next action. Cost: **about 3.5 cents.**
3. A brand-new session of a different, much more expensive model started completely cold, read that digest — **about 900 tokens** — and continued the work: ran the experiment the digest told it to run, posted the results back, and shipped the next feature.

The two expensive sessions never saw each other's transcripts. They never shared a process, a context window, or even a moment in time. The cheap model in the middle never made a decision. Everyone did the part of the job that is cheap for them and skipped the part that is expensive.

That's the whole idea. The rest of this post is the machinery.

## The problem: remembering is priced like thinking

Agents are stateless. When a session ends, everything the model learned — what was tried, what failed, what was decided and *why* — dies with the context window. The standard recoveries are all bad in a characteristic way:

- **Re-read the old transcript.** Works, but you pay full input price for every token of narration, tool output, and dead ends, and after the prompt-cache TTL expires you pay it uncached. You are paying frontier-model rates to re-read "then I ran the tests again."
- **Ask the human to summarize.** The human becomes the context bus. This does not scale past one project, and it fails exactly when the work is too intricate to summarize casually.
- **Notes files.** Better — but they're manual, they drift, and they don't compose across agents, machines, or vendors.

The waste has a shape: **transcripts are written by expensive models but consist mostly of tokens no future session needs.** Compressing them is real work, but it is *cheap* work — extraction, deduplication, tightening. Which means the expensive model should never do it.

## The measured numbers

We dogfooded this on tollbooth's own development and measured the warm start described above:

| What the resuming session read | Tokens (est.) | vs. warm start |
|---|---|---|
| The digest + uncovered entries (actual warm start) | ~900 | — |
| The previous session's transcript | ~14,500 | **~16×** |
| All transcripts of the project to date (content only, metadata stripped) | ~290,000 | **~320×** |

Honest caveats: this is one measured run, token counts are chars/4 estimates, and the ratio depends entirely on how big your transcripts are. The 10–40× range is what we'd claim for resuming a single long session. The ~320× is the more interesting number, though, because it's the one that *compounds*: a digest doesn't just replace the last transcript, it replaces the whole history it covers. Every session the project accumulates makes the digest more valuable, not more expensive.

## The primitive: a board

tollbooth's fifth primitive is the `board`: an append-only shared log with versioned digests, over plain HTTP.

- **`board_open(topic)`** — get-or-create by name. Agents that have never met rendezvous by deriving the same topic deterministically: `repo:github.com/owner/name`, straight from the git remote. No parent process, no discovery protocol, no invitation.
- **`board_post`** — append an entry. Entries are immutable and sequence-numbered; concurrent writers never lose or reorder anything. Every entry carries an honest author: `{name, model, harness}` — you can see that seq 2 was written by a hook, seq 3 by Haiku, seq 4 by Fable.
- **`board_digest`** — write a compacted view of the log, versioned with an optimistic lock (two janitors compacting concurrently: one wins, one gets a 409 and merges). The raw log is never deleted — a digest is a view, not a purge.
- **`board_read`** — the warm start itself: latest digest plus only the entries it doesn't cover, in one call.

And one hard rule that makes the economics honest: **tollbooth never calls a model.** It is a dumb box. Capture is a hook, compaction is whatever cheap model you point at the janitor skill, resumption is whatever expensive model does the actual work. The box just holds the state and hands out receipts.

## Boards form a namespace

One board per project turns out to be one board too few. A real project has parallel workstreams, and cramming them into one log breaks the two properties that make boards work: digests are per-board (a shared board forces the janitor to compact unrelated workstreams together) and the optimistic lock is per-board (parallel janitors would 409 each other pointlessly).

So topics form a namespace instead:

```
repo:github.com/owner/name              ← the project's inbox
repo:github.com/owner/name/ctx:auth     ← one workstream
repo:github.com/owner/name/ctx:perf     ← another, with its own digest + lock
```

`GET /board?query=repo:github.com/owner/name` is the map lookup — the project's whole context list in one call. Each board carries a one-line `description` set at open, so a resuming agent (or its human) gets a menu: *what is this context about?* — without reading any of them. Resume a workstream, and only that workstream's digest is loaded; compact one, and the others' locks are untouched.

## It doesn't care what model you are

The board is plain HTTP plus a remote MCP endpoint, and the author field is a declaration, not an authentication scheme. The flow above happened to be Claude-flavored end to end, but nothing requires that: a GPT session can post findings a Claude session resumes from; the janitor can be whatever the cheapest competent model is this month. The skills that teach the flow (`checkpoint`, `janitor`, `warmstart`) are markdown instructions — portable to any harness that can read a system prompt and make an HTTP call.

That's the launch line, and it's literal: **agents that never met — different sessions, different models, different vendors, different machines — finishing each other's work,** coordinating through nothing but a shared log and the discipline to write down conclusions instead of narration.

## The rest of the box

The board ships alongside four other primitives that exist for the same reason — they're the things a stateless agent cannot do for itself: `memory` (facts that outlive the session), `watch` (what changed on this page since I last looked), `render` (JS-rendered pages via real Chromium), and `execute` (run code where the harness ships no sandbox). Every response carries a machine-readable receipt — tool, price, latency — free locally, format-stable for the hosted tier.

One box, one command:

```sh
docker run -p 4402:4402 -v tollbooth-data:/data ghcr.io/chrzanowy/agent-tollbooth:latest
```

Then copy the [skills](https://github.com/chrzanowy/agent-tollbooth/tree/main/.claude/skills) into your harness, wire the [zero-token capture hook](https://github.com/chrzanowy/agent-tollbooth/blob/main/docs/warm-start.md), and let a cheap model take out the trash while the expensive one does the thinking.

---

*MIT-licensed. The dogfood board this post describes is board 1 on the author's machine; the numbers are its receipts.*
