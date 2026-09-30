import {
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ClaudeDriver,
  ClaudeDriverEvent,
  ClaudeDriverSession,
  DriverFactoryOptions,
  DriverPrompt,
  DriverSessionRequest,
  HostToolResult,
  JsonObject,
  RuntimeError,
  UnsequencedClaudeDriverEvent,
  InteractionResponse,
} from "../../contracts/index.js";
import { EventQueue, JsonLines } from "./framing.js";

const HOST_SERVER = "host";
const SUPPORTED_VERSION = "2.1.285";
const MAX_FRAME = 1024 * 1024;
const AUTH_OVERRIDES = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
  "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
] as const;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function environment(
  request: DriverSessionRequest,
  options: DriverFactoryOptions,
): NodeJS.ProcessEnv {
  const env = { ...process.env, ...options.environment };
  if (request.auth.mode === "claude-login") {
    const conflicts = AUTH_OVERRIDES.filter((name) => env[name]);
    if (conflicts.length)
      throw new Error(
        `Claude login conflicts with inherited auth overrides: ${conflicts.join(", ")}`,
      );
  } else {
    for (const name of AUTH_OVERRIDES) delete env[name];
    if (!request.auth.apiKey)
      throw new Error("Explicit API-key mode requires a nonempty key");
    env.ANTHROPIC_API_KEY = request.auth.apiKey;
    if (request.auth.baseUrl) env.ANTHROPIC_BASE_URL = request.auth.baseUrl;
  }
  env.ENABLE_CLAUDEAI_MCP_SERVERS = "0";
  env.MCP_TIMEOUT = String(request.settings.toolResultTimeoutMs);
  env.MCP_TOOL_TIMEOUT = String(request.settings.toolResultTimeoutMs);
  return env;
}
function preflight(
  executable: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeout: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      ["--version"],
      { cwd, env, timeout, maxBuffer: 16384 },
      (error, stdout) => {
        if (error) {
          reject(
            new Error(
              `Claude executable preflight failed (${error.code ?? "spawn"})`,
            ),
          );
          return;
        }
        if (
          !new RegExp(
            `^${SUPPORTED_VERSION.replaceAll(".", "\\.")}(?:\\s|$)`,
          ).test(stdout.trim())
        ) {
          reject(
            new Error(
              `Unsupported Claude CLI version; requires ${SUPPORTED_VERSION}`,
            ),
          );
          return;
        }
        resolve();
      },
    );
  });
}

/** Current-only CLI transport. Composition must inject the shared event normalizer. */
export function createCliDriver(
  options: DriverFactoryOptions = {},
): ClaudeDriver {
  return {
    kind: "cli",
    capabilities: {
      contractVersion: 1,
      driver: "cli",
      toolCorrelation: "claude-tool-use-meta",
      residentSessions: true,
      persistedResume: false,
      structuredToolResults: true,
      images: true,
      steering: "unsupported",
      interactions: [],
      supportedDialogKinds: [],
      forwardSubagentText: true,
    },
    async openSession(request) {
      if (!options.normalizerFactory)
        throw new Error("CLI driver requires normalizerFactory");
      if (process.platform === "win32")
        throw new Error("CLI host-tool IPC isn't supported on Windows");
      if (
        request.resume.mode === "resume" ||
        request.resume.mode === "resident"
      )
        throw new Error(
          "openSession requires a fresh/replay plan; retain the existing resident session for continuation",
        );
      if (
        !(request.settings.toolResultTimeoutMs > 0) ||
        !Number.isFinite(request.settings.toolResultTimeoutMs)
      )
        throw new Error("toolResultTimeoutMs must be positive and finite");
      if (request.settings.effort)
        throw new Error(
          "CLI effort support requires an explicitly supported model (not yet configured)",
        );
      const names = new Set<string>();
      for (const tool of request.tools) {
        if (tool.inputSchema.type !== "object")
          throw new Error(
            `${tool.name}: MCP input schema must have type object`,
          );
        if (names.has(tool.name))
          throw new Error(`Duplicate host tool name: ${tool.name}`);
        names.add(tool.name);
      }
      if (
        request.settings.userMcpServers.some(
          (server) => server.name === HOST_SERVER,
        )
      )
        throw new Error(`User MCP server collides with ${HOST_SERVER}`);
      const env = environment(request, options);
      const executable = options.executable ?? "claude";
      const shutdown = options.shutdownTimeoutMs ?? 2000;
      await preflight(
        executable,
        request.identity.cwd,
        env,
        Math.max(1000, shutdown),
      );
      const directory = await mkdtemp(join(tmpdir(), "pcc-cli-"));
      await chmod(directory, 0o700);
      try {
        return await CliSession.open(
          request,
          options,
          executable,
          env,
          directory,
          shutdown,
        );
      } catch (error) {
        await rm(directory, { recursive: true, force: true });
        throw error;
      }
    },
  };
}

