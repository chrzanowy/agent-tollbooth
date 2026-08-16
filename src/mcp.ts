import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CATALOG } from "./catalog.js";
import { withReceipt } from "./receipts.js";
import * as memory from "./primitives/memory.js";
import * as watch from "./primitives/watch.js";
import * as render from "./primitives/render.js";
import * as execute from "./primitives/execute.js";
import * as board from "./primitives/board.js";

function asText(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

function describe(name: string): string {
  const entry = CATALOG.find((c) => c.name === name)!;
  return `${entry.description} [price: $${entry.price_usd}/call]`;
}

// One McpServer per request (stateless streamable-HTTP mode) — cheap to build,
// and the same server works pointed at localhost or the hosted tier.
export function buildMcpServer(): McpServer {
  const server = new McpServer({ name: "tollbooth", version: "0.1.0" });

  server.registerTool(
    "memory_store",
    {
      description: describe("memory.store"),
      inputSchema: {
        key: z.string(),
        content: z.string(),
        ns: z.string().optional(),
        tags: z.array(z.string()).optional(),
      },
    },
    async ({ key, content, ns, tags }) =>
      asText(await withReceipt("memory.store", async () => memory.store(key, content, ns, tags))),
  );

  server.registerTool(
    "memory_recall",
    {
      description: describe("memory.recall"),
      inputSchema: {
        key: z.string().optional().describe("Exact key to fetch"),
        query: z.string().optional().describe("Full-text search over keys, content, and tags"),
        ns: z.string().optional(),
      },
    },
    async ({ key, query, ns }) =>
      asText(
        await withReceipt("memory.recall", async () => {
          if (key) return memory.get(key, ns);
          if (query) return memory.search(query, ns);
          throw new Error("provide key or query");
        }),
      ),
  );

  server.registerTool(
    "watch_add",
    {
      description: describe("watch.add"),
      inputSchema: {
        url: z.string().url(),
        selector: z.string().optional(),
        note: z.string().optional(),
      },
    },
    async ({ url, selector, note }) =>
      asText(await withReceipt("watch.add", () => watch.add(url, selector, note))),
  );

  server.registerTool(
    "watch_check",
    {
      description: describe("watch.check"),
      inputSchema: { watch_id: z.number().int() },
    },
    async ({ watch_id }) => asText(await withReceipt("watch.check", () => watch.check(watch_id))),
  );

  server.registerTool(
    "watch_list",
    { description: "List all active watches.", inputSchema: {} },
    async () => asText(await withReceipt("watch.check", async () => watch.list())),
  );

  server.registerTool(
    "render_extract",
    {
      description: describe("render.extract"),
      inputSchema: {
        url: z.string().url(),
        format: z.enum(["text", "html"]).optional(),
        wait_ms: z.number().int().optional(),
      },
    },
    async ({ url, format, wait_ms }) =>
      asText(await withReceipt("render.extract", () => render.extract(url, format, wait_ms))),
  );

  server.registerTool(
    "execute_run",
    {
      description: describe("execute.run"),
      inputSchema: {
        language: z.enum(["python", "node", "bash"]),
        code: z.string(),
        timeout_ms: z.number().int().optional(),
      },
    },
    async ({ language, code, timeout_ms }) =>
      asText(await withReceipt("execute.run", () => execute.run(language, code, timeout_ms))),
  );

  const authorSchema = z
    .object({
      name: z.string(),
      model: z.string().optional(),
      harness: z.string().optional(),
    })
    .strict();

  server.registerTool(
    "board_open",
    {
      description: describe("board.open"),
      inputSchema: { topic: z.string(), description: z.string().optional() },
    },
    async ({ topic, description }) =>
      asText(await withReceipt("board.open", async () => board.open(topic, description))),
  );

  server.registerTool(
    "board_list",
    {
      description: describe("board.open"),
      inputSchema: { query: z.string().optional() },
    },
    async ({ query }) => asText(await withReceipt("board.open", async () => board.listBoards(query))),
  );

  server.registerTool(
    "board_post",
    {
      description: describe("board.post"),
      inputSchema: {
        board_id: z.number().int(),
        author: authorSchema,
        content: z.string(),
      },
    },
    async ({ board_id, author, content }) =>
      asText(await withReceipt("board.post", async () => board.post(board_id, author, content))),
  );

  server.registerTool(
    "board_read",
    {
      description: describe("board.read"),
      inputSchema: {
        board_id: z.number().int(),
        since_seq: z.number().int().nonnegative().optional(),
        limit: z.number().int().positive().optional(),
      },
    },
    async ({ board_id, since_seq, limit }) =>
      asText(await withReceipt("board.read", async () => board.read(board_id, since_seq, limit))),
  );

  server.registerTool(
    "board_digest",
    {
      description: describe("board.digest"),
      inputSchema: {
        board_id: z.number().int(),
        author: authorSchema,
        content: z.string(),
        expected_version: z.number().int().nonnegative(),
      },
    },
    async ({ board_id, author, content, expected_version }) =>
      asText(
        await withReceipt("board.digest", async () =>
          board.writeDigest(board_id, author, content, expected_version),
        ),
      ),
  );

  return server;
}
