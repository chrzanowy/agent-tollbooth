// tollbooth-bench: a synthetic agent-customer.
//
// Exercises every primitive the way a real agent would, verifies the answers
// are semantically correct (not just HTTP 200), and emits feedback in the
// agent-review format: success, quality, latency, would_use_again, comment.
//
//   npm run bench                         # against http://localhost:4402
//   TOLLBOOTH_URL=... npm run bench       # against any deployment
//
// The bench runs its own throwaway web server with mutable + JS-injected
// content, because that's the only honest way to test watch (did the diff
// catch a real change?) and render (did the browser execute JavaScript?).
// When tollbooth runs in Docker, it reaches this server via
// BENCH_CALLBACK_HOST (default host.docker.internal).

import http from "node:http";
import { writeFileSync } from "node:fs";

const TARGET = process.env.TOLLBOOTH_URL ?? "http://localhost:4402";
const CALLBACK_HOST = process.env.BENCH_CALLBACK_HOST ?? "host.docker.internal";

// ---- throwaway content server -------------------------------------------------

const state = { version: 1 };
const JS_MARKER = "JS-EXECUTED-MARKER-73114";

const contentServer = http.createServer((req, res) => {
  if (req.url?.startsWith("/mutable")) {
    res.setHeader("content-type", "text/html");
    res.end(
      `<html><body><h1>Status page</h1><p>release version ${state.version}</p>` +
        `<p>everything nominal</p></body></html>`,
    );
  } else if (req.url?.startsWith("/js-page")) {
    res.setHeader("content-type", "text/html");
    res.end(
      `<html><body><p>static text</p>` +
        `<script>document.body.innerHTML += '<p>${JS_MARKER}</p>'</script></body></html>`,
    );
  } else {
    res.statusCode = 404;
    res.end("not found");
  }
});

// ---- scenario harness ----------------------------------------------------------

interface Review {
  tool: string;
  scenario: string;
  success: boolean;
  quality: number; // fraction of semantic checks passed
  latency_ms: number;
  receipt_present: boolean;
  would_use_again: boolean;
  comment: string;
}

const reviews: Review[] = [];

interface Ctx {
  check: (label: string, ok: boolean) => void;
  notes: string[];
}

async function scenario(tool: string, name: string, fn: (ctx: Ctx) => Promise<boolean>) {
  const checks: { label: string; ok: boolean }[] = [];
  const notes: string[] = [];
  const ctx: Ctx = {
    check: (label, ok) => {
      checks.push({ label, ok });
      if (!ok) notes.push(`FAILED: ${label}`);
    },
    notes,
  };
  const started = Date.now();
  let receiptPresent = false;
  let crashed: string | null = null;
  try {
    receiptPresent = await fn(ctx);
  } catch (err) {
    crashed = err instanceof Error ? err.message : String(err);
  }
  const latency = Date.now() - started;
  const passed = checks.filter((c) => c.ok).length;
  const quality = checks.length ? passed / checks.length : 0;
  const success = !crashed && checks.length > 0 && passed === checks.length;
  reviews.push({
    tool,
    scenario: name,
    success,
    quality: Number(quality.toFixed(2)),
    latency_ms: latency,
    receipt_present: receiptPresent,
    would_use_again: success && receiptPresent,
    comment: crashed
      ? `crashed: ${crashed}`
      : success
        ? `${passed}/${checks.length} checks passed`
        : notes.join("; "),
  });
  const icon = success ? "✓" : "✗";
  console.log(`${icon} ${tool} :: ${name} (${latency}ms) ${crashed ?? notes.join("; ") ?? ""}`);
}

// ---- HTTP helpers ---------------------------------------------------------------

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${TARGET}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json()) as { result?: any; receipt?: any; error?: string };
  if (!res.ok) throw new Error(`${method} ${path} -> HTTP ${res.status}: ${json.error}`);
  return json;
}

