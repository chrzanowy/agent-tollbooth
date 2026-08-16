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

  // mcp: list tools, call one end-to-end
  await scenario("mcp", "tools/list and tools/call roundtrip", async (ctx) => {
    const list = await mcp("tools/list");
    const names = (list.result?.tools ?? []).map((t: any) => t.name);
    ctx.check(
      "all 7 tools listed",
      ["memory_store", "memory_recall", "watch_add", "watch_check", "watch_list", "render_extract", "execute_run"].every(
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
    return true;
  });

  // cleanup
  if (watchId) await api("DELETE", `/watch/${watchId}`).catch(() => {});
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
