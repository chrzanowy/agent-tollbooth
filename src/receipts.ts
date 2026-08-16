import { CATALOG } from "./catalog.js";

export interface Receipt {
  tool: string;
  price_usd: number;
  latency_ms: number;
  timestamp: string;
}

// Wrap a tool result with a machine-readable receipt. The receipt is a
// first-class feature: the human sponsoring an agent's budget audits spend
// through these, so every paid (or payable) call must carry one.
export async function withReceipt<T>(
  tool: string,
  fn: () => Promise<T>,
): Promise<{ result: T; receipt: Receipt }> {
  const started = Date.now();
  const result = await fn();
  const entry = CATALOG.find((c) => c.name === tool);
  return {
    result,
    receipt: {
      tool,
      price_usd: entry?.price_usd ?? 0,
      latency_ms: Date.now() - started,
      timestamp: new Date().toISOString(),
    },
  };
}
