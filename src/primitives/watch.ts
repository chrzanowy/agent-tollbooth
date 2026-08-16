import { createHash } from "node:crypto";
import { createTwoFilesPatch } from "diff";
import { db } from "../db.js";

export interface Watch {
  id: number;
  url: string;
  selector: string | null;
  note: string | null;
  last_ack_snapshot_id: number | null;
  created_at: string;
}

// Reduce a page to comparable text: optionally scope to a CSS selector's
// rough region, then strip scripts/styles/tags and collapse whitespace.
// Deterministic and dependency-free — good enough to answer "did it change".
function toComparableText(html: string, selector?: string | null): string {
  let scoped = html;
  if (selector) {
    // Cheap scoping: keep from the first occurrence of the selector's
    // id/class token onward, bounded to 50KB. A real DOM query needs the
    // render primitive; this keeps plain watch dependency-free.
    const token = selector.replace(/^[.#]/, "");
    const idx = html.indexOf(token);
    if (idx >= 0) scoped = html.slice(idx, idx + 50_000);
  }
  return scoped
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchComparable(url: string, selector?: string | null): Promise<string> {
  const res = await fetch(url, {
    headers: { "user-agent": "tollbooth-watch/0.1 (+https://github.com)" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`fetch failed: HTTP ${res.status}`);
  const body = await res.text();
  const contentType = res.headers.get("content-type") ?? "";
  return contentType.includes("html") ? toComparableText(body, selector) : body.trim();
}

function saveSnapshot(watchId: number, content: string): number {
  const hash = createHash("sha256").update(content).digest("hex");
  const res = db
    .prepare(`INSERT INTO snapshots (watch_id, hash, content, fetched_at) VALUES (?, ?, ?, ?)`)
    .run(watchId, hash, content, new Date().toISOString());
  return Number(res.lastInsertRowid);
}

export async function add(url: string, selector?: string, note?: string): Promise<Watch> {
  const content = await fetchComparable(url, selector);
  const res = db
    .prepare(`INSERT INTO watches (url, selector, note, created_at) VALUES (?, ?, ?, ?)`)
    .run(url, selector ?? null, note ?? null, new Date().toISOString());
  const watchId = Number(res.lastInsertRowid);
  const snapId = saveSnapshot(watchId, content);
  db.prepare(`UPDATE watches SET last_ack_snapshot_id = ? WHERE id = ?`).run(snapId, watchId);
  return getWatch(watchId)!;
}

export function list(): Watch[] {
  return db.prepare(`SELECT * FROM watches ORDER BY id`).all() as unknown as Watch[];
}

export function getWatch(id: number): Watch | null {
  return (db.prepare(`SELECT * FROM watches WHERE id = ?`).get(id) as Watch | undefined) ?? null;
}

export function remove(id: number): boolean {
  db.prepare(`DELETE FROM snapshots WHERE watch_id = ?`).run(id);
  return db.prepare(`DELETE FROM watches WHERE id = ?`).run(id).changes > 0;
}

export interface CheckResult {
  watch_id: number;
  url: string;
  changed: boolean;
  baseline_at: string | null;
  checked_at: string;
  diff: string | null;
}

// "What changed since I last looked?" — fetch now, diff against the last
// acknowledged snapshot, and move the ack forward so the next check answers
// the same question relative to *this* look.
export async function check(id: number): Promise<CheckResult> {
  const watch = getWatch(id);
  if (!watch) throw new Error(`watch ${id} not found`);

  const baseline = watch.last_ack_snapshot_id
    ? (db.prepare(`SELECT * FROM snapshots WHERE id = ?`).get(watch.last_ack_snapshot_id) as
        | { content: string; hash: string; fetched_at: string }
        | undefined)
    : undefined;

  const current = await fetchComparable(watch.url, watch.selector);
  const currentHash = createHash("sha256").update(current).digest("hex");
  const checkedAt = new Date().toISOString();

  if (baseline && baseline.hash === currentHash) {
    return {
      watch_id: id,
      url: watch.url,
      changed: false,
      baseline_at: baseline.fetched_at,
      checked_at: checkedAt,
      diff: null,
    };
  }

  const snapId = saveSnapshot(id, current);
  db.prepare(`UPDATE watches SET last_ack_snapshot_id = ? WHERE id = ?`).run(snapId, id);

  const diff = baseline
    ? createTwoFilesPatch(
        `before (${baseline.fetched_at})`,
        `after (${checkedAt})`,
        wrapText(baseline.content),
        wrapText(current),
        undefined,
        undefined,
        { context: 1 },
      )
    : null;

  return {
    watch_id: id,
    url: watch.url,
    changed: baseline !== undefined,
    baseline_at: baseline?.fetched_at ?? null,
    checked_at: checkedAt,
    diff,
  };
}

// The comparable text is one long line; re-wrap so unified diffs are readable
// and small — agents pay per token to read the answer.
function wrapText(text: string, width = 100): string {
  const words = text.split(" ");
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if (line.length + w.length + 1 > width) {
      lines.push(line);
      line = w;
    } else {
      line = line ? `${line} ${w}` : w;
    }
  }
  if (line) lines.push(line);
  return lines.join("\n");
}
