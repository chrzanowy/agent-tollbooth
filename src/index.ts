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
      const status = err instanceof render.RenderUnavailableError ? 501 : 400;
      res.status(status).json({ error: message, tool });
    }
  };
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
