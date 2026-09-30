import {
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { StringDecoder } from "node:string_decoder";
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
import { ControlChannel } from "./controls.js";

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
  "CLAUDE_CODE_API_KEY_HELPER",
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
  if (request.settings.effort !== undefined)
    env.CLAUDE_CODE_EFFORT_LEVEL = request.settings.effort;
  // Claude 2.1.280 otherwise truncates native MCP instructions at 2048 characters.
  env.CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH = String(
    Math.max(2048, ...request.tools.map((tool) => tool.description.length)),
  );
  if (request.settings.maxOutputTokens !== undefined)
    env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(
      request.settings.maxOutputTokens,
    );
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
      interactions: ["permission", "elicitation"],
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
        !Number.isFinite(request.settings.toolResultTimeoutMs) ||
        request.settings.toolResultTimeoutMs > 2147483647
      )
        throw new Error("toolResultTimeoutMs must be positive and finite");

      if (
        request.settings.maxOutputTokens !== undefined &&
        (!Number.isSafeInteger(request.settings.maxOutputTokens) ||
          request.settings.maxOutputTokens <= 0)
      )
        throw new Error("maxOutputTokens must be a positive integer");
      if (
        request.settings.maxTurns !== undefined &&
        (!Number.isSafeInteger(request.settings.maxTurns) ||
          request.settings.maxTurns <= 0)
      )
        throw new Error("maxTurns must be a positive integer");
      if (
        request.settings.maxBudgetUsd !== undefined &&
        (!Number.isFinite(request.settings.maxBudgetUsd) ||
          request.settings.maxBudgetUsd < 0)
      )
        throw new Error("maxBudgetUsd must be finite and nonnegative");
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
      if (
        !Number.isFinite(shutdown) ||
        shutdown < 0 ||
        shutdown > 2147483647 / 5
      )
        throw new Error(
          "shutdownTimeoutMs must be a bounded nonnegative duration",
        );
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
  private settlements = new Map<
    string,
    {
      resolve: () => void;
      timer: ReturnType<typeof setTimeout>;
      socket: Socket;
    }
  >();
  private results = new Map<string, HostToolResult>();
  private closed = false;
  private failed = false;
  private active = false;
  private turnId: string | undefined;
  private closePromise: Promise<void> | undefined;
  private exited!: Promise<void>;
  private stderrBytes = 0;
  private stderr = "";
  private stderrDecoder = new StringDecoder("utf8");
  private diagnosticSecrets: string[] = [];
  private controls!: ControlChannel;
  private replayed = false;
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
      error: {
        code,
        message,
        ...(this.stderr
          ? {
              details: {
                stderr: this.sanitize(this.stderr),
                stderrTruncated: this.stderrBytes > 65536,
              },
            }
          : {}),
      },
      attribution: {},
    });
    void this.close();
  }
  private async start(
    executable: string,
    env: NodeJS.ProcessEnv,
  ): Promise<void> {
    this.diagnosticSecrets = Object.entries(env)
      .filter(
        ([key, value]) =>
          /key|token|secret|password|authorization/i.test(key) &&
          value &&
          value.length >= 4,
      )
      .map(([, value]) => value!);
    this.controls = new ControlChannel(
      this.request,
      (packet) => this.write(packet, true),
      (event) => this.emit(event),
      (message) => this.fail("transport", message),
    );
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
        for (const [id, pending] of this.settlements)
          if (pending.socket === socket) {
            clearTimeout(pending.timer);
            pending.resolve();
            this.settlements.delete(id);
          }
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
    this.server.on("error", () =>
      this.fail("transport", "Host MCP IPC listener failed"),
    );
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
    if (this.request.settings.effort)
      args.push("--effort", this.request.settings.effort);
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
      if (this.controls.handle(packet)) return;
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
    let framesEnded = false;
    let eofTimer: ReturnType<typeof setTimeout> | undefined;
    let groupTimer: ReturnType<typeof setTimeout> | undefined;
    const finishFrames = () => {
      if (framesEnded) return;
      framesEnded = true;
      try {
        frames.end();
      } catch {
        this.fail("protocol", "Invalid trailing Claude JSON frame");
      }
    };
    const killGroup = (signal: NodeJS.Signals) => {
      if (!this.child.pid) return;
      try {
        process.kill(-this.child.pid, signal);
      } catch {
        /* already gone */
      }
    };
    this.child.once("exit", () => {
      if (this.closed) return;
      killGroup("SIGTERM");
      groupTimer = setTimeout(() => killGroup("SIGKILL"), this.shutdown);
    });
    this.exited = new Promise((resolve) => {
      this.child.once("close", (code, signal) => {
        clearTimeout(eofTimer);
        clearTimeout(groupTimer);
        this.stderr += this.stderrDecoder.end();
        finishFrames();
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
    this.child.stdout.once("end", () => {
      finishFrames();
      if (!this.closed)
        eofTimer = setTimeout(
          () => {
            if (this.active)
              this.fail(
                "transport",
                "Claude stdout closed without a terminal result",
              );
            else void this.close();
          },
          Math.max(25, this.shutdown),
        );
    });
    this.child.stdout.on("error", () =>
      this.fail("transport", "Claude stdout failed"),
    );
    this.child.stderr.on("error", () =>
      this.fail("transport", "Claude stderr failed"),
    );
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderrBytes += chunk.length;
      this.stderr = (this.stderr + this.stderrDecoder.write(chunk)).slice(
        -65536,
      );
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
    const initialized = await this.controls.request(
      {
        subtype: "initialize",
        hooks: {},
        supportedDialogKinds: [],
        forwardSubagentText: this.request.settings.forwardSubagentText ?? false,
      },
      Math.max(1000, this.shutdown * 5),
    );
    if (this.request.settings.effort) {
      const models = initialized.models;
      const model = Array.isArray(models)
        ? models.find(
            (row) =>
              record(row) &&
              (row.value === this.request.model ||
                row.resolvedModel === this.request.model),
          )
        : undefined;
      if (
        !record(model) ||
        model.supportsEffort !== true ||
        !Array.isArray(model.supportedEffortLevels) ||
        !model.supportedEffortLevels.includes(this.request.settings.effort)
      )
        throw new Error(
          `Unsupported effort ${this.request.settings.effort} for exact Claude model ${this.request.model}`,
        );
    }
  }
  private sanitize(text: string): string {
    for (const secret of this.diagnosticSecrets)
      text = text.replaceAll(secret, "[redacted]");
    return text
      .replace(/\b(?:sk-ant-|sk-)[A-Za-z0-9_-]+/g, "[redacted]")
      .replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, "$1 [redacted]")
      .replace(
        /((?:api[_-]?key|token|password|secret|authorization)\s*[=:]\s*)[^\s,;]+/gi,
        "$1[redacted]",
      )
      .split("")
      .filter((character) => {
        const code = character.charCodeAt(0);
        return code === 9 || code === 10 || (code >= 32 && code !== 127);
      })
      .join("")
      .slice(-4096);
  }
  private hostCall(packet: unknown, socket: Socket): void {
    if (
      record(packet) &&
      packet.type === "settled" &&
      typeof packet.id === "string"
    ) {
      const pending = this.settlements.get(packet.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.settlements.delete(packet.id);
        pending.resolve();
      }
      return;
    }
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
      const timeoutResult = this.cancelResult(
        id,
        name,
        "Host tool result deadline exceeded",
      );
      this.results.set(id, timeoutResult);
      this.send(socket, id, timeoutResult);
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
  private send(
    socket: Socket,
    id: string,
    result: HostToolResult,
    acknowledge = false,
  ): Promise<void> {
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
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      if (acknowledge) {
        const timer = setTimeout(() => {
          this.settlements.delete(id);
          resolve();
        }, this.shutdown);
        this.settlements.set(id, { resolve, timer, socket });
      }
      socket.write(packet + "\n", (error) => {
        if (error && !this.closed)
          this.fail("transport", "Host tool result write failed");
        if (!acknowledge) resolve();
      });
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
  private async write(packet: unknown, duringClose = false): Promise<void> {
    if (this.closed && !duringClose) throw new Error("CLI session closed");
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
    if (prompt.priority && prompt.priority !== "next")
      throw new Error("CLI steering priorities unsupported");
    if (this.active) throw new Error("CLI session already has an active turn");
    this.turnId = prompt.turnId;
    this.active = true;
    const wire = (
      block: import("../../contracts/index.js").UserContent,
    ): unknown =>
      block.type === "image"
        ? {
            type: "image",
            source: {
              type: "base64",
              media_type: block.mimeType,
              data: block.data,
            },
          }
        : block;
    const content: unknown[] = prompt.content.map(wire);
    if (!this.replayed && this.request.resume.mode === "replay") {
      const history: unknown[] = [];
      for (const message of this.request.resume.replayTranscript) {
        history.push({
          type: "text",
          text: `Prior host transcript ${message.role}: ${JSON.stringify(message)}`,
        });
        for (const block of message.content)
          if (block.type === "image") history.push(wire(block));
      }
      content.unshift(...history);
    }
    try {
      await this.write({
        type: "user",
        message: { role: "user", content },
        parent_tool_use_id: null,
      });
      this.replayed = true;
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
  async answerInteraction(response: InteractionResponse): Promise<void> {
    if (this.closed) throw new Error("CLI session closed");
    await this.controls.answer(response);
  }
  async interrupt(reason = "Host interrupted"): Promise<void> {
    if (this.closed) return;
    await this.settleCalls(reason);
    await this.controls.cancelInteractions(reason);
    await this.controls.request(
      { subtype: "interrupt" },
      Math.max(1000, this.shutdown),
    );
  }
  private async settleCalls(reason: string): Promise<void> {
    const settles: Promise<void>[] = [];
    for (const [id, call] of this.parked) {
      clearTimeout(call.timer);
      const cancellation = this.cancelResult(id, call.name, reason);
      this.results.set(id, cancellation);
      settles.push(this.send(call.socket, id, cancellation, true));
    }
    this.parked.clear();
    await Promise.all(settles);
  }
  close(): Promise<void> {
    this.closePromise ??= this.shutdownResources();
    return this.closePromise;
  }
  private async shutdownResources(): Promise<void> {
    this.closed = true;
    await this.settleCalls("Host session closed");
    try {
      let controlTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          this.controls?.close(),
          new Promise<void>((resolve) => {
            controlTimer = setTimeout(resolve, this.shutdown);
          }),
        ]);
      } finally {
        clearTimeout(controlTimer);
      }
    } catch {
      /* stdin may already have failed; process cleanup still runs */
    }
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
