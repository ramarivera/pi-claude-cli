/** The two hosts and two transports share only this versioned, data-only seam. */
export const CONTRACT_VERSION = 1 as const;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type DriverKind = "cli" | "sdk";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface TextContent {
  type: "text";
  text: string;
}
export interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}
export type UserContent = TextContent | ImageContent;
export interface ThinkingContent {
  type: "thinking";
  thinking: string;
  signature?: string;
  redacted?: boolean;
}
export interface HostToolCall {
  type: "tool_call";
  /** Authoritative Claude tool_use.id, unchanged in the host and its result. */
  id: string;
  name: string;
  arguments: JsonObject;
}
export type AssistantContent = UserContent | ThinkingContent | HostToolCall;

/** MCP content is retained without a schema-library conversion. */
export type ToolResultContent =
  | UserContent
  | { type: "audio"; data: string; mimeType: string }
  | {
      type: "resource";
      resource: {
        uri: string;
        mimeType?: string;
        text?: string;
        blob?: string;
        _meta?: JsonObject;
      };
    }
  | {
      type: "resource_link";
      uri: string;
      name: string;
      title?: string;
      description?: string;
      mimeType?: string;
      size?: number;
    };

export interface HostToolResult {
  toolCallId: string;
  toolName: string;
  content: readonly ToolResultContent[];
  isError: boolean;
  structuredContent?: JsonObject;
  /** Host details remain available even when they aren't model-directed output. */
  details?: JsonValue;
  _meta?: JsonObject;
}

export interface ToolDefinition {
  /** Native host name; drivers advertise it in their owned MCP namespace. */
  name: string;
  description: string;
  owner: "host";
  inputSchema: JsonObject;
  outputSchema?: JsonObject;
  title?: string;
  annotations?: JsonObject;
  _meta?: JsonObject;
}

export type TranscriptMessage =
  | { role: "user" | "developer"; content: readonly UserContent[] }
  | {
      role: "assistant";
      content: readonly AssistantContent[];
      stopReason?: "stop" | "toolUse" | "length" | "error" | "aborted";
      errorMessage?: string;
    }
  | ({ role: "tool_result" } & HostToolResult);

export interface HostSessionIdentity {
  sessionId: string;
  branchId: string;
  /** Changes on compaction, import, tree navigation, fork or explicit reset. */
  historyRevision: string;
}

export interface HistorySnapshot {
  messages: readonly TranscriptMessage[];
  /** Stable hashes of each normalized message, in order; computed by core. */
  messageDigests: readonly string[];
  digest: string;
}

export interface SessionIdentity extends HostSessionIdentity {
  driver: DriverKind;
  cwd: string;
  /** Hashes cover effective system prompt, tools, model, auth and settings. */
  configurationDigest: string;
  history: HistorySnapshot;
  /** Present only after authoritative runtime initialization. */
  claudeSessionId?: string;
}

export type AuthConfig =
  | { mode: "claude-login" }
  | { mode: "api-key"; apiKey: string; baseUrl?: string };

export interface UserMcpServer {
  name: string;
  config:
    | {
        type: "stdio";
        command: string;
        args?: readonly string[];
        env?: Readonly<Record<string, string>>;
      }
    | {
        type: "http" | "sse";
        url: string;
        headers?: Readonly<Record<string, string>>;
      };
}

export interface RuntimeSettings {
  effort?: Effort;
  /** Published Claude output-token setting; the runtime applies model caps. */
  maxOutputTokens?: number;
  maxTurns?: number;
  maxBudgetUsd?: number;
  /** Wall-clock bound for a parked host call, also applied to MCP runtime. */
  toolResultTimeoutMs: number;
  /** Explicit Claude ownership; neither list is projected into host tool calls. */
  claudeTools: readonly string[];
  userMcpServers: readonly UserMcpServer[];
  forwardSubagentText?: boolean;
  settingSources?: readonly ("user" | "project" | "local")[];
}

export interface ActiveSteeringClaim {
  contents: readonly (readonly UserContent[])[];
  /** Native runtime owns the input; the host records it after this response. */
  accept(): void;
  /** Unsent input remains owned by the host's next request. */
  reject(): void;
}
export interface ActiveSteeringSource {
  wait(signal: AbortSignal): Promise<void>;
  claim(signal: AbortSignal): Promise<ActiveSteeringClaim | undefined>;
}

export interface HostRoundRequest {
  roundId: string;
  session: HostSessionIdentity;
  cwd: string;
  model: string;
  systemPrompt: string;
  /** Current effective inventory, not configured/available inactive tools. */
  tools: readonly ToolDefinition[];
  transcript: readonly TranscriptMessage[];
  input:
    | { kind: "prompt"; content: readonly UserContent[] }
    | {
        kind: "tool-results";
        results: readonly HostToolResult[];
        steering?: readonly UserContent[];
      };
  settings: RuntimeSettings;
  auth: AuthConfig;
  signal?: AbortSignal;
  activeSteering?: ActiveSteeringSource;
}

