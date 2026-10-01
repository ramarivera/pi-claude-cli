import type {
  McpServerConfig,
  Options,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  CONTRACT_VERSION,
  type ClaudeDriver,
  type ClaudeDriverEvent,
  type ClaudeDriverSession,
  type ClaudeEventNormalizer,
  type DriverEventPayload,
  type DriverFactoryOptions,
  type DriverPrompt,
  type DriverSessionRequest,
  type EventAttribution,
  type InteractionResponse,
  type HostToolResult,
  type UnsequencedClaudeDriverEvent,
  type UserContent,
} from "../../contracts/index.js";
import { sdkEnvironment } from "./auth.js";
import { AsyncQueue, withinDeadline } from "./queue.js";
import { HostMcpBridge, HOST_MCP_NAME } from "./host-mcp.js";
import { jsonObject } from "./json.js";
import { sdkError } from "./diagnostics.js";
import { PromptReceipts } from "../prompt-receipts.js";
import { hostToolName, hostToolSystemPrompt } from "../host-tool-prompt.js";

/** Narrow public lifecycle seam for labelled offline transport doubles. */
export interface SdkQuery extends AsyncIterable<unknown> {
  interrupt(): Promise<unknown>;
  close(): void;
}
export type SdkQueryFactory = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: Options;
}) => SdkQuery;
export interface SdkModule {
  query: SdkQueryFactory;
}
export interface SdkDriverOptions extends DriverFactoryOptions {
  loadSdk?: () => Promise<SdkModule>;
  query?: SdkQueryFactory;
}

export function createSdkDriver(options: SdkDriverOptions = {}): ClaudeDriver {
  return {
    kind: "sdk",
    capabilities: {
      contractVersion: CONTRACT_VERSION,
      driver: "sdk",
      toolCorrelation: "claude-tool-use-meta",
      residentSessions: true,
      persistedResume: true,
      structuredToolResults: true,
      images: true,
      steering: "active-queue",
      interactions: ["permission", "elicitation"],
      supportedDialogKinds: [],
      forwardSubagentText: true,
    },
    async openSession(request) {
      if (
        request.settings.maxOutputTokens !== undefined &&
        (!Number.isSafeInteger(request.settings.maxOutputTokens) ||
          request.settings.maxOutputTokens <= 0)
      )
        throw new Error("maxOutputTokens must be a positive integer");
      const env = sdkEnvironment(request.auth, options.environment);
      if (request.settings.effort !== undefined)
        env.CLAUDE_CODE_EFFORT_LEVEL = request.settings.effort;
      env.CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH = String(
        Math.max(2048, ...request.tools.map((tool) => tool.description.length)),
      );
      if (request.settings.maxOutputTokens !== undefined)
        env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(
          request.settings.maxOutputTokens,
        );
      if (!options.normalizerFactory) {
        throw new Error(
          "SDK driver requires the shared event normalizer factory",
        );
      }
      const normalizer = options.normalizerFactory({
        tools: request.tools,
        hostMcpServerName: "host",
        requestedModel: request.model,
      });
      const query =
        options.query ?? (await (options.loadSdk ?? loadOfficialSdk)()).query;
      const session = new SdkSession(request, options, normalizer, env);
      await session.start(query);
      return session;
    },
  };
}

async function loadOfficialSdk(): Promise<SdkModule> {
  return import("@anthropic-ai/claude-agent-sdk");
}

interface QueuedPrompt {
  prompt: DriverPrompt;
  uuid?: ReturnType<PromptReceipts["register"]>["uuid"];
  accept(): void;
  reject(error: Error): void;
}
interface PendingInteraction {
  kind: "permission" | "elicitation";
  settle(response: InteractionResponse): void;
  cancel(): void;
}

class SessionIdentityMismatchError extends Error {}

