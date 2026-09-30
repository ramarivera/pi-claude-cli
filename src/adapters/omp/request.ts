import type {
  Context,
  Model,
  SimpleStreamOptions,
  Tool,
} from "@oh-my-pi/pi-ai";
import type { RuntimeConfiguration } from "../../../entrypoints/config.js";
import type {
  AssistantContent,
  HostRoundRequest,
  HostSessionIdentity,
  HostToolResult,
  JsonObject,
  JsonValue,
  ToolDefinition,
  TranscriptMessage,
  UserContent,
} from "../../contracts/index.js";

export function json(value: unknown, label: string): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item) => json(item, label));
  if (typeof value === "object" && value !== null) {
    if (
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    )
      throw new Error(`${label} must be plain JSON`);
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, json(item, label)]),
    );
  }
  throw new Error(
    `${label} must be plain JSON; callable inventory schemas aren't supported`,
  );
}
export function jsonObject(value: unknown, label: string): JsonObject {
  const result = json(value, label);
  if (typeof result !== "object" || result === null || Array.isArray(result))
    throw new Error(`${label} must be a JSON object`);
  return result;
}

/** OMP already normalized these effective tools at its provider boundary. */
export function normalizeTools(tools: readonly Tool[] = []): ToolDefinition[] {
  return tools.map((tool) => {
    const metadata: JsonObject = {};
    if (tool.customFormat)
      metadata.customFormat = json(tool.customFormat, "customFormat");
    if (tool.customWireName) metadata.customWireName = tool.customWireName;
    if (tool.examples) metadata.examples = json(tool.examples, "tool examples");
    if (tool.native)
      throw new Error(
        `OMP hosted tool ${tool.name} can't execute through a host MCP call`,
      );
    if (tool.strict !== undefined) metadata.strict = tool.strict;
    if (tool.deferLoading !== undefined)
      metadata.deferLoading = tool.deferLoading;
    return {
      owner: "host",
      name: tool.name,
      description: tool.description,
      inputSchema: jsonObject(
        tool.parameters,
        `OMP tool ${tool.name} parameters`,
      ),
      ...(Object.keys(metadata).length ? { _meta: { omp: metadata } } : {}),
    };
  });
}

export function normalizeTranscript(context: Context): TranscriptMessage[] {
  return context.messages.map((message): TranscriptMessage => {
    if (message.role === "user" || message.role === "developer") {
      return {
        role: message.role,
        content:
          typeof message.content === "string"
            ? [{ type: "text", text: message.content }]
            : message.content.map((block) => ({ ...block })),
      };
    }
    if (message.role === "toolResult") {
      return {
        role: "tool_result",
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        content: message.content.map((block) => ({ ...block })),
        isError: message.isError,
        ...(message.details === undefined
          ? {}
          : { details: json(message.details, "OMP tool result details") }),
        ...(message.providerMetadata === undefined
          ? {}
          : {
              _meta: jsonObject(
                message.providerMetadata,
                "OMP tool result metadata",
              ),
            }),
      };
    }
    const content = message.content.map((block): AssistantContent => {
      switch (block.type) {
        case "text":
        case "image":
          return { ...block };
        case "thinking":
          return {
            type: "thinking",
            thinking: block.thinking,
            ...(block.thinkingSignature === undefined
              ? {}
              : { signature: block.thinkingSignature }),
          };
        case "redactedThinking":
          return {
            type: "thinking",
            thinking: "",
            signature: block.data,
            redacted: true,
          };
        case "toolCall":
          return {
            type: "tool_call",
            id: block.id,
            name: block.name,
            arguments: jsonObject(block.arguments, "OMP tool arguments"),
          };
        default:
          throw new Error(`Unsupported OMP history content ${block.type}`);
      }
    });
    return {
      role: "assistant",
      content,
      stopReason: message.stopReason,
      ...(message.errorMessage === undefined
        ? {}
        : { errorMessage: message.errorMessage }),
    };
  });
}