export interface DriverCapabilities {
  contractVersion: typeof CONTRACT_VERSION;
  driver: DriverKind;
  toolCorrelation: "claude-tool-use-meta";
  residentSessions: boolean;
  persistedResume: boolean;
  structuredToolResults: boolean;
  images: boolean;
  steering: "unsupported" | "tool-boundary" | "active-queue" | "live";
  interactions: readonly ("permission" | "elicitation" | "dialog")[];
  supportedDialogKinds: readonly string[];
  forwardSubagentText: boolean;
}

export type ResumePlan =
  | { mode: "fresh"; restoration: "none"; reason: string }
  | {
      mode: "resident";
      restoration: "native-resident";
      claudeSessionId: string;
      reason: string;
    }
  | {
      mode: "resume";
      restoration: "native-persisted";
      claudeSessionId: string;
      reason: string;
    }
  | {
      mode: "replay";
      restoration: "user-history-replay";
      /** Labels every role/call/result and preserves images. No native file import. */
      replayTranscript: readonly TranscriptMessage[];
      reason: string;
    };

export interface DriverSessionRequest {
  /** History here precedes the prompt submitted via submitPrompt. */
  identity: SessionIdentity;
  resume: ResumePlan;
  model: string;
  systemPrompt: string;
  tools: readonly ToolDefinition[];
  settings: RuntimeSettings;
  auth: AuthConfig;
}

export interface DriverPrompt {
  /** One Claude turn can span several host rounds. */
  turnId: string;
  content: readonly UserContent[];
  priority?: "now" | "next" | "later";
  /** Await native queue admission before releasing parked host tools. */
  steering?: "tool-boundary" | "active-queue";
  /** Core-generated native command UUID, for active queue consumption. */
  commandId?: string;
}

export interface EventAttribution {
  claudeSessionId?: string;
  turnId?: string;
  messageId?: string;
  parentToolUseId?: string | null;
  toolUseId?: string;
  taskId?: string;
  agentId?: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens?: number;
  costUsd?: number;
  modelUsage?: JsonObject;
}

export interface RuntimeError {
  code:
    | "auth"
    | "unsupported"
    | "spawn"
    | "protocol"
    | "transport"
    | "timeout"
    | "runtime"
    | "history"
    | "tool-correlation"
    | "closed"
    | "aborted";
  message: string;
  subtype?: string;
  retryable?: boolean;
  /** Bounded, sanitized diagnostic data, never credentials or raw environment. */
  details?: JsonObject;
}

export type InteractionRequest =
  | {
      kind: "permission";
      requestId: string;
      toolUseId: string;
      toolName: string;
      input: JsonObject;
      title?: string;
      mcpServer?: { name: string; source: string };
    }
  | {
      kind: "elicitation";
      requestId: string;
      serverName: string;
      message: string;
      mode?: "form" | "url";
      url?: string;
      requestedSchema?: JsonObject;
    }
  | {
      kind: "dialog";
      requestId: string;
      dialogKind: string;
      payload: JsonObject;
      toolUseId?: string;
    };

export type InteractionResponse =
  | {
      kind: "permission";
      requestId: string;
      decision:
        | { behavior: "allow"; updatedInput: JsonObject }
        | { behavior: "deny"; message: string; interrupt?: boolean };
    }
  | {
      kind: "elicitation";
      requestId: string;
      decision: {
        action: "accept" | "decline" | "cancel";
        content?: JsonObject;
      };
    }
  | { kind: "dialog"; requestId: string; decision: JsonObject }
  | { kind: "unsupported"; requestId: string; error: string };

export type ContentDelta =
  | { kind: "text"; text: string }
  | { kind: "thinking"; thinking: string }
  | { kind: "signature"; signature: string }
  | { kind: "tool-input"; partialJson: string };

