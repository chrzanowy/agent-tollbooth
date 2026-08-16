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
    const child = spawn(lang.cmd, lang.args(file), { cwd: dir });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, cappedTimeout);

    child.stdout.on("data", (d: Buffer) => {
      if (stdout.length < OUTPUT_CAP) stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < OUTPUT_CAP) stderr += d.toString();
    });

    const finish = (exitCode: number | null) => {
      clearTimeout(timer);
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
    child.on("close", (code) => finish(code));
  });
}