export function toRequest(
  model: Model,
  context: Context,
  options: SimpleStreamOptions,
  configuration: RuntimeConfiguration,
  session: HostSessionIdentity,
  cwd: string,
): HostRoundRequest {
  const transcript = normalizeTranscript(context);
  const last = transcript.at(-1);
  let input: HostRoundRequest["input"];
  if (last?.role === "tool_result") {
    const results: HostToolResult[] = [];
    for (let index = transcript.length - 1; index >= 0; index--) {
      const message = transcript[index];
      if (message.role !== "tool_result") break;
      const { role: _role, ...result } = message;
      results.unshift(result);
    }
    input = { kind: "tool-results", results };
  } else if (last?.role === "user")
    input = { kind: "prompt", content: last.content };
  else
    throw new Error(
      "OMP round requires a trailing user message or tool results",
    );
  const effort =
    options.disableReasoning || options.forceReasoningOff || !model.reasoning
      ? undefined
      : (options.reasoning ?? configuration.settings.effort);
  if (
    effort !== undefined &&
    !["low", "medium", "high", "xhigh", "max"].includes(effort)
  )
    throw new Error(`Unsupported Claude effort: ${effort}`);
  if (
    effort !== undefined &&
    model.thinking &&
    !model.thinking.efforts.some((supported) => supported === effort)
  )
    throw new Error(`Model ${model.id} doesn't support effort ${effort}`);
  return {
    roundId: crypto.randomUUID(),
    session,
    cwd: options.cwd ?? cwd,
    model: model.id,
    systemPrompt: context.systemPrompt?.join("\n\n") ?? "",
    tools: normalizeTools(context.tools),
    transcript,
    input,
    settings: {
      ...configuration.settings,
      effort: effort as HostRoundRequest["settings"]["effort"],
    },
    auth: configuration.auth,
    signal: options.signal,
  };
}

function userContent(value: unknown): value is UserContent[] {
  return (
    Array.isArray(value) &&
    value.every((block: unknown) => {
      if (!record(block)) return false;
      return block.type === "text"
        ? typeof block.text === "string"
        : block.type === "image" &&
            typeof block.data === "string" &&
            typeof block.mimeType === "string";
    })
  );
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Hooks may edit useful request data, but can't replace session, auth or settings. */
export function replacePayload(
  original: HostRoundRequest,
  replacement: unknown,
): HostRoundRequest {
  if (replacement === undefined || replacement === original) return original;
  if (!record(replacement))
    throw new Error("OMP onPayload must return a HostRoundRequest");
  const data = jsonObject(
    { ...replacement, signal: undefined },
    "OMP payload replacement",
  );
  for (const key of ["roundId", "session", "auth", "settings"] as const) {
    if (JSON.stringify(data[key]) !== JSON.stringify(json(original[key], key)))
      throw new Error(`OMP onPayload can't replace ${key}`);
  }
  if (
    typeof data.cwd !== "string" ||
    !data.cwd ||
    typeof data.model !== "string" ||
    !data.model ||
    typeof data.systemPrompt !== "string"
  )
    throw new Error("Invalid OMP payload model, cwd or systemPrompt");
  if (
    !Array.isArray(data.tools) ||
    data.tools.some(
      (tool) =>
        !record(tool) ||
        tool.owner !== "host" ||
        typeof tool.name !== "string" ||
        typeof tool.description !== "string" ||
        !record(tool.inputSchema),
    )
  )
    throw new Error("Invalid OMP payload tools");
  // Preserve correlated history/results; prompt edits are explicitly validated.
  if (
    JSON.stringify(data.transcript) !==
    JSON.stringify(json(original.transcript, "transcript"))
  )
    throw new Error(
      "OMP onPayload can't replace correlated transcript history",
    );
  if (
    !record(data.input) ||
    (original.input.kind === "prompt"
      ? data.input.kind !== "prompt" || !userContent(data.input.content)
      : JSON.stringify(data.input) !==
        JSON.stringify(json(original.input, "input")))
  )
    throw new Error("Invalid OMP payload input");
  return {
    ...original,
    cwd: data.cwd,
    model: data.model,
    systemPrompt: data.systemPrompt,
    tools: data.tools as unknown as ToolDefinition[],
    transcript:
      original.input.kind === "prompt" &&
      record(data.input) &&
      userContent(data.input.content)
        ? [
            ...original.transcript.slice(0, -1),
            { role: "user", content: data.input.content },
          ]
        : original.transcript,
    input: data.input as unknown as HostRoundRequest["input"],
  };
}
