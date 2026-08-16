#!/usr/bin/env node
// tollbooth session hook — mechanical context capture, zero model tokens.
//
// Reads a Claude Code hook payload on stdin (SessionEnd or PreCompact),
// derives a board topic from the project the session ran in, opens the board
// (get-or-create), and posts the tail of the session transcript. No LLM is
// involved: it copies bytes the transcript already holds.
//
// Wire it up once in ~/.claude/settings.json and it covers every project:
//
//   {
//     "hooks": {
//       "SessionEnd": [{ "hooks": [{ "type": "command",
//         "command": "node /path/to/scripts/tollbooth-hook.mjs" }] }],
//       "PreCompact": [{ "hooks": [{ "type": "command",
//         "command": "node /path/to/scripts/tollbooth-hook.mjs" }] }]
//     }
//   }
//
// Config (env):
//   TOLLBOOTH_URL             default http://localhost:4402
//   TOLLBOOTH_BOARD_TOPIC     override the derived topic
//   TOLLBOOTH_HOOK_MESSAGES   last N assistant messages to capture (default 1)
//   TOLLBOOTH_HOOK_MAX_BYTES  cap on posted content (default 16384, hard cap 60000)
//
// The hook never fails the session: any error exits 0 silently.

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";

const BASE = process.env.TOLLBOOTH_URL ?? "http://localhost:4402";
const MESSAGES = clampInt(process.env.TOLLBOOTH_HOOK_MESSAGES, 1, 1, 50);
const MAX_BYTES = clampInt(process.env.TOLLBOOTH_HOOK_MAX_BYTES, 16_384, 512, 60_000);

function clampInt(raw, fallback, min, max) {
  const n = Number(raw);
  return Number.isInteger(n) ? Math.min(Math.max(n, min), max) : fallback;
}

function deriveTopic(cwd) {
  if (process.env.TOLLBOOTH_BOARD_TOPIC) return process.env.TOLLBOOTH_BOARD_TOPIC;
  try {
    const remote = execSync("git remote get-url origin", {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    // git@github.com:owner/name.git | https://github.com/owner/name.git
    const m = remote.match(/^(?:[\w.-]+@)?(?:\w+:\/\/)?([\w.-]+)[:/](.+?)(?:\.git)?$/);
    if (m) return `repo:${m[1]}/${m[2]}`;
  } catch {
    // not a git repo, or no origin — fall through
  }
  return `dir:${path.basename(cwd)}`;
}

function assistantTail(transcriptPath, count) {
  const texts = [];
  for (const line of readFileSync(transcriptPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record.type !== "assistant") continue;
    const blocks = record.message?.content;
    if (!Array.isArray(blocks)) continue;
    const text = blocks
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (text) texts.push(text);
  }
  return texts.slice(-count).join("\n\n---\n\n");
}

async function main() {
  const input = JSON.parse(readFileSync(0, "utf8"));
  const cwd = input.cwd ?? process.cwd();
  const event = input.hook_event_name ?? "unknown";
  const detail = input.reason ?? input.trigger ?? "";

  let body = assistantTail(input.transcript_path, MESSAGES);
  if (!body) return;
  const header = `[session-hook] event=${event}${detail ? ` (${detail})` : ""} session=${input.session_id ?? "?"} cwd=${cwd}\n\n`;
  let content = header + body;
  if (Buffer.byteLength(content, "utf8") > MAX_BYTES) {
    content = content.slice(0, MAX_BYTES) + "\n…[truncated by tollbooth-hook]";
  }

  const opened = await post("/board/open", { topic: deriveTopic(cwd) });
  const boardId = opened?.result?.id;
  if (!boardId) return;
  await post(`/board/${boardId}/post`, {
    author: { name: "session-hook", harness: "claude-code" },
    content,
  });
}

async function post(route, payload) {
  const res = await fetch(`${BASE}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(3000),
  });
  return res.json();
}

main().catch(() => {});
