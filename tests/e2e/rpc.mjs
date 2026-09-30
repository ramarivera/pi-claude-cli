import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, relative, resolve } from "node:path";
import { publicAssistant, publicStats } from "./diagnostics.mjs";

export const MODEL = "claude-haiku-4-5-20251001";
export const CASES = ["pi+cli", "pi+sdk", "omp+cli", "omp+sdk"];
export const ROOT = realpathSync(new URL("../..", import.meta.url));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function scratchRoot(env = process.env) {
  const project = join(homedir(), "dev/agentic-scratchpads/pi-claude-cli");
  const branch =
    spawnSync("git", ["branch", "--show-current"], {
      cwd: ROOT,
      encoding: "utf8",
    }).stdout?.trim() || "main";
  const root = env.PI_CLAUDE_E2E_SCRATCH_DIR
    ? resolve(env.PI_CLAUDE_E2E_SCRATCH_DIR)
    : join(
        project,
        branch
          .split("/")
          .at(-1)
          .replace(/[^a-zA-Z0-9._-]/g, "_"),
      );
  assert.ok(
    root.startsWith(project + "/"),
    "PI_CLAUDE_E2E_SCRATCH_DIR must be under the project scratchpads directory",
  );
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}

export function scratchDirectory(prefix, env = process.env) {
  return mkdtempSync(join(scratchRoot(env), prefix));
}