class SdkSession implements ClaudeDriverSession {
  readonly events = new AsyncQueue<ClaudeDriverEvent>();
  private readonly promptReceipts = new PromptReceipts((commandId, state) => {
    if (state === "started") this.active = true;
    this.emit({
      type: "observation",
      family: "diagnostic",
      subtype: "steering-admission",
      data: { commandId, state },
    });
  });
  private readonly prompts = new AsyncQueue<QueuedPrompt>();
  private readonly abortController = new AbortController();
  private readonly interactions = new Map<string, PendingInteraction>();
  private readonly interactionIds = new Set<string>();
  private query!: SdkQuery;
  private pump: Promise<void> = Promise.resolve();
  private readonly hostMcp: HostMcpBridge;
  private sequence = 0;
  private turnId?: string;
  private claudeSessionId?: string;
  private activePrompt?: QueuedPrompt;
  private active = false;
  private closed = false;
  private finished = false;
  private queryClosed = false;
  private closeFailure?: Error;
  private closing?: Promise<void>;

  constructor(
    private readonly request: DriverSessionRequest,
    private readonly options: SdkDriverOptions,
    private readonly normalizer: ClaudeEventNormalizer,
    private readonly env: Record<string, string | undefined>,
  ) {
    this.hostMcp = new HostMcpBridge(
      request.tools,
      request.settings.toolResultTimeoutMs,
      (event) => this.emit(event),
    );
  }

  async start(query: SdkQueryFactory): Promise<void> {
    const { request, options } = this;
    if (request.resume.mode === "resident") {
      await this.hostMcp.close();
      throw new Error(
        "Resident sessions must reuse their existing SDK driver session",
      );
    }
    const mcpServers: Record<string, McpServerConfig> = {
      [HOST_MCP_NAME]: {
        type: "sdk",
        name: HOST_MCP_NAME,
        instance: this.hostMcp.server,
        timeout: Math.max(1000, request.settings.toolResultTimeoutMs),
      },
    };
    for (const server of request.settings.userMcpServers) {
      if (!server.name.trim() || server.name in mcpServers) {
        await this.hostMcp.close();
        throw new Error(
          "SDK MCP server names must be unique and cannot replace host namespace",
        );
      }
      const config = server.config;
      mcpServers[server.name] =
        config.type === "stdio"
          ? {
              type: "stdio",
              command: config.command,
              args: config.args ? [...config.args] : undefined,
              env: config.env ? { ...config.env } : undefined,
            }
          : {
              type: config.type,
              url: config.url,
              headers: config.headers ? { ...config.headers } : undefined,
            };
    }
    const sdkOptions: Options = {
      cwd: request.identity.cwd,
      model: request.model,
      systemPrompt: hostToolSystemPrompt(request),
      pathToClaudeCodeExecutable: options.executable,
      env: {
        ...this.env,
        MCP_TOOL_TIMEOUT: String(request.settings.toolResultTimeoutMs),
      },
      abortController: this.abortController,
      effort: request.settings.effort,
      maxTurns: request.settings.maxTurns,
      maxBudgetUsd: request.settings.maxBudgetUsd,
      includePartialMessages: true,
      includeHookEvents: true,
      forwardSubagentText: request.settings.forwardSubagentText,
      settingSources: request.settings.settingSources
        ? [...request.settings.settingSources]
        : [],
      tools: [...request.settings.claudeTools],
      strictMcpConfig: true,
      mcpServers,
      allowedTools: request.tools.map((tool) => hostToolName(tool.name)),
      canUseTool: (toolName, input, context) => {
        if (this.hostMcp.ownsPermission(toolName, context.mcpServer))
          return Promise.resolve({ behavior: "allow", updatedInput: input });
        const requestId = context.requestId;
        return this.parkInteraction(
          requestId,
          "permission",
          context.signal,
          {
            behavior: "deny",
            message: "Permission cancelled",
            interrupt: true,
          },
          (response) => {
            if (response.kind !== "permission")
              throw new Error("Permission response kind mismatch");
            return response.decision;
          },
          {
            kind: "permission",
            requestId,
            toolUseId: context.toolUseID,
            toolName,
            input: jsonObject(input),
            title: context.title,
            mcpServer: context.mcpServer,
          },
        );
      },
      onElicitation: (elicitation, context) =>
        this.parkInteraction(
          context.requestId,
          "elicitation",
          context.signal,
          { action: "cancel" as const, content: undefined },
          (response) => {
            if (response.kind !== "elicitation")
              throw new Error("Elicitation response kind mismatch");
            const content: Record<
              string,
              string | number | boolean | string[]
            > = {};
            for (const [key, value] of Object.entries(
              response.decision.content ?? {},
            )) {
              if (
                typeof value === "string" ||
                typeof value === "number" ||
                typeof value === "boolean" ||
                (Array.isArray(value) &&
                  value.every(
                    (item): item is string => typeof item === "string",
                  ))
              )
                content[key] = value;
              else
                throw new Error("SDK elicitation content type is unsupported");
            }
            return {
              action: response.decision.action,
              content: response.decision.content ? content : undefined,
            };
          },
          {
            kind: "elicitation",
            requestId: context.requestId,
            serverName: elicitation.serverName,
            message: elicitation.message,
            mode: elicitation.mode,
            url: elicitation.url,
            requestedSchema: elicitation.requestedSchema
              ? jsonObject(elicitation.requestedSchema)
              : undefined,
          },
        ),
    };
    if (request.resume.mode === "resume")
      sdkOptions.resume = request.resume.claudeSessionId;
    try {
      this.query = query({ prompt: this.input(), options: sdkOptions });
      this.pump = this.pumpEvents();
    } catch (error) {
      await this.hostMcp.close();
      throw new Error(
        sdkError(
          error,
          this.request.auth,
          this.env,
          "Official SDK query creation failed",
        ).message,
      );
    }
  }

