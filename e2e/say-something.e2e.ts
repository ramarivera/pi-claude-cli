import path from "node:path";
import { fileURLToPath } from "node:url";
import spawn from "cross-spawn";
import { expect, test } from "vitest";

// Live e2e: spawn a real `pi` process, load THIS checkout's extension via the
// local `.pi` self-import shim (no npm install required), select a Claude model
// through the pi-claude-cli provider, and assert the model actually replies.
//
// This is the regression guard for the "empty response" failure mode: if the
// provider bridge silently swallows the Claude CLI turn, stdout comes back empty
// and this test fails instead of looking like a successful no-op.
//
// NOTE: uses async spawn (not spawn.sync). The Claude turn can take ~90s; a
// synchronous block that long starves vitest's worker RPC and trips a spurious
// "Timeout calling onTaskUpdate" error. Awaiting `close` keeps the loop free.

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const shim = path.join(
  repoRoot,
  ".pi",
  "extensions",
  "pi-claude-cli",
  "index.ts",
);

// Cheap model by default; override with PI_CLAUDE_E2E_MODEL for other models.
const model = process.env.PI_CLAUDE_E2E_MODEL ?? "claude-haiku-4-5";

interface PiResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
}

function runPi(args: string[], timeoutMs: number): Promise<PiResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("pi", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        code,
        signal: timedOut ? "SIGKILL" : signal,
      });
    });
  });
}

test("pi loads the local extension and the Claude model replies with content", async () => {
  const { stdout, stderr, code, signal } = await runPi(
    [
      "-p",
      "--no-extensions", // don't load globally-installed packages (avoids duplicate provider)
      "--extension",
      shim, // load only this checkout via the self-import shim
      "--no-session",
      "--offline",
      "--no-tools", // force a plain text answer instead of tool use
      "--thinking",
      "low",
      "--model",
      `pi-claude-cli/${model}`,
      "Reply with exactly one word: PONG",
    ],
    170_000,
  );

  if (!stdout.includes("PONG")) {
    console.error("pi stdout:\n", stdout);
    console.error("pi stderr:\n", stderr);
    console.error(`pi exited code=${code} signal=${signal}`);
  }

  expect(stdout.trim().length).toBeGreaterThan(0);
  expect(stdout).toContain("PONG");
});
