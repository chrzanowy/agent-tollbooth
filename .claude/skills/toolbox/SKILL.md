---
name: toolbox
description: Team-local log of problem → tool that actually worked, stored in tollbooth memory (ns=toolbox). Invoke BEFORE building, installing, or hand-rolling anything to solve a problem ("is there a tool for X", "how do we usually do X"), and AFTER a tool demonstrably works ("save this to the toolbox", "remember we used X for Y").
---

# toolbox — did we already find a tool for this?

A shared, machine-global memory namespace answering one question: *has any
session, in any repo, already found a tool for this problem?* Global on
purpose — problems recur across projects; boards stay per-project, the
toolbox does not.

## Habit 1: recall before you build

Before installing, writing, or hand-rolling a solution, search by the
*problem*, not the tool name (a future searcher knows their problem, not
your answer):

```sh
curl -s 'localhost:4402/memory?q=<problem words>&ns=toolbox'
```

(or MCP `memory_recall` with `ns: "toolbox"`). On a hit, use the stored
invocation and respect its caveats. On a miss, solve it your way — then see
habit 2.

## Habit 2: store only what you watched work

Store when a tool has **demonstrably succeeded** — never when you merely
found it. One plausible-but-untested reference poisons trust in the whole
toolbox. Overwrite the same key when a better tool supersedes it; `forget`
entries that turn out broken.

```sh
curl -s localhost:4402/memory -H 'content-type: application/json' -d '{
  "ns": "toolbox",
  "key": "<problem-slug>",
  "tags": ["tool", "<domain>"],
  "content": "problem: <one line, phrased as a searcher would>\ntool: <name + where it comes from>\ninvocation: <the exact command/call that worked>\nverified: <date> — <what you actually observed>\ncaveats: <sharp edges, limits, gotchas>"
}'
```

Key by problem (`publish-mcp-server-registry`), not by tool
(`mcp-publisher`) — the problem is what recurs.