export type DriverEventPayload =
  | {
      type: "initialized";
      claudeSessionId: string;
      model: string;
      runtimeVersion: string;
      capabilities: readonly string[];
      tools: readonly string[];
      mcpServers: readonly { name: string; status: string; source?: string }[];
      authSource?: string;
    }
  | { type: "message_start"; messageId: string; model?: string }
  | {
      type: "content_start";
      messageId: string;
      index: number;
      content: AssistantContent;
    }
  | {
      type: "content_delta";
      messageId: string;
      index: number;
      delta: ContentDelta;
    }
  | { type: "content_end"; messageId: string; index: number }
  | {
      type: "assistant_snapshot";
      messageId: string;
      /** Source frame UUID where supplied, for duplicate snapshot reconciliation. */
      snapshotId?: string;
      /** A snapshot may hold one completed block, not the whole message. */
      content: readonly AssistantContent[];
      /** Original message block positions, when the normalizer can establish them. */
      contentIndexes?: readonly number[];
      model?: string;
      usage?: Usage;
      supersedes?: readonly string[];
    }
  | {
      type: "message_end";
      messageId: string;
      stopReason?: string;
      usage?: Usage;
    }
  | {
      type: "host_tool_request";
      /** Emitted when MCP tools/call actually parks, never inferred from ordering. */
      call: HostToolCall;
    }
  | { type: "interaction_request"; request: InteractionRequest }
  | { type: "interaction_cancel"; requestId: string }
  | {
      type: "observation";
      family:
        | "status"
        | "retry"
        | "rate-limit"
        | "compaction"
        | "tool-progress"
        | "hook"
        | "task"
        | "user-input"
        | "reset"
        | "diagnostic";
      subtype: string;
      data: JsonObject;
    }
  | {
      /** Claude result boundary. This does not close a resident session or its pump. */
      type: "turn_end";
      /** Native user UUIDs answered by this result, when supplied. */
      commandIds?: readonly string[];
      status: "success" | "error" | "aborted";
      subtype: string;
      isError: boolean;
      resultText?: string;
      model?: string;
      usage?: Usage;
      error?: RuntimeError;
    }
  | { type: "session_error"; error: RuntimeError }
  | { type: "session_closed"; reason: "closed" | "aborted" | "error" | "eof" };

export type UnsequencedClaudeDriverEvent = DriverEventPayload & {
  attribution: EventAttribution;
};

export type ClaudeDriverEvent = UnsequencedClaudeDriverEvent & {
  /** Monotonic per driver session, including while no host round is attached. */
  sequence: number;
};

export interface ClaudeEventNormalizerOptions {
  tools: readonly ToolDefinition[];
  hostMcpServerName: string;
  requestedModel: string;
}

/** Shared CLI/SDK envelope translation; owns per-message block reconciliation state. */
export interface ClaudeEventNormalizer {
  /** Unknown input is validated here; never leak a raw SDK object into host DTOs. */
  normalize(payload: unknown): readonly UnsequencedClaudeDriverEvent[];
}
export type ClaudeEventNormalizerFactory = (
  options: ClaudeEventNormalizerOptions,
) => ClaudeEventNormalizer;

export type ClaudeRoundEvent =
  | { type: "driver_event"; roundId: string; event: ClaudeDriverEvent }
  | {
      type: "round_end";
      roundId: string;
      reason: "toolUse" | "stop" | "length" | "error" | "aborted";
      content: readonly AssistantContent[];
      pendingToolCallIds: readonly string[];
      model?: string;
      usage?: Usage;
      error?: RuntimeError;
    };

export interface ClaudeDriverSession {
  /** Continuously pumped independently of host round subscriptions. */
  events: AsyncIterable<ClaudeDriverEvent>;
  /** Resolves only once the transport has accepted the write. */
  submitPrompt(prompt: DriverPrompt): Promise<void>;
  /** Match by toolCallId; buffer valid early results and ignore identical duplicates. */
  deliverToolResults(results: readonly HostToolResult[]): Promise<void>;
  answerInteraction(response: InteractionResponse): Promise<void>;
  /** Settles parked handlers as errors/cancellation, then interrupts the current turn. */
  interrupt(reason?: string): Promise<void>;
  /** Idempotent; waits for owned query/process, handlers, timers and files to settle. */
  close(): Promise<void>;
}

export interface ClaudeDriver {
  kind: DriverKind;
  capabilities: DriverCapabilities;
  openSession(request: DriverSessionRequest): Promise<ClaudeDriverSession>;
}

export interface DriverFactoryOptions {
  /** Composition root supplies the shared production envelope normalizer. */
  normalizerFactory?: ClaudeEventNormalizerFactory;
  executable?: string;
  environment?: Readonly<Record<string, string | undefined>>;
  shutdownTimeoutMs?: number;
}
export type ClaudeDriverFactory = (
  options?: DriverFactoryOptions,
) => ClaudeDriver;

export type HistoryInvalidationReason =
  | "compaction"
  | "tree"
  | "branch"
  | "fork"
  | "import"
  | "abort"
  | "reset"
  | "reload";

export interface ClaudeRuntime {
  /** Ends once per provider round; a toolUse end keeps its driver session parked. */
  streamRound(request: HostRoundRequest): AsyncIterable<ClaudeRoundEvent>;
  invalidate(
    session: HostSessionIdentity,
    reason: HistoryInvalidationReason,
  ): Promise<void>;
  close(sessionId: string): Promise<void>;
  closeAll(): Promise<void>;
}

export interface ClaudeRuntimeOptions {
  driver: ClaudeDriver;
}
export type ClaudeRuntimeFactory = (
  options: ClaudeRuntimeOptions,
) => ClaudeRuntime;

/** Host adapters normalize their own framework types before invoking this seam. */
export interface HostAdapter<Request, Event> {
  toRequest(request: Request): HostRoundRequest;
  fromEvent(event: ClaudeRoundEvent): Event;
}

export { resolveResumePlan } from "./resume.js";
export type { ResumeAvailability } from "./resume.js";