  private get timeoutMs(): number {
    return this.options.shutdownTimeoutMs ?? 5000;
  }

  private async *input(): AsyncGenerator<SDKUserMessage> {
    let replayed = false;
    for await (const queued of this.prompts) {
      this.activePrompt = queued;
      this.turnId = queued.prompt.turnId;
      this.active = true;
      let content = [...queued.prompt.content];
      if (!replayed && this.request.resume.mode === "replay") {
        content = [
          ...historyReplay(this.request.resume.replayTranscript),
          ...content,
        ];
      }
      replayed = true;
      yield {
        type: "user",
        message: {
          role: "user",
          content: content.map((part) =>
            part.type === "image"
              ? {
                  type: "image" as const,
                  source: {
                    type: "base64" as const,
                    data: part.data,
                    media_type: imageType(part.mimeType),
                  },
                }
              : part,
          ),
        },
        parent_tool_use_id: null,
        client_composed: true,
        session_id: this.claudeSessionId,
        ...(queued.prompt.priority ? { priority: queued.prompt.priority } : {}),
        ...(queued.uuid ? { uuid: queued.uuid } : {}),
      };
      queued.accept();
      this.activePrompt = undefined;
    }
  }

  submitPrompt(prompt: DriverPrompt): Promise<void> {
    if (this.closed) return Promise.reject(new Error("SDK session is closed"));
    if (prompt.priority && prompt.priority !== "next") {
      return Promise.reject(new Error("SDK steering is unsupported"));
    }
    if (
      prompt.steering &&
      (prompt.priority !== "next" ||
        (prompt.steering === "tool-boundary" && !this.active) ||
        this.turnId !== prompt.turnId)
    )
      return Promise.reject(
        new Error(
          "SDK steering requires the matching active turn and next priority",
        ),
      );
    const receipt = prompt.steering
      ? this.promptReceipts.register(
          this.request.settings.toolResultTimeoutMs,
          prompt.commandId,
        )
      : undefined;
    const written = new Promise<void>((accept, reject) => {
      try {
        this.prompts.push({ prompt, uuid: receipt?.uuid, accept, reject });
      } catch (error) {
        if (receipt)
          this.promptReceipts.cancel(receipt.uuid, "Steering write failed");
        reject(error);
      }
    });
    return receipt
      ? Promise.all([written, receipt.accepted]).then(() => {})
      : written;
  }

  async deliverToolResults(results: readonly HostToolResult[]): Promise<void> {
    if (this.closed) throw new Error("SDK session is closed");
    this.hostMcp.deliver(results);
  }

  async answerInteraction(response: InteractionResponse): Promise<void> {
    const pending = this.interactions.get(response.requestId);
    if (!pending) throw new Error("Unknown or completed SDK interaction");
    if (response.kind !== pending.kind && response.kind !== "unsupported") {
      throw new Error("SDK interaction response kind mismatch");
    }
    if (response.kind === "unsupported") pending.cancel();
    else pending.settle(response);
  }