async function apiStatus(method: string, path: string, body?: unknown) {
  const res = await fetch(`${TARGET}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as { result?: any; receipt?: any; error?: string; current_version?: number } };
}

async function mcp(method: string, params?: unknown) {
  const res = await fetch(`${TARGET}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await res.text();
  const dataLine = text.split("\n").find((l) => l.startsWith("data: "));
  if (!dataLine) throw new Error(`no data in MCP response: ${text.slice(0, 120)}`);
  return JSON.parse(dataLine.slice(6));
}

// ---- scenarios ------------------------------------------------------------------

async function main() {
  await new Promise<void>((r) => contentServer.listen(0, () => r()));
  const port = (contentServer.address() as { port: number }).port;
  const callbackBase = `http://${CALLBACK_HOST}:${port}`;
  console.log(`tollbooth-bench -> ${TARGET} (callback: ${callbackBase})\n`);

  const runId = Date.now().toString(36);
  const boardIds = new Set<number>();

  // memory: roundtrip, search, overwrite, forget
  await scenario("memory", "store/recall/forget roundtrip", async (ctx) => {
    const key = `bench-${runId}`;
    const stored = await api("POST", "/memory", {
      key,
      content: "the answer is 42",
      ns: "bench",
      tags: ["synthetic"],
    });
    ctx.check("store echoes content", stored.result?.content === "the answer is 42");
    const byKey = await api("GET", `/memory?key=${key}&ns=bench`);
    ctx.check("recall by key", byKey.result?.content === "the answer is 42");
    const byQuery = await api("GET", `/memory?q=answer&ns=bench`);
    ctx.check(
      "recall by full-text query",
      Array.isArray(byQuery.result) && byQuery.result.some((m: any) => m.key === key),
    );
    const multiWord = await api("GET", `/memory?q=${encodeURIComponent("42 answer")}&ns=bench`);
    ctx.check(
      "multi-word query matches non-contiguous words",
      Array.isArray(multiWord.result) && multiWord.result.some((m: any) => m.key === key),
    );
    await api("POST", "/memory", { key, content: "updated to 43", ns: "bench" });
    const updated = await api("GET", `/memory?key=${key}&ns=bench`);
    ctx.check("overwrite same key", updated.result?.content === "updated to 43");
    const del = await api("DELETE", `/memory/${key}?ns=bench`);
    ctx.check("forget deletes", del.result?.deleted === true);
    const gone = await api("GET", `/memory?key=${key}&ns=bench`);
    ctx.check("forgotten key is gone", gone.result === null);
    return Boolean(stored.receipt);
  });

  // watch: no-change, then a real change must produce a diff mentioning it
  let watchId: number | undefined;
  await scenario("watch", "detects a real change, ignores no-change", async (ctx) => {
    const added = await api("POST", "/watch", {
      url: `${callbackBase}/mutable`,
      note: "bench mutable page",
    });
    watchId = added.result?.id;
    ctx.check("watch created with baseline", Boolean(added.result?.last_ack_snapshot_id));
    const same = await api("POST", `/watch/${watchId}/check`);
    ctx.check("unchanged page -> changed:false", same.result?.changed === false);
    state.version = 2; // mutate the page
    const changed = await api("POST", `/watch/${watchId}/check`);
    ctx.check("mutated page -> changed:true", changed.result?.changed === true);
    ctx.check(
      "diff contains old and new value",
      typeof changed.result?.diff === "string" &&
        changed.result.diff.includes("version 1") &&
        changed.result.diff.includes("version 2"),
    );
    const ack = await api("POST", `/watch/${watchId}/check`);
    ctx.check("ack advanced: re-check -> changed:false", ack.result?.changed === false);
    return Boolean(added.receipt);
  });

  // render: must prove JavaScript actually executed
  await scenario("render", "executes JavaScript (marker only visible post-JS)", async (ctx) => {
    const r = await api("POST", "/render", { url: `${callbackBase}/js-page`, format: "text" });
    ctx.check("returns page text", typeof r.result?.content === "string");
    ctx.check("JS-injected marker present", r.result?.content.includes(JS_MARKER));
    return Boolean(r.receipt);
  });

  // execute: correctness, nonzero exit, timeout enforcement
  await scenario("execute", "runs code, reports failures, enforces timeout", async (ctx) => {
    const ok = await api("POST", "/execute", {
      language: "python",
      code: "print(sum(range(101)))",
    });
    ctx.check("correct stdout", ok.result?.stdout.trim() === "5050");
    ctx.check("exit code 0", ok.result?.exit_code === 0);
    const bad = await api("POST", "/execute", { language: "node", code: "process.exit(3)" });
    ctx.check("nonzero exit reported", bad.result?.exit_code === 3);
    const slow = await api("POST", "/execute", {
      language: "bash",
      code: "sleep 30",
      timeout_ms: 1500,
    });
    ctx.check("timeout enforced", slow.result?.timed_out === true);
    return Boolean(ok.receipt);
  });

  await scenario("board", "rendezvous by deterministic topic", async (ctx) => {
    const topic = `bench:rendezvous:${runId}`;
    const first = await api("POST", "/board/open", { topic });
    const second = await api("POST", "/board/open", { topic });
    const other = await api("POST", "/board/open", { topic: `${topic}:other` });
    boardIds.add(first.result?.id);
    boardIds.add(other.result?.id);
    ctx.check("same topic returns the same board id", first.result?.id === second.result?.id);
    ctx.check("different topic returns a different board id", first.result?.id !== other.result?.id);
    return Boolean(first.receipt);
  });

  await scenario("board", "namespaced contexts list with descriptions", async (ctx) => {
    const prefix = `bench:ns:${runId}`;
    const inbox = await api("POST", "/board/open", {
      topic: prefix,
      description: "project inbox",
    });
    const auth = await api("POST", "/board/open", {
      topic: `${prefix}/ctx:auth`,
      description: "auth refactor workstream",
    });
    boardIds.add(inbox.result?.id);
    boardIds.add(auth.result?.id);
    ctx.check("description returned at open", inbox.result?.description === "project inbox");
    const reopened = await api("POST", "/board/open", { topic: prefix });
    ctx.check(
      "reopen without description keeps it",
      reopened.result?.description === "project inbox",
    );
    const renamed = await api("POST", "/board/open", {
      topic: prefix,
      description: "project inbox v2",
    });
    ctx.check(
      "reopen with description updates it",
      renamed.result?.description === "project inbox v2",
    );
    const listed = await api("GET", `/board?query=${encodeURIComponent(prefix)}`);
    const topics = (listed.result ?? []).map((b: any) => b.topic);
    ctx.check(
      "prefix query returns inbox and ctx boards",
      topics.includes(prefix) && topics.includes(`${prefix}/ctx:auth`),
    );
    ctx.check(
      "listing carries descriptions",
      (listed.result ?? []).some((b: any) => b.description === "auth refactor workstream"),
    );
    return Boolean(inbox.receipt);
  });

  let postsBoardId: number | undefined;
  await scenario("board", "concurrent posts are gapless", async (ctx) => {
    const opened = await api("POST", "/board/open", { topic: `bench:posts:${runId}` });
    postsBoardId = opened.result?.id;
    boardIds.add(postsBoardId);
    const posts = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        api("POST", `/board/${postsBoardId}/post`, {
          author: { name: index % 2 === 0 ? "worker-a" : "worker-b", model: "bench" },
          content: `discovery-${index + 1}`,
        }),
      ),
    );
    const seqs = posts.map((post) => post.result?.seq).sort((a, b) => a - b);
    ctx.check("all ten posts succeed", posts.length === 10 && seqs.every((seq, index) => seq === index + 1));
    const read = await api("GET", `/board/${postsBoardId}?limit=1000`);
    const entrySeqs = (read.result?.entries ?? []).map((entry: any) => entry.seq);
    ctx.check("read returns ten entries without gaps", JSON.stringify(entrySeqs) === JSON.stringify(seqs));
    return Boolean(opened.receipt);
  });

  await scenario("board", "cursor reads return only unseen entries", async (ctx) => {
    if (!postsBoardId) throw new Error("posts board was not created");
    const fromSeven = await api("GET", `/board/${postsBoardId}?since_seq=7&limit=1000`);
    const latest = await api("GET", `/board/${postsBoardId}?since_seq=10&limit=1000`);
    ctx.check(
      "since_seq=7 returns seqs 8..10",
      JSON.stringify((fromSeven.result?.entries ?? []).map((entry: any) => entry.seq)) === JSON.stringify([8, 9, 10]),
    );
    ctx.check("cursor after entries is 10", fromSeven.result?.next_seq === 10);
    ctx.check("since latest returns no entries", Array.isArray(latest.result?.entries) && latest.result.entries.length === 0);
    ctx.check("empty read keeps cursor at latest", latest.result?.next_seq === 10);
    return Boolean(fromSeven.receipt);
  });

  await scenario("board", "digests preserve history and reject stale writes", async (ctx) => {
    if (!postsBoardId) throw new Error("posts board was not created");
    const first = await api("POST", `/board/${postsBoardId}/digest`, {
      author: { name: "janitor", model: "bench" },
      content: "The first ten discoveries are recorded.",
      expected_version: 0,
    });
    const stale = await apiStatus("POST", `/board/${postsBoardId}/digest`, {
      author: { name: "stale-writer" },
      content: "This must not overwrite version one.",
      expected_version: 0,
    });
    const second = await api("POST", `/board/${postsBoardId}/digest`, {
      author: { name: "janitor", model: "bench" },
      content: "Version two keeps the first digest in history.",
      expected_version: 1,
    });
    const history = await api("GET", `/board/${postsBoardId}/digests`);
    ctx.check("first digest covers seq 10", first.result?.version === 1 && first.result?.covers_seq === 10);
    ctx.check("stale digest gets 409 and current version", stale.status === 409 && stale.json.current_version === 1);
    ctx.check("fresh digest becomes version two", second.result?.version === 2);
    ctx.check(
      "digest history contains both versions",
      JSON.stringify((history.result ?? []).map((digest: any) => digest.version)) === JSON.stringify([2, 1]),
    );
    return Boolean(first.receipt);
  });

  await scenario("board", "default read catches up from the latest digest", async (ctx) => {
    if (!postsBoardId) throw new Error("posts board was not created");
    await Promise.all([
      api("POST", `/board/${postsBoardId}/post`, {
        author: { name: "worker-a" },
        content: "post-digest-1",
      }),
      api("POST", `/board/${postsBoardId}/post`, {
        author: { name: "worker-b" },
        content: "post-digest-2",
      }),
    ]);
    const read = await api("GET", `/board/${postsBoardId}`);
    const entries = read.result?.entries ?? [];
    ctx.check("latest digest is returned", read.result?.digest?.version === 2);
    ctx.check(
      "default read returns only entries after covers_seq",
      entries.length === 2 && entries.every((entry: any) => entry.seq > read.result.digest.covers_seq),
    );
    ctx.check("catch-up entries are seqs 11 and 12", JSON.stringify(entries.map((entry: any) => entry.seq)) === JSON.stringify([11, 12]));
    return Boolean(read.receipt);
  });

  // mcp: list tools, call one end-to-end
  await scenario("mcp", "tools/list and tools/call roundtrip", async (ctx) => {
    const list = await mcp("tools/list");
    const names = (list.result?.tools ?? []).map((t: any) => t.name);
    ctx.check(
      "all 12 tools listed",
      [
        "memory_store",
        "memory_recall",
        "watch_add",
        "watch_check",
        "watch_list",
        "render_extract",
        "execute_run",
        "board_open",
        "board_list",
        "board_post",
        "board_read",
        "board_digest",
      ].every(
        (n) => names.includes(n),
      ),
    );
    const call = await mcp("tools/call", {
      name: "execute_run",
      arguments: { language: "python", code: "print('mcp-ok')" },
    });
    const text = call.result?.content?.[0]?.text ?? "";
    ctx.check("tools/call executes", text.includes("mcp-ok"));
    ctx.check("tool result carries receipt", text.includes('"receipt"'));
    const boardOpen = await mcp("tools/call", {
      name: "board_open",
      arguments: { topic: `bench:mcp:${runId}` },
    });
    const opened = JSON.parse(boardOpen.result?.content?.[0]?.text ?? "{}");
    const mcpBoardId = opened.result?.id;
    boardIds.add(mcpBoardId);
    const boardPost = await mcp("tools/call", {
      name: "board_post",
      arguments: {
        board_id: mcpBoardId,
        author: { name: "mcp-worker" },
        content: "mcp roundtrip",
      },
    });
    const posted = JSON.parse(boardPost.result?.content?.[0]?.text ?? "{}");
    const boardRead = await mcp("tools/call", {
      name: "board_read",
      arguments: { board_id: mcpBoardId },
    });
    const read = JSON.parse(boardRead.result?.content?.[0]?.text ?? "{}");
    ctx.check("board_open works over MCP", Boolean(opened.result?.id));
    ctx.check("board_post works over MCP", posted.result?.seq === 1);
    ctx.check("board_read returns the MCP post", read.result?.entries?.[0]?.content === "mcp roundtrip");
    return true;
  });

  // cleanup
  if (watchId) await api("DELETE", `/watch/${watchId}`).catch(() => {});
  for (const boardId of boardIds) await api("DELETE", `/board/${boardId}`).catch(() => {});
  contentServer.close();

  // ---- the artificial feedback -------------------------------------------------

  const passed = reviews.filter((r) => r.success).length;
  const report = {
    target: TARGET,
    ran_at: new Date().toISOString(),
    verdict: `${passed}/${reviews.length} scenarios passed`,
    reviews,
  };
  writeFileSync("bench-report.json", JSON.stringify(report, null, 2));

  console.log("\n--- synthetic agent feedback ---");
  for (const r of reviews) {
    console.log(
      `${r.success ? "★★★★★" : "★☆☆☆☆"} ${r.tool.padEnd(8)} quality=${r.quality} ` +
        `latency=${r.latency_ms}ms would_use_again=${r.would_use_again} — ${r.comment}`,
    );
  }
  console.log(`\n${report.verdict} (full report: bench-report.json)`);
  process.exit(passed === reviews.length ? 0 : 1);
}

main().catch((err) => {
  console.error("bench harness failed:", err);
  process.exit(2);
});
