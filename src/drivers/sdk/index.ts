import { randomUUID } from "node:crypto";
import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
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
  type UnsequencedClaudeDriverEvent,
  type UserContent,
} from "../../contracts/index.js";
import { sdkEnvironment } from "./auth.js";
import { AsyncQueue, withinDeadline } from "./queue.js";

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
      steering: "unsupported",
      interactions: ["permission", "elicitation"],
      supportedDialogKinds: [],
      forwardSubagentText: true,
    },
    async openSession(request) {
      const env = sdkEnvironment(request.auth, options.environment);
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
      return new SdkSession(request, options, normalizer, query, env);
    },
  };
}

async function loadOfficialSdk(): Promise<SdkModule> {
  return import("@anthropic-ai/claude-agent-sdk");
}

interface QueuedPrompt {
  prompt: DriverPrompt;
  accept(): void;
  reject(error: Error): void;
}
interface PendingInteraction {
  kind: "permission" | "elicitation";
  settle(response: InteractionResponse): void;
  cancel(): void;
}

class SdkSession implements ClaudeDriverSession {
  readonly events = new AsyncQueue<ClaudeDriverEvent>();
  private readonly prompts = new AsyncQueue<QueuedPrompt>();
  private readonly abortController = new AbortController();
  private readonly interactions = new Map<string, PendingInteraction>();
  private readonly query: SdkQuery;
  private readonly pump: Promise<void>;
  private sequence = 0;
  private turnId?: string;
  private claudeSessionId?: string;
  private activePrompt?: QueuedPrompt;
  private closed = false;
  private finished = false;
  private queryClosed = false;
  private closing?: Promise<void>;

  constructor(
    private readonly request: DriverSessionRequest,
    private readonly options: SdkDriverOptions,
    private readonly normalizer: ClaudeEventNormalizer,
    query: SdkQueryFactory,
    env: Record<string, string | undefined>,
  ) {
    const sdkOptions: Options = {
      cwd: request.identity.cwd,
      model: request.model,
      systemPrompt: request.systemPrompt,
      pathToClaudeCodeExecutable: options.executable,
      env,
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
      mcpServers: {},
      canUseTool: (toolName, input, context) => {
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
    if (request.resume.mode === "resident") {
      throw new Error(
        "Resident sessions must reuse their existing SDK driver session",
      );
    }
    this.query = query({ prompt: this.input(), options: sdkOptions });
    this.pump = this.pumpEvents();
  }

  private get timeoutMs(): number {
    return this.options.shutdownTimeoutMs ?? 5000;
  }

  private async *input(): AsyncGenerator<SDKUserMessage> {
    let replayed = false;
    for await (const queued of this.prompts) {
      this.activePrompt = queued;
      this.turnId = queued.prompt.turnId;
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
        uuid: randomUUID(),
        session_id: this.claudeSessionId,
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
    return new Promise((accept, reject) =>
      this.prompts.push({ prompt, accept, reject }),
    );
  }

  async deliverToolResults(): Promise<void> {
    throw new Error("SDK host MCP handoff has not been attached");
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
    if (signal.aborted || this.closed) return Promise.resolve(cancelled);
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
        ...attribution,
      },
      sequence: ++this.sequence,
    });
  }

  private normalize(event: UnsequencedClaudeDriverEvent): void {
    if (event.type === "initialized")
      this.claudeSessionId = event.claudeSessionId;
    this.emit(event, event.attribution);
  }

  private async pumpEvents(): Promise<void> {
    let reason: "closed" | "error" | "eof" = "eof";
    try {
      for await (const message of this.query) {
        for (const event of this.normalizer.normalize(message))
          this.normalize(event);
      }
    } catch {
      reason = this.closed ? "closed" : "error";
      if (!this.closed)
        this.emit({
          type: "session_error",
          error: { code: "transport", message: "Official SDK query failed" },
        });
    } finally {
      this.finish(this.closed ? "closed" : reason);
    }
  }

  private drain(endInput = true): void {
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
    this.closed = true;
    this.drain();
    this.abortController.abort();
    try {
      this.closeQuery();
      await withinDeadline(this.pump, this.timeoutMs);
    } finally {
      this.finish("closed");
    }
  }

  private closeQuery(): void {
    if (this.queryClosed) return;
    this.queryClosed = true;
    try {
      this.query.close();
    } catch {
      this.emit({
        type: "session_error",
        error: {
          code: "transport",
          message: "Official SDK query close failed",
        },
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

function jsonObject(
  input: Record<string, unknown>,
): import("../../contracts/index.js").JsonObject {
  // The SDK receives JSON control frames; reject rather than leak non-JSON data.
  const serialized = JSON.stringify(input);
  return JSON.parse(
    serialized,
  ) as import("../../contracts/index.js").JsonObject;
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