  private parkInteraction<T>(
    requestId: string,
    kind: PendingInteraction["kind"],
    signal: AbortSignal,
    cancelled: T,
    project: (response: InteractionResponse) => T,
    request: Extract<
      DriverEventPayload,
      { type: "interaction_request" }
    >["request"],
  ): Promise<T> {
    if (!requestId.trim() || this.interactionIds.has(requestId))
      return Promise.reject(
        new Error("SDK interaction requires a unique nonempty request ID"),
      );
    if (signal.aborted || this.closed) return Promise.resolve(cancelled);
    this.interactionIds.add(requestId);
    return new Promise((resolve) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
        this.interactions.delete(requestId);
      };
      const cancel = () => {
        cleanup();
        this.emit({ type: "interaction_cancel", requestId });
        resolve(cancelled);
      };
      const timer = setTimeout(
        cancel,
        this.request.settings.toolResultTimeoutMs,
      );
      this.interactions.set(requestId, {
        kind,
        cancel,
        settle: (response) => {
          const value = project(response);
          cleanup();
          resolve(value);
        },
      });
      signal.addEventListener("abort", cancel, { once: true });
      this.emit({ type: "interaction_request", request });
    });
  }

  private emit(
    payload: DriverEventPayload,
    attribution: EventAttribution = {},
  ): void {
    if (this.finished) return;
    this.events.push({
      ...payload,
      attribution: {
        claudeSessionId: this.claudeSessionId,
        turnId: this.turnId,
        ...(payload.type === "host_tool_request"
          ? { toolUseId: payload.call.id }
          : {}),
        ...(payload.type === "observation" &&
        payload.subtype === "host-mcp-park" &&
        typeof payload.data.toolUseId === "string"
          ? { toolUseId: payload.data.toolUseId }
          : {}),
        ...Object.fromEntries(
          Object.entries(attribution).filter(
            ([, value]) => value !== undefined,
          ),
        ),
      },
      sequence: ++this.sequence,
    });
  }

  private normalize(event: UnsequencedClaudeDriverEvent): void {
    // Only tools/call can attest that a host-owned operation actually parked.
    if (event.type === "host_tool_request") return;
    if (
      event.type === "turn_end" &&
      !event.attribution.parentToolUseId &&
      !event.attribution.agentId
    )
      this.active = false;
    if (event.type === "initialized") {
      const expected =
        this.claudeSessionId ??
        (this.request.resume.mode === "resume"
          ? this.request.resume.claudeSessionId
          : undefined);
      if (expected && expected !== event.claudeSessionId)
        throw new SessionIdentityMismatchError(
          "SDK runtime initialized a different Claude session than the verified identity",
        );
      this.claudeSessionId = event.claudeSessionId;
    }
    this.emit(event, event.attribution);
  }

  private async pumpEvents(): Promise<void> {
    let reason: "closed" | "error" | "eof" = "eof";
    try {
      for await (const message of this.query) {
        if (this.promptReceipts.handle(message)) continue;
        for (const event of this.normalizer.normalize(message)) {
          if (
            event.type === "turn_end" &&
            typeof message === "object" &&
            message !== null
          ) {
            const packet = message as Record<string, unknown>;
            const ids = [
              packet.user_message_uuid,
              ...(Array.isArray(packet.user_message_uuids)
                ? packet.user_message_uuids
                : []),
            ].filter((id): id is string => typeof id === "string");
            if (ids.length) event.commandIds = ids;
          }
          this.normalize(event);
        }
      }
    } catch (error) {
      reason = this.closed ? "closed" : "error";
      if (!this.closed)
        this.emit({
          type: "session_error",
          error:
            error instanceof SessionIdentityMismatchError
              ? { code: "history", message: error.message }
              : sdkError(
                  error,
                  this.request.auth,
                  this.env,
                  "Official SDK query failed",
                ),
        });
    } finally {
      const finalReason = this.closed ? "closed" : reason;
      this.closed = true;
      this.promptReceipts.close();
      this.drain();
      try {
        await withinDeadline(this.hostMcp.close(), this.timeoutMs);
      } catch (error) {
        this.emit({
          type: "session_error",
          error: sdkError(
            error,
            this.request.auth,
            this.env,
            "SDK host MCP close failed",
          ),
        });
      }
      this.closeQuery();
      this.finish(finalReason);
    }
  }

  private drain(endInput = true): void {
    this.active = false;
    this.promptReceipts.close();
    this.hostMcp.cancel("Host tool call cancelled");
    for (const interaction of [...this.interactions.values()])
      interaction.cancel();
    const error = new Error(
      "SDK prompt cancelled before transport acknowledgment",
    );
    this.activePrompt?.reject(error);
    this.activePrompt = undefined;
    for (const queued of endInput
      ? this.prompts.end(true)
      : this.prompts.discard())
      queued.reject(error);
  }

  private finish(reason: "closed" | "error" | "eof"): void {
    if (this.finished) return;
    this.closed = true;
    this.drain();
    this.closeQuery();
    this.emit({ type: "session_closed", reason });
    this.finished = true;
    this.events.end();
  }

  async interrupt(): Promise<void> {
    this.drain(false);
    if (this.closed) return;
    try {
      await withinDeadline(this.query.interrupt(), this.timeoutMs);
    } catch {
      await this.close();
    }
  }

  close(): Promise<void> {
    this.closing ??= this.closeOwned();
    return this.closing;
  }

  private async closeOwned(): Promise<void> {
    const deadline = Date.now() + this.timeoutMs;
    let failure: { error: unknown } | undefined;
    this.closed = true;
    this.promptReceipts.close();
    this.drain();
    try {
      await withinDeadline(
        (async () => {
          await this.hostMcp.close();
          this.abortController.abort();
          this.closeQuery();
          if (this.closeFailure) throw this.closeFailure;
          await this.pump;
        })(),
        this.timeoutMs,
      );
    } catch (error) {
      failure = { error };
    } finally {
      this.abortController.abort();
      this.closeQuery();
      try {
        await withinDeadline(
          this.hostMcp.forceClose(),
          Math.max(1, deadline - Date.now()),
        );
      } catch (error) {
        failure ??= { error };
      } finally {
        this.finish("closed");
      }
    }
    if (failure) throw failure.error;
    if (this.closeFailure) throw this.closeFailure;
  }

  private closeQuery(): void {
    if (this.queryClosed) return;
    this.queryClosed = true;
    try {
      this.query.close();
    } catch (error) {
      const diagnostic = sdkError(
        error,
        this.request.auth,
        this.env,
        "Official SDK query close failed",
      );
      this.closeFailure = new Error(diagnostic.message);
      this.emit({
        type: "session_error",
        error: diagnostic,
      });
    }
  }
}