export function receiptDirectory(env = process.env) {
  const root = scratchRoot(env);
  const directory = resolve(
    env.PI_CLAUDE_E2E_RECEIPT_DIR ?? join(root, "receipts"),
  );
  assert.ok(
    directory.startsWith(
      join(homedir(), "dev/agentic-scratchpads/pi-claude-cli") + "/",
    ),
    "Receipts must remain under project scratchpads",
  );
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

export function assertSocketCapacity(sandbox) {
  const path = join(sandbox, "t", "pcc-cli-XXXXXX", "host.sock");
  const bytes = Buffer.byteLength(path);
  assert.ok(
    bytes <= 107,
    `Scratch path exceeds Linux Unix socket capacity (${bytes} > 107 bytes): ${path}`,
  );
  return bytes;
}

export function executable(name, env = process.env) {
  const found = name.includes("/")
    ? [name]
    : (env.PATH ?? "").split(delimiter).map((dir) => join(dir, name));
  const path = found.find((candidate) => existsSync(candidate));
  assert.ok(path, `Missing executable prerequisite: ${name}`);
  accessSync(path, constants.X_OK);
  // Preserve argv[0] dispatch for mise symlinks; resolving them executes `mise`.
  return resolve(path);
}

export function hostEnvironment(
  host,
  driver,
  sandbox,
  nonce,
  env = process.env,
) {
  const output = { ...env };
  const mode = output.PI_CLAUDE_AUTH ?? "claude-login";
  assert.ok(
    ["claude-login", "api-key"].includes(mode),
    "Unsupported auth mode",
  );
  const key = output.ANTHROPIC_API_KEY;
  const base = output.ANTHROPIC_BASE_URL;
  // Login keeps official CLAUDE_CONFIG_DIR; no credential contents are inspected.
  for (const name of Object.keys(output)) {
    if (
      /^(ANTHROPIC_|CLAUDE_CODE_|CLAUDE_AGENT_|AWS_|AZURE_|GOOGLE_|VERTEX_|BEDROCK_|PI_CLAUDE_|PCC_E2E_)/.test(
        name,
      )
    )
      delete output[name];
  }
  if (mode === "api-key") {
    assert.ok(key, "Explicit api-key mode requires ANTHROPIC_API_KEY");
    output.ANTHROPIC_API_KEY = key;
    if (base) output.ANTHROPIC_BASE_URL = base;
  }
  delete output.BUN_BE_BUN;
  delete output.CLAUDECODE;
  Object.assign(output, {
    PI_CLAUDE_DRIVER: driver,
    PI_CLAUDE_AUTH: mode,
    PI_CLAUDE_EXECUTABLE: env.PI_CLAUDE_EXECUTABLE ?? "claude",
    PI_CLAUDE_MAX_TURNS: "8",
    PI_CLAUDE_MAX_BUDGET_USD: "0.25",
    PI_CLAUDE_MAX_OUTPUT_TOKENS: "512",
    PI_CLAUDE_TOOL_TIMEOUT_MS: "15000",
    PI_CLAUDE_SHUTDOWN_TIMEOUT_MS: "3000",
    PI_CLAUDE_INTERNAL_TOOLS: "[]",
    PCC_E2E_NONCE: nonce,
    PCC_E2E_OBSERVATIONS: join(sandbox, "observations.jsonl"),
    TMPDIR: join(sandbox, "t"),
    PI_CODING_AGENT_DIR: join(sandbox, `${host}-agent`),
    PI_CONFIG_DIR: relative(homedir(), join(sandbox, "omp-root")),
    OMP_PROFILE: "",
    PI_PROFILE: "",
    PI_EDIT_VARIANT: "hashline",
  });
  return output;
}

export function preflight(host, env) {
  const binary = executable(
    host === "pi"
      ? (process.env.PI_E2E_BIN ?? "pi")
      : (process.env.OMP_E2E_BIN ??
          "/home/ramarivera/.local/share/mise/installs/github-can1357-oh-my-pi/latest/omp"),
  );
  if (host === "omp")
    assert.equal(
      readFileSync(binary).subarray(0, 4).toString("hex"),
      "7f454c46",
      "OMP requires the compiled ELF host",
    );
  const version = spawnSync(binary, ["--version"], {
    env,
    encoding: "utf8",
    timeout: 10000,
  });
  assert.equal(version.status, 0, "Host --version prerequisite failed");
  const expected = host === "pi" ? "0.99.1" : "18.4.4";
  assert.match(
    version.stdout,
    new RegExp(`(^|\\D)${expected.replaceAll(".", "\\.")}(\\D|$)`),
    "Unexpected host version",
  );
  const claude = executable(env.PI_CLAUDE_EXECUTABLE, env);
  const official = spawnSync(claude, ["--version"], {
    env,
    encoding: "utf8",
    timeout: 10000,
  });
  assert.equal(official.status, 0, "Claude --version prerequisite failed");
  assert.match(
    official.stdout,
    /2\.1\.285\b/,
    "Unexpected official Claude version",
  );
  const sdk = JSON.parse(
    readFileSync(
      join(ROOT, "node_modules/@anthropic-ai/claude-agent-sdk/package.json"),
      "utf8",
    ),
  );
  assert.equal(sdk.version, "0.3.285", "Unexpected SDK version");
  if (env.PI_CLAUDE_AUTH === "claude-login") {
    const auth = spawnSync(claude, ["auth", "status"], {
      env,
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(
      auth.status,
      0,
      "Official Claude login prerequisite failed (auth output withheld)",
    );
    const status = JSON.parse(auth.stdout);
    assert.equal(status.loggedIn, true, "Official Claude isn't logged in");
  }
  return {
    binary,
    hostVersion: expected,
    claudeVersion: "2.1.285",
    sdkVersion: sdk.version,
    hostSha256: createHash("sha256").update(readFileSync(binary)).digest("hex"),
    auth: {
      mode: env.PI_CLAUDE_AUTH,
      ...(env.PI_CLAUDE_AUTH === "claude-login" ? { loggedIn: true } : {}),
    },
  };
}

export function hostArgs(host, sandbox, marker) {
  const shared = [
    "--mode",
    "rpc",
    "--no-extensions",
    "--no-skills",
    "-e",
    join(ROOT, `entrypoints/${host}.ts`),
    "-e",
    join(ROOT, `tests/e2e/${host}-tools.ts`),
    "--session-dir",
    join(sandbox, `${host}-sessions`),
    "--system-prompt",
    marker,
  ];
  return host === "pi"
    ? [
        ...shared,
        "--no-prompt-templates",
        "--no-themes",
        "--provider",
        "pi-claude-cli",
        "--model",
        MODEL,
        "--thinking",
        "off",
      ]
    : [
        ...shared,
        "--no-ui",
        "--no-rules",
        "--no-title",
        "--no-lsp",
        "--no-pty",
        "--auto-approve",
        "--tools",
        "read,write,bash,edit,pcc_sentinel,pcc_slow",
        "--model",
        `pi-claude-cli/${MODEL}`,
        "--thinking",
        "off",
      ];
}

function processes() {
  const result = new Map();
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      result.set(Number(name), {
        state: fields[0],
        parent: Number(fields[1]),
        start: fields[19],
      });
    } catch {
      /* A process can exit during the snapshot. */
    }
  }
  return result;
}

export class RpcHost {
  frames = [];
  responses = [];
  commands = [];
  tracked = new Map();
  serial = 0;
  closed = false;
  parseError;
  constructor(binary, args, env, cwd, { signal, deadline = Infinity } = {}) {
    this.signal = signal;
    this.deadline = deadline;
    this.child = spawn(binary, args, {
      env,
      cwd,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.on("error", (error) => {
      this.parseError = error;
    });
    this.child.on("exit", () => {
      this.closed = true;
    });
    this.child.stdin.on("error", () => {
      this.parseError = new Error("Host RPC stdin closed unexpectedly");
    });
    let buffer = "";
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        try {
          this.frames.push(JSON.parse(line));
        } catch {
          this.parseError = new Error("Host emitted non-JSON RPC stdout");
        }
      }
    });
    // Drain stderr, which may contain auth/account diagnostics; never persist it.
    this.child.stderr.resume();
    this.monitor = setInterval(() => this.track(), 100);
    this.track();
  }
  track() {
    const snapshot = processes();
    let changed = true;
    const owned = new Set([
      this.child.pid,
      ...[...this.tracked]
        .filter(([pid, start]) => snapshot.get(pid)?.start === start)
        .map(([pid]) => pid),
    ]);
    while (changed) {
      changed = false;
      for (const [pid, stat] of snapshot) {
        if (owned.has(stat.parent) && !owned.has(pid)) {
          owned.add(pid);
          changed = true;
        }
      }
    }
    for (const pid of owned)
      if (snapshot.has(pid)) this.tracked.set(pid, snapshot.get(pid).start);
  }
  rememberBaseline() {
    this.track();
    this.baseline = new Set(this.tracked.keys());
  }
  async transportIdle(temp) {
    await this.wait(
      () => {
        this.track();
        const snapshot = processes();
        const alive = [...this.tracked].filter(
          ([pid, start]) =>
            pid !== this.child.pid &&
            !this.baseline?.has(pid) &&
            snapshot.get(pid)?.start === start &&
            snapshot.get(pid)?.state !== "Z",
        );
        const files = readdirSync(temp).filter((name) =>
          name.startsWith("pcc-cli-"),
        );
        return alive.length === 0 && files.length === 0;
      },
      "natural Claude child and private MCP cleanup",
      10000,
    );
    return {
      childrenGone: true,
      privateFiles: [],
      hostAlive: !this.closed,
      forced: false,
    };
  }
  async wait(predicate, description, timeout = 20000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      this.signal?.throwIfAborted();
      assert.ok(
        Date.now() < this.deadline,
        "Actual case exceeded its 180 second wall-clock bound",
      );
      if (this.parseError) throw this.parseError;
      const extensionError = this.frames.find(
        (frame) => frame.type === "extension_error",
      );
      assert.ok(
        !extensionError,
        `Native extension error: ${extensionError?.event ?? "loading"}`,
      );
      const value = predicate();
      if (value) return value;
      assert.ok(
        !this.closed,
        `RPC host exited while waiting for ${description}`,
      );
      await delay(25);
    }
    throw new Error(
      `Timed out waiting for ${description}; RPC event types: ${this.frames
        .slice(-12)
        .map((frame) => frame.type)
        .join(",")}`,
    );
  }
  send(type, data = {}) {
    this.signal?.throwIfAborted();
    assert.ok(!this.closed, `Cannot send ${type} to a closed RPC host`);
    const id = `e2e-${++this.serial}`;
    this.commands.push({ id, type, ...data });
    this.child.stdin.write(JSON.stringify({ id, type, ...data }) + "\n");
    return id;
  }
  async command(type, data = {}, timeout = 20000) {
    const id = this.send(type, data);
    const frame = await this.wait(
      () =>
        this.frames.find((item) => item.type === "response" && item.id === id),
      type,
      timeout,
    );
    assert.equal(
      frame.success,
      true,
      `RPC ${type} rejected: ${frame.error ?? "unknown"}`,
    );
    return frame.data;
  }
  async settled(host, id, since) {
    if (host === "omp") {
      const result = await this.wait(
        () =>
          this.frames
            .slice(since)
            .find((frame) => frame.type === "prompt_result" && frame.id === id),
        "correlated OMP prompt_result",
        90000,
      );
      assert.notEqual(result.status, "error", "OMP prompt failed");
      await this.wait(
        () =>
          this.frames
            .slice(since)
            .some((frame) => frame.type === "session_settled"),
        "OMP session_settled",
      );
      const state = await this.command("get_state");
      assert.equal(state.isSettled, true, "OMP session isn't settled");
      return result;
    }
    await this.wait(
      () =>
        this.frames
          .slice(since)
          .some((frame) => frame.type === "agent_settled"),
      "Pi agent_settled",
      90000,
    );
    const state = await this.command("get_state");
    assert.equal(state.isStreaming, false, "Pi session is still streaming");
    return state;
  }
  async prompt(host, message) {
    const since = this.frames.length;
    const id = this.send("prompt", { message });
    try {
      await this.settled(host, id, since);
      const { text } = await this.command("get_last_assistant_text");
      await this.captureResponse(id, since, text);
      assert.ok(
        typeof text === "string" && text.length > 0,
        "Missing assistant text",
      );
      return text;
    } catch (error) {
      if (!this.responses.some((item) => item.promptId === id))
        await this.captureResponse(id, since, undefined, error);
      throw error;
    }
  }
  async captureResponse(id, since, text, error) {
    const diagnostic = {
      promptId: id,
      text,
      ...(error ? { error: { name: error.name, message: error.message } } : {}),
    };
    const assistant = this.frames
      .slice(since)
      .filter(
        (frame) =>
          frame.type === "message_end" && frame.message?.role === "assistant",
      )
      .at(-1)?.message;
    diagnostic.assistant = publicAssistant(assistant);
    for (const command of ["get_messages", "get_session_stats"]) {
      try {
        const value = await this.command(command, {}, 1500);
        if (command === "get_messages")
          diagnostic.assistant =
            publicAssistant(
              value.messages
                ?.filter((item) => item.role === "assistant")
                .at(-1),
            ) ?? diagnostic.assistant;
        else diagnostic.stats = publicStats(value);
      } catch (failure) {
        (diagnostic.unavailable ??= []).push({ command, reason: failure.name });
      }
    }
    diagnostic.text ??= diagnostic.assistant?.text;
    this.responses.push(diagnostic);
    return diagnostic;
  }
  assistantMessages() {
    return this.frames
      .filter((frame) => frame.type === "message_end")
      .map((frame) => publicAssistant(frame.message))
      .filter(Boolean);
  }
  async close() {
    this.track();
    try {
      const signal = (pid, sig) => {
        try {
          process.kill(pid, sig);
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
      };
      this.child.stdin.end();
      for (let n = 0; !this.closed && n < 60; n++) await delay(50);
      const remaining = () => {
        const snapshot = processes();
        return [...this.tracked]
          .filter(
            ([pid, start]) =>
              snapshot.get(pid)?.start === start &&
              snapshot.get(pid)?.state !== "Z",
          )
          .map(([pid]) => pid);
      };
      // Supported host SIGTERM must reach only the host. Its adapter owns child
      // shutdown; signalling the whole group here would hide SDK cleanup leaks.
      if (!this.closed) signal(this.child.pid, "SIGTERM");
      for (let n = 0; !this.closed && n < 60; n++) await delay(50);
      const forcedChildren = new Set();
      const hostRequiredKill = !this.closed;
      if (hostRequiredKill) {
        for (const pid of remaining())
          if (pid !== this.child.pid) forcedChildren.add(pid);
        signal(-this.child.pid, "SIGKILL");
      }
      for (const pid of remaining()) {
        if (pid !== this.child.pid) forcedChildren.add(pid);
        try {
          process.kill(pid, "SIGTERM");
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
      }
      for (let n = 0; remaining().length && n < 60; n++) await delay(50);
      for (const pid of remaining()) {
        if (pid !== this.child.pid) forcedChildren.add(pid);
        try {
          process.kill(pid, "SIGKILL");
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
      }
      for (let n = 0; remaining().length && n < 20; n++) await delay(50);
      assert.deepEqual(
        remaining(),
        [],
        "Owned host/Claude children survived cleanup",
      );
      return {
        observedPids: [...this.tracked.keys()],
        forcedChildren: [...forcedChildren],
        hostRequiredKill,
        survivors: [],
      };
    } finally {
      clearInterval(this.monitor);
    }
  }
}
