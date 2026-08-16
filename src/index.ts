import express from "express";
import type { Request, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { catalogDocument, TIER } from "./catalog.js";
import { withReceipt } from "./receipts.js";
import { buildMcpServer } from "./mcp.js";
import * as memory from "./primitives/memory.js";
import * as watch from "./primitives/watch.js";
import * as render from "./primitives/render.js";
import * as execute from "./primitives/execute.js";
import * as board from "./primitives/board.js";

const app = express();
app.use(express.json({ limit: "10mb" }));

// ---- discovery: the "homepage" is machine-readable --------------------------

app.get(["/", "/pricing.json", "/.well-known/tollbooth.json"], (_req, res) => {
  res.json(catalogDocument());
});

// ---- helpers ----------------------------------------------------------------

function handle(tool: string, fn: (req: Request) => Promise<unknown>) {
  return async (req: Request, res: Response) => {
    try {
      res.json(await withReceipt(tool, () => fn(req)));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status =
        err instanceof board.DigestConflictError
          ? 409
          : err instanceof render.RenderUnavailableError
            ? 501
            : 400;
      res.status(status).json({
        error: message,
        tool,
        ...(err instanceof board.DigestConflictError ? { current_version: err.currentVersion } : {}),
      });
    }
  };
}

function bodyWithKeys(req: Request, keys: string[]): Record<string, unknown> {
  const body = req.body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("request body must be an object");
  }
  if (Object.keys(body).some((key) => !keys.includes(key))) {
    throw new Error(`request body contains unknown fields`);
  }
  return body as Record<string, unknown>;
}

function pathId(raw: string): number {
  if (!/^\d+$/.test(raw)) throw new Error("id must be a positive integer");
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id < 1) throw new Error("id must be a positive integer");
  return id;
}

function queryInteger(raw: unknown, name: string): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) throw new Error(`${name} must be a non-negative integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be a non-negative integer`);
  return value;
}

// ---- memory ------------------------------------------------------------------

app.post(
  "/memory",
  handle("memory.store", async (req) => {
    const { key, content, ns, tags } = req.body ?? {};
    if (typeof key !== "string" || typeof content !== "string")
      throw new Error("key and content (strings) are required");
    return memory.store(key, content, ns, tags);
  }),
);

app.get(
  "/memory",
  handle("memory.recall", async (req) => {
    const { key, q, ns } = req.query as Record<string, string | undefined>;
    if (key) return memory.get(key, ns);
    if (q) return memory.search(q, ns);
    throw new Error("provide ?key= or ?q=");
  }),
);

app.delete(
  "/memory/:key",
  handle("memory.store", async (req) => ({
    deleted: memory.forget(req.params.key, (req.query.ns as string) || undefined),
  })),
);

// ---- watch -------------------------------------------------------------------

app.post(
  "/watch",
  handle("watch.add", async (req) => {
    const { url, selector, note } = req.body ?? {};
    if (typeof url !== "string") throw new Error("url (string) is required");
    return watch.add(url, selector, note);
  }),
);

app.get("/watch", handle("watch.check", async () => watch.list()));

app.post(
  "/watch/:id/check",
  handle("watch.check", async (req) => watch.check(Number(req.params.id))),
);

app.delete(
  "/watch/:id",
  handle("watch.add", async (req) => ({ deleted: watch.remove(Number(req.params.id)) })),
);

// ---- board -------------------------------------------------------------------

app.post(
  "/board/open",
  handle("board.open", async (req) => {
    const body = bodyWithKeys(req, ["topic", "description"]);
    if (typeof body.topic !== "string") throw new Error("topic (string) is required");
    if (body.description !== undefined && typeof body.description !== "string") {
      throw new Error("description must be a string");
    }
    return board.open(body.topic, body.description);
  }),
);

app.get(
  "/board",
  handle("board.open", async (req) => {
    const query = req.query.query;
    if (query !== undefined && typeof query !== "string") throw new Error("query must be a string");
    return board.listBoards(query);
  }),
);

app.post(
  "/board/:id/post",
  handle("board.post", async (req) => {
    const body = bodyWithKeys(req, ["author", "content"]);
    if (typeof body.content !== "string") throw new Error("content (string) is required");
    return board.post(pathId(req.params.id), body.author as board.Author, body.content);
  }),
);

app.get(
  "/board/:id/digests",
  handle("board.read", async (req) => board.listDigests(pathId(req.params.id))),
);

app.get(
  "/board/:id",
  handle("board.read", async (req) => {
    const sinceSeq = queryInteger(req.query.since_seq, "since_seq");
    const limit = queryInteger(req.query.limit, "limit");
    return board.read(pathId(req.params.id), sinceSeq, limit);
  }),
);

app.post(
  "/board/:id/digest",
  handle("board.digest", async (req) => {
    const body = bodyWithKeys(req, ["author", "content", "expected_version"]);
    if (typeof body.content !== "string") throw new Error("content (string) is required");
    if (typeof body.expected_version !== "number") throw new Error("expected_version (number) is required");
    return board.writeDigest(
      pathId(req.params.id),
      body.author as board.Author,
      body.content,
      body.expected_version,
    );
  }),
);

app.delete(
  "/board/:id",
  handle("board.open", async (req) => ({ deleted: board.removeBoard(pathId(req.params.id)) })),
);

// ---- render ------------------------------------------------------------------

app.post(
  "/render",
  handle("render.extract", async (req) => {
    const { url, format, wait_ms } = req.body ?? {};
    if (typeof url !== "string") throw new Error("url (string) is required");
    return render.extract(url, format, wait_ms);
  }),
);

// ---- execute -----------------------------------------------------------------

app.post(
  "/execute",
  handle("execute.run", async (req) => {
    const { language, code, timeout_ms } = req.body ?? {};
    if (typeof language !== "string" || typeof code !== "string")
      throw new Error("language and code (strings) are required");
    return execute.run(language, code, timeout_ms);
  }),
);

// ---- MCP (streamable HTTP, stateless) ------------------------------------------

app.post("/mcp", async (req, res) => {
  const server = buildMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: String(err) });
  }
});

// Stateless mode: session-oriented GET/DELETE are not applicable.
app.get("/mcp", (_req, res) => {
  res.status(405).json({ error: "stateless MCP endpoint: POST only" });
});
app.delete("/mcp", (_req, res) => {
  res.status(405).json({ error: "stateless MCP endpoint: POST only" });
});

// ---- start -------------------------------------------------------------------

const port = Number(process.env.PORT ?? 4402);
app.listen(port, () => {
  console.log(`tollbooth (${TIER} tier) listening on http://localhost:${port}`);
  console.log(`  catalogue: http://localhost:${port}/.well-known/tollbooth.json`);
  console.log(`  mcp:       http://localhost:${port}/mcp`);
});