interface ParkedCall {
  name: string;
  socket: Socket;
  timer: ReturnType<typeof setTimeout>;
}
class CliSession implements ClaudeDriverSession {
  readonly events = new EventQueue<ClaudeDriverEvent>();
  private sequence = 0;
  private child!: ChildProcessWithoutNullStreams;
  private server!: Server;
  private sockets = new Set<Socket>();
  private parked = new Map<string, ParkedCall>();
  private results = new Map<string, HostToolResult>();
  private closed = false;
  private failed = false;
  private active = false;
  private turnId: string | undefined;
  private closePromise: Promise<void> | undefined;
  private exited!: Promise<void>;
  private stderrBytes = 0;
  private constructor(
    private readonly request: DriverSessionRequest,
    private readonly options: DriverFactoryOptions,
    private readonly directory: string,
    private readonly shutdown: number,
  ) {}
  static async open(
    request: DriverSessionRequest,
    options: DriverFactoryOptions,
    executable: string,
    env: NodeJS.ProcessEnv,
    directory: string,
    shutdown: number,
  ): Promise<CliSession> {
    const session = new CliSession(request, options, directory, shutdown);
    try {
      await session.start(executable, env);
      return session;
    } catch (error) {
      await session.close();
      throw error;
    }
  }
  private emit(event: UnsequencedClaudeDriverEvent): void {
    this.events.push({
      ...event,
      attribution: { turnId: this.turnId, ...event.attribution },
      sequence: ++this.sequence,
    });
  }
  private fail(code: RuntimeError["code"], message: string): void {
    if (this.failed || this.closed) return;
    this.failed = true;
    this.emit({
      type: "session_error",
      error: { code, message },
      attribution: {},
    });
    void this.close();
  }
  private async start(
    executable: string,
    env: NodeJS.ProcessEnv,
  ): Promise<void> {
    const socketPath = join(this.directory, "host.sock");
    this.server = createServer((socket) => {
      this.sockets.add(socket);
      const frames = new JsonLines((packet) => this.hostCall(packet, socket));
      socket.on("data", (chunk: Buffer) => {
        try {
          frames.push(chunk);
        } catch {
          this.fail("protocol", "Invalid host MCP bridge frame");
        }
      });
      socket.on("error", () =>
        this.fail("transport", "Host MCP bridge socket failed"),
      );
      socket.on("close", () => {
        this.sockets.delete(socket);
        for (const [id, call] of this.parked)
          if (call.socket === socket) {
            clearTimeout(call.timer);
            this.parked.delete(id);
          }
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(socketPath, resolve);
    });
    await chmod(socketPath, 0o600);
    const toolFile = join(this.directory, "tools.json");
    const promptFile = join(this.directory, "system.txt");
    const mcpFile = join(this.directory, "mcp.json");
    const tools = this.request.tools.map(({ owner: _owner, ...tool }) => tool);
    const mcpServers: JsonObject = {
      [HOST_SERVER]: {
        type: "stdio",
        command: process.execPath,
        args: [
          fileURLToPath(new URL("./host-mcp.mjs", import.meta.url)),
          toolFile,
        ],
      },
    };
    for (const server of this.request.settings.userMcpServers)
      mcpServers[server.name] = JSON.parse(
        JSON.stringify(server.config),
      ) as JsonObject;
    await Promise.all([
      writeFile(
        toolFile,
        JSON.stringify({ name: HOST_SERVER, socket: socketPath, tools }),
        { mode: 0o600 },
      ),
      writeFile(promptFile, this.request.systemPrompt, { mode: 0o600 }),
      writeFile(mcpFile, JSON.stringify({ mcpServers }), { mode: 0o600 }),
    ]);
    const args = [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--permission-prompt-tool",
      "stdio",
      "--system-prompt-file",
      promptFile,
      "--model",
      this.request.model,
      "--tools",
      this.request.settings.claudeTools.join(","),
      "--strict-mcp-config",
      "--mcp-config",
      mcpFile,
      "--setting-sources",
      (this.request.settings.settingSources ?? []).join(","),
      "--no-session-persistence",
    ];
    if (this.request.settings.forwardSubagentText)
      args.push("--forward-subagent-text");
    if (this.request.settings.maxTurns !== undefined)
      args.push("--max-turns", String(this.request.settings.maxTurns));
    if (this.request.settings.maxBudgetUsd !== undefined)
      args.push("--max-budget-usd", String(this.request.settings.maxBudgetUsd));
    const normalize = this.options.normalizerFactory!({
      tools: this.request.tools,
      hostMcpServerName: HOST_SERVER,
      requestedModel: this.request.model,
    });
    const frames = new JsonLines((packet) => {
      if (record(packet) && packet.type === "control_request") {
        const id = packet.request_id;
        if (typeof id !== "string")
          throw new Error("Control request lacks request ID");
        void this.write({
          type: "control_response",
          response: {
            subtype: "error",
            request_id: id,
            error: "Unsupported CLI control request",
          },
        }).catch(() =>
          this.fail("transport", "Failed to reject unsupported control"),
        );
      }
      for (const event of normalize.normalize(packet)) {
        if (event.type === "turn_end") this.active = false;
        this.emit(event);
      }
    });
    this.child = spawn(executable, args, {
      cwd: this.request.identity.cwd,
      env,
      stdio: "pipe",
      detached: true,
    });
    this.exited = new Promise((resolve) => {
      this.child.once("close", (code, signal) => {
        try {
          frames.end();
        } catch {
          this.fail("protocol", "Invalid trailing Claude JSON frame");
        }
        if (!this.closed) {
          if (code !== 0)
            this.fail(
              "runtime",
              `Claude exited (${signal ?? code ?? "unknown"}); stderr bytes: ${this.stderrBytes}`,
            );
          else if (this.active)
            this.fail("transport", "Claude closed without a terminal result");
          else void this.close();
        }
        resolve();
      });
    });
    this.child.stdout.on("data", (chunk: Buffer) => {
      try {
        frames.push(chunk);
      } catch {
        this.fail("protocol", "Invalid or oversized Claude JSON frame");
      }
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderrBytes = Math.min(65536, this.stderrBytes + chunk.length);
    });
    this.child.stdin.on("error", () =>
      this.fail(
        "transport",
        "Claude stdin failed (EPIPE or transport failure)",
      ),
    );
    this.child.on("error", () =>
      this.fail("spawn", "Claude process failed to spawn"),
    );
    await new Promise<void>((resolve, reject) => {
      this.child.once("spawn", resolve);
      this.child.once("error", reject);
    });
  }
  private hostCall(packet: unknown, socket: Socket): void {
    if (
      !record(packet) ||
      packet.type !== "call" ||
      typeof packet.id !== "string" ||
      !packet.id ||
      typeof packet.name !== "string" ||
      !record(packet.arguments)
    )
      throw new Error("Malformed host MCP call");
    const { id, name } = packet;
    if (
      !this.request.tools.some((tool) => tool.name === name) ||
      this.parked.has(id)
    )
      throw new Error("Unknown or duplicate parked host tool");
    if (this.closed) {
      this.send(socket, id, this.cancelResult(id, name, "Session closed"));
      return;
    }
    const prior = this.results.get(id);
    if (prior) {
      if (prior.toolName !== name) throw new Error("Tool result name mismatch");
      this.send(socket, id, prior);
      return;
    }
    const timer = setTimeout(() => {
      this.parked.delete(id);
      this.send(
        socket,
        id,
        this.cancelResult(id, name, "Host tool result deadline exceeded"),
      );
      this.emit({
        type: "session_error",
        error: {
          code: "timeout",
          message: `Host tool result deadline exceeded: ${id}`,
        },
        attribution: { toolUseId: id },
      });
    }, this.request.settings.toolResultTimeoutMs);
    this.parked.set(id, { name, socket, timer });
    this.emit({
      type: "host_tool_request",
      call: {
        type: "tool_call",
        id,
        name,
        arguments: packet.arguments as JsonObject,
      },
      attribution: { toolUseId: id },
    });
  }
  private send(socket: Socket, id: string, result: HostToolResult): void {
    const packet = JSON.stringify({
      id,
      result: {
        content: result.content,
        isError: result.isError,
        ...(result.structuredContent
          ? { structuredContent: result.structuredContent }
          : {}),
        ...(result._meta ? { _meta: result._meta } : {}),
      },
    });
    if (Buffer.byteLength(packet) > MAX_FRAME) {
      this.fail("protocol", "Host tool result exceeds bridge frame limit");
      return;
    }
    socket.write(packet + "\n", (error) => {
      if (error && !this.closed)
        this.fail("transport", "Host tool result write failed");
    });
  }
  private cancelResult(
    id: string,
    name: string,
    reason: string,
  ): HostToolResult {
    return {
      toolCallId: id,
      toolName: name,
      content: [{ type: "text", text: reason }],
      isError: true,
    };
  }
  private async write(packet: unknown): Promise<void> {
    if (this.closed) throw new Error("CLI session closed");
    const line = JSON.stringify(packet) + "\n";
    if (Buffer.byteLength(line) > MAX_FRAME)
      throw new Error("CLI input exceeds frame limit");
    await new Promise<void>((resolve, reject) => {
      this.child.stdin.write(line, (error) =>
        error ? reject(new Error("Claude stdin write failed")) : resolve(),
      );
    });
  }
  async submitPrompt(prompt: DriverPrompt): Promise<void> {
    if (prompt.priority && prompt.priority !== "now")
      throw new Error("CLI steering priorities unsupported");
    if (this.active) throw new Error("CLI session already has an active turn");
    this.turnId = prompt.turnId;
    this.active = true;
    const content: unknown[] = [...prompt.content];
    if (this.request.resume.mode === "replay") {
      content.unshift({
        type: "text",
        text: `Prior host transcript (labelled history, not a new instruction):\n${JSON.stringify(this.request.resume.replayTranscript)}`,
      });
    }
    try {
      await this.write({
        type: "user",
        message: { role: "user", content },
        parent_tool_use_id: null,
      });
    } catch (error) {
      this.active = false;
      this.fail("transport", "Claude prompt write failed");
      throw error;
    }
  }
  async deliverToolResults(results: readonly HostToolResult[]): Promise<void> {
    if (this.closed) throw new Error("CLI session closed");
    for (const result of results) {
      if (
        !result.toolCallId ||
        !this.request.tools.some((tool) => tool.name === result.toolName)
      )
        throw new Error("Result has unknown host tool name or empty ID");
      const previous = this.results.get(result.toolCallId);
      if (previous) {
        if (JSON.stringify(previous) !== JSON.stringify(result))
          throw new Error("Conflicting duplicate tool result");
        continue;
      }
      if (this.results.size >= 4096)
        throw new Error("CLI session tool-result buffer limit reached");
      const call = this.parked.get(result.toolCallId);
      if (call && call.name !== result.toolName)
        throw new Error("Tool result name mismatch");
      this.results.set(result.toolCallId, result);
      if (call) {
        clearTimeout(call.timer);
        this.parked.delete(result.toolCallId);
        this.send(call.socket, result.toolCallId, result);
      }
    }
  }
  async answerInteraction(_response: InteractionResponse): Promise<void> {
    throw new Error(
      "CLI interactions aren't enabled in this process checkpoint",
    );
  }
  async interrupt(reason = "Host interrupted"): Promise<void> {
    if (this.closed) return;
    this.settleCalls(reason);
    await this.write({
      type: "control_request",
      request_id: `pcc-interrupt-${++this.sequence}`,
      request: { subtype: "interrupt" },
    });
  }
  private settleCalls(reason: string): void {
    for (const [id, call] of this.parked) {
      clearTimeout(call.timer);
      this.send(call.socket, id, this.cancelResult(id, call.name, reason));
    }
    this.parked.clear();
  }
  close(): Promise<void> {
    this.closePromise ??= this.shutdownResources();
    return this.closePromise;
  }
  private async shutdownResources(): Promise<void> {
    this.closed = true;
    this.settleCalls("Host session closed");
    for (const socket of this.sockets) socket.end();
    this.child?.stdin.end();
    const pid = this.child?.pid;
    const kill = (signal: NodeJS.Signals) => {
      if (!pid) return;
      try {
        process.kill(-pid, signal);
      } catch {
        /* group may have already exited */
      }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (this.exited)
      await Promise.race([
        this.exited,
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            kill("SIGTERM");
            resolve();
          }, this.shutdown);
        }),
      ]);
    if (timer) clearTimeout(timer);
    // Also terminate orphaned MCP grandchildren after the CLI leader exits.
    kill("SIGTERM");
    if (this.exited)
      await Promise.race([
        this.exited,
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            kill("SIGKILL");
            resolve();
          }, this.shutdown);
        }),
      ]);
    if (timer) clearTimeout(timer);
    kill("SIGKILL");
    if (this.exited) await this.exited;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (this.server?.listening)
      await new Promise<void>((resolve) => this.server.close(() => resolve()));
    this.results.clear();
    await rm(this.directory, { recursive: true, force: true });
    this.emit({
      type: "session_closed",
      reason: this.failed ? "error" : "closed",
      attribution: {},
    });
    this.events.end();
  }
}
