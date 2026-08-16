import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Isolation model: the container running tollbooth IS the sandbox boundary.
// Code runs with the container's privileges — run tollbooth in a throwaway
// container (the shipped Dockerfile) and treat anything inside as untrusted.

export interface ExecuteResult {
  exit_code: number | null;
  stdout: string;
  stderr: string;
  timed_out: boolean;
  duration_ms: number;
}

const LANGS: Record<string, { cmd: string; args: (file: string) => string[]; ext: string }> = {
  python: { cmd: "python3", args: (f) => [f], ext: ".py" },
  node: { cmd: "node", args: (f) => [f], ext: ".mjs" },
  bash: { cmd: "bash", args: (f) => [f], ext: ".sh" },
};

const OUTPUT_CAP = 256 * 1024; // per stream

export async function run(
  language: string,
  code: string,
  timeoutMs = 10_000,
): Promise<ExecuteResult> {
  const lang = LANGS[language];
  if (!lang) throw new Error(`unsupported language: ${language} (supported: ${Object.keys(LANGS).join(", ")})`);
  const cappedTimeout = Math.min(Math.max(timeoutMs, 100), 60_000);

  const dir = mkdtempSync(path.join(tmpdir(), "tollbooth-exec-"));
  const file = path.join(dir, `main${lang.ext}`);
  writeFileSync(file, code);

  const started = Date.now();
  return await new Promise<ExecuteResult>((resolve) => {
    // detached → own process group, so the timeout can kill the whole tree
    // (killing just the shell leaves orphans holding the stdio pipes open).
    const child = spawn(lang.cmd, lang.args(file), { cwd: dir, detached: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const killTree = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, cappedTimeout);

    child.stdout.on("data", (d: Buffer) => {
      if (stdout.length < OUTPUT_CAP) stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < OUTPUT_CAP) stderr += d.toString();
    });

    let finished = false;
    const finish = (exitCode: number | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      killTree(); // reap any orphaned grandchildren
      rmSync(dir, { recursive: true, force: true });
      resolve({
        exit_code: exitCode,
        stdout: stdout.slice(0, OUTPUT_CAP),
        stderr: stderr.slice(0, OUTPUT_CAP),
        timed_out: timedOut,
        duration_ms: Date.now() - started,
      });
    };

    child.on("error", (err) => {
      stderr += `\nspawn error: ${err.message}`;
      finish(null);
    });
    // 'close' waits for stdio pipes, which an orphaned grandchild can hold
    // open past the timeout — resolve on 'exit' (with a short grace period
    // for the streams to flush) instead.
    child.on("exit", (code) => setTimeout(() => finish(code), 25));
  });
}
