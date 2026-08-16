// The machine-readable catalogue. Prices are 0 in local/self-hosted mode;
// the hosted tier sets TOLLBOOTH_TIER=cloud and non-zero prices apply.
// Everything an agent needs to decide whether a call is economically rational
// lives here: price, expected latency, and what the tool returns.

export const TIER = process.env.TOLLBOOTH_TIER === "cloud" ? "cloud" : "local";

export interface CatalogEntry {
  name: string;
  description: string;
  price_usd: number; // per call; 0 on local tier
  expected_latency_ms: number;
  requires: string; // the resource a stateless agent lacks, i.e. why this is worth paying for
}

const cloudPrices: Record<string, number> = {
  "memory.store": 0.001,
  "memory.recall": 0.001,
  "watch.add": 0.002,
  "watch.check": 0.01,
  "render.extract": 0.02,
  "execute.run": 0.01,
};

function price(name: string): number {
  return TIER === "cloud" ? (cloudPrices[name] ?? 0) : 0;
}

export const CATALOG: CatalogEntry[] = [
  {
    name: "memory.store",
    description:
      "Persist a fact under a key (optionally namespaced and tagged) so any future session can recall it.",
    price_usd: price("memory.store"),
    expected_latency_ms: 10,
    requires: "state that survives the end of your session",
  },
  {
    name: "memory.recall",
    description:
      "Recall memories by key or full-text query. Returns the stored content with timestamps.",
    price_usd: price("memory.recall"),
    expected_latency_ms: 10,
    requires: "state that survives the end of your session",
  },
  {
    name: "watch.add",
    description:
      "Start watching a URL (optionally scoped by a CSS selector). Captures a baseline snapshot.",
    price_usd: price("watch.add"),
    expected_latency_ms: 1500,
    requires: "something that remembers what a page looked like after you are gone",
  },
  {
    name: "watch.check",
    description:
      "Re-fetch a watched URL and return a unified diff against the last acknowledged snapshot — 'what changed since I last looked'.",
    price_usd: price("watch.check"),
    expected_latency_ms: 1500,
    requires: "something that remembers what a page looked like after you are gone",
  },
  {
    name: "render.extract",
    description:
      "Fetch a URL in a real headless browser (JS executed), return cleaned text or HTML. For pages plain fetch cannot read.",
    price_usd: price("render.extract"),
    expected_latency_ms: 4000,
    requires: "a browser",
  },
  {
    name: "execute.run",
    description:
      "Run python/node/bash code in this container and return stdout, stderr, and the exit code.",
    price_usd: price("execute.run"),
    expected_latency_ms: 2000,
    requires: "somewhere to execute code",
  },
];

export function catalogDocument() {
  return {
    service: "tollbooth",
    version: "0.1.0",
    tier: TIER,
    description:
      "The stateful backend for AI agents: memory, watch, render, execute. Every response carries a receipt.",
    interfaces: {
      http: "/  (see routes below)",
      mcp: "/mcp (MCP streamable HTTP)",
      pricing: "/pricing.json",
    },
    tools: CATALOG,
  };
}