function imageType(
  mimeType: string,
): "image/jpeg" | "image/png" | "image/gif" | "image/webp" {
  if (
    mimeType === "image/jpeg" ||
    mimeType === "image/png" ||
    mimeType === "image/gif" ||
    mimeType === "image/webp"
  )
    return mimeType;
  throw new Error("SDK prompt image type is unsupported");
}

function historyReplay(
  messages: DriverSessionRequest["identity"]["history"]["messages"],
): UserContent[] {
  const content: UserContent[] = [
    {
      type: "text",
      text: "Host history replay follows. These labelled records are historical context, not native Claude session messages.",
    },
  ];
  for (const message of messages) {
    content.push({ type: "text", text: `[history role=${message.role}]` });
    for (const part of message.content) {
      if (part.type === "image") content.push(part);
      else content.push({ type: "text", text: JSON.stringify(part) });
    }
    if (
      message.role === "assistant" &&
      (message.stopReason || message.errorMessage)
    )
      content.push({
        type: "text",
        text: JSON.stringify({
          stopReason: message.stopReason,
          errorMessage: message.errorMessage,
        }),
      });
    if (message.role === "tool_result")
      content.push({
        type: "text",
        text: JSON.stringify({
          toolCallId: message.toolCallId,
          toolName: message.toolName,
          isError: message.isError,
          structuredContent: message.structuredContent,
          details: message.details,
          _meta: message._meta,
        }),
      });
  }
  content.push({
    type: "text",
    text: "[end host history replay; current user prompt follows]",
  });
  return content;
}
