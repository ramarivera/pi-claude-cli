import {
  getCurrentSystemPrompt,
  getCurrentTools,
  type TranscriptContext,
  type SimpleStreamOptions,
  type Model,
  type Api,
} from "@earendil-works/pi-ai";
import type { RuntimeConfiguration } from "../../../entrypoints/config.js";
import type {
  AssistantContent,
  HostRoundRequest,
  HostSessionIdentity,
  JsonObject,
  JsonValue,
  TranscriptMessage,
} from "../../contracts/index.js";

export function json(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(json);
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, json(item)]),
    );
  throw new Error("Pi supplied a value that isn't JSON compatible");
}
export function object(value: unknown): JsonObject {
  const result = json(value);
  if (result === null || typeof result !== "object" || Array.isArray(result))
    throw new Error("Expected a JSON object");
  return result;
}
export function normalizeTranscript(
  context: TranscriptContext,
): TranscriptMessage[] {
  return context.messages.flatMap((message): TranscriptMessage[] => {
    if (message.role === "system") return [];
    if (message.role === "user")
      return [
        {
          role: "user",
          content:
            typeof message.content === "string"
              ? [{ type: "text", text: message.content }]
              : message.content.map((block) =>
                  block.type === "text"
                    ? { type: "text", text: block.text }
                    : { ...block },
                ),
        },
      ];
    if (message.role === "assistant") {
      const content: AssistantContent[] = message.content.map((block) => {
        if (block.type === "toolCall")
          return {
            type: "tool_call",
            id: block.id,
            name: block.name,
            arguments: object(block.arguments),
          };
        if (block.type === "thinking")
          return {
            type: "thinking",
            thinking: block.thinking,
            signature: block.thinkingSignature,
            redacted: block.redacted,
          };
        return { type: "text", text: block.text };
      });
      if (message.stopReason === "pending" || message.stopReason === "deferred")
        throw new Error(
          `Unsupported Pi history stop reason: ${message.stopReason}`,
        );
      return [
        {
          role: "assistant",
          content,
          stopReason: message.stopReason,
          errorMessage: message.errorMessage,
        },
      ];
    }
    const details =
      message.details === undefined ? undefined : json(message.details);
    const record =
      details !== null && typeof details === "object" && !Array.isArray(details)
        ? details
        : undefined;
    return [
      {
        role: "tool_result",
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        content: message.content.map((block) => ({ ...block })),
        isError: message.isError,
        details,
        structuredContent:
          record?.structuredContent === undefined
            ? undefined
            : object(record.structuredContent),
        _meta: record?._meta === undefined ? undefined : object(record._meta),
      },
    ];
  });
}
export function toPiRequest(
  context: TranscriptContext,
  model: Model<Api>,
  options: SimpleStreamOptions,
  configuration: RuntimeConfiguration,
  session: HostSessionIdentity,
  cwd: string,
  roundId: string,
): HostRoundRequest {
  for (const name of [
    "fetch",
    "maxRetries",
    "temperature",
    "samplingParams",
    "websocketConnectTimeoutMs",
    "metadata",
    "toolChoice",
    "deferred",
    "thinkingBudgets",
  ] as const) {
    if (options[name] !== undefined)
      throw new Error(
        `Pi option ${name} isn't supported by the Claude runtime adapter`,
      );
  }
  if (options.headers !== undefined && Object.keys(options.headers).length > 0)
    throw new Error(
      "Pi option headers isn't supported by the Claude runtime adapter",
    );
  if (options.transport !== undefined && options.transport !== "auto")
    throw new Error(
      `Pi transport ${options.transport} isn't supported by the configured Claude driver`,
    );
  if (
    options.maxRetryDelayMs !== undefined &&
    options.maxRetryDelayMs !== 60_000
  )
    throw new Error(
      "Pi custom maxRetryDelayMs isn't supported by the Claude runtime adapter",
    );
  if (
    options.timeoutMs !== undefined &&
    (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0)
  )
    throw new Error("Pi timeoutMs must be a finite nonnegative idle timeout");
  if (
    options.maxTokens !== undefined &&
    (!Number.isSafeInteger(options.maxTokens) || options.maxTokens <= 0)
  )
    throw new Error("Pi maxTokens must be a positive integer");
  if (options.reasoning === "minimal")
    throw new Error(
      "Pi reasoning minimal isn't supported by the Claude runtime adapter",
    );
  const effort = options.reasoning ?? configuration.settings.effort;
  if (effort && !model.reasoning)
    throw new Error(
      `Claude model ${model.id} doesn't support reasoning effort`,
    );
  if (options.reasoning && model.thinkingLevelMap?.[options.reasoning] === null)
    throw new Error(
      `Claude model ${model.id} doesn't support reasoning ${options.reasoning}`,
    );
  const transcript = normalizeTranscript(context);
  const last = transcript.at(-1);
  let input: HostRoundRequest["input"];
  const assistantIndex = transcript.findLastIndex(
    (message) => message.role === "assistant",
  );
  const tail = transcript.slice(assistantIndex + 1);
  const results = tail.filter((message) => message.role === "tool_result");
  const steering = tail.flatMap((message) =>
    message.role === "user" ? message.content : [],
  );
  if (results.length) {
    input = {
      kind: "tool-results",
      results,
      ...(steering.length ? { steering } : {}),
    };
  } else if (last?.role === "user") {
    input = { kind: "prompt", content: last.content };
  } else
    throw new Error(
      "Pi provider round requires a trailing user prompt or tool results",
    );
  return {
    roundId,
    session,
    cwd,
    model: model.id,
    systemPrompt: getCurrentSystemPrompt(context.messages),
    tools: getCurrentTools(context.messages).map((tool) => ({
      name: tool.name,
      description: tool.description,
      owner: "host",
      inputSchema: object(tool.parameters),
    })),
    transcript,
    input,
    settings: {
      ...configuration.settings,
      effort,
      maxOutputTokens:
        options.maxTokens === undefined
          ? configuration.settings.maxOutputTokens
          : configuration.settings.maxOutputTokens === undefined
            ? options.maxTokens
            : Math.min(
                options.maxTokens,
                configuration.settings.maxOutputTokens,
              ),
    },
    auth: configuration.auth,
    signal: options.signal,
  };
}

/** Hooks can change model input, but never credentials, session ownership or cancellation. */
export function payloadForHook(request: HostRoundRequest): HostRoundRequest {
  const payload = structuredClone({ ...request, signal: undefined });
  const redact = (values: Readonly<Record<string, string>> | undefined) =>
    values === undefined
      ? undefined
      : Object.fromEntries(
          Object.keys(values).map((key) => [key, "[redacted]"]),
        );
  payload.auth =
    request.auth.mode === "api-key"
      ? { ...request.auth, apiKey: "[redacted]" }
      : { ...request.auth };
  payload.settings.userMcpServers = payload.settings.userMcpServers.map(
    (server) => ({
      ...server,
      config:
        server.config.type === "stdio"
          ? { ...server.config, env: redact(server.config.env) }
          : { ...server.config, headers: redact(server.config.headers) },
    }),
  );
  return { ...payload, signal: request.signal };
}
export function replacementRequest(
  replacement: unknown,
  request: HostRoundRequest,
): HostRoundRequest {
  if (
    typeof replacement !== "object" ||
    replacement === null ||
    Array.isArray(replacement)
  )
    throw new Error("onPayload must return a HostRoundRequest");
  const candidate = replacement as HostRoundRequest;
  const publicRequest = payloadForHook(request);
  for (const key of ["roundId", "session", "cwd", "auth", "settings"] as const)
    if (JSON.stringify(candidate[key]) !== JSON.stringify(publicRequest[key]))
      throw new Error(`onPayload cannot replace ${key}`);
  if (
    typeof candidate.model !== "string" ||
    !candidate.model ||
    typeof candidate.systemPrompt !== "string" ||
    !Array.isArray(candidate.tools) ||
    !Array.isArray(candidate.transcript)
  )
    throw new Error("onPayload returned invalid model input");
  for (const tool of candidate.tools) {
    if (
      tool.owner !== "host" ||
      typeof tool.name !== "string" ||
      typeof tool.description !== "string"
    )
      throw new Error("onPayload returned an invalid host tool");
    object(tool.inputSchema);
    if (
      !request.tools.some(
        (original) => JSON.stringify(original) === JSON.stringify(tool),
      )
    )
      throw new Error(
        "onPayload cannot expose tools outside Pi's effective inventory",
      );
  }
  const record = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  const userBlock = (value: unknown): boolean =>
    record(value) &&
    (value.type === "text"
      ? typeof value.text === "string"
      : value.type === "image" &&
        typeof value.data === "string" &&
        typeof value.mimeType === "string");
  const userContent = (value: unknown): boolean =>
    Array.isArray(value) && value.every(userBlock);
  const assistantContent = (value: unknown): boolean =>
    Array.isArray(value) &&
    value.every(
      (block: unknown) =>
        userBlock(block) ||
        (record(block) &&
          (block.type === "thinking"
            ? typeof block.thinking === "string" &&
              (block.signature === undefined ||
                typeof block.signature === "string") &&
              (block.redacted === undefined ||
                typeof block.redacted === "boolean")
            : block.type === "tool_call" &&
              typeof block.id === "string" &&
              typeof block.name === "string" &&
              record(block.arguments))),
    );
  const resultContent = (value: unknown): boolean =>
    Array.isArray(value) &&
    value.every(
      (block: unknown) =>
        userBlock(block) ||
        (record(block) &&
          (block.type === "audio"
            ? typeof block.data === "string" &&
              typeof block.mimeType === "string"
            : block.type === "resource"
              ? record(block.resource) && typeof block.resource.uri === "string"
              : block.type === "resource_link" &&
                typeof block.uri === "string" &&
                typeof block.name === "string")),
    );
  const result = (value: unknown): boolean =>
    record(value) &&
    typeof value.toolCallId === "string" &&
    typeof value.toolName === "string" &&
    typeof value.isError === "boolean" &&
    resultContent(value.content) &&
    (value.structuredContent === undefined ||
      record(value.structuredContent)) &&
    (value._meta === undefined || record(value._meta));
  if (
    !candidate.input ||
    (candidate.input.kind === "prompt"
      ? !userContent(candidate.input.content)
      : candidate.input.kind !== "tool-results" ||
        !Array.isArray(candidate.input.results) ||
        !candidate.input.results.every(result) ||
        (candidate.input.steering !== undefined &&
          !userContent(candidate.input.steering)))
  )
    throw new Error("onPayload returned invalid round input");
  for (const message of candidate.transcript) {
    if (!record(message)) throw new Error("Invalid onPayload transcript");
    if (message.role === "user" || message.role === "developer") {
      if (!userContent(message.content))
        throw new Error("Invalid onPayload transcript");
    } else if (message.role === "assistant") {
      if (
        !assistantContent(message.content) ||
        (message.stopReason !== undefined &&
          (typeof message.stopReason !== "string" ||
            !["stop", "toolUse", "length", "error", "aborted"].includes(
              message.stopReason,
            ))) ||
        (message.errorMessage !== undefined &&
          typeof message.errorMessage !== "string")
      )
        throw new Error("Invalid onPayload assistant history");
    } else if (message.role !== "tool_result" || !result(message))
      throw new Error("Invalid onPayload transcript role");
  }
  json({
    model: candidate.model,
    systemPrompt: candidate.systemPrompt,
    tools: candidate.tools,
    transcript: candidate.transcript,
    input: candidate.input,
  });
  return {
    ...request,
    ...structuredClone({
      model: candidate.model,
      systemPrompt: candidate.systemPrompt,
      tools: candidate.tools,
      transcript: candidate.transcript,
      input: candidate.input,
    }),
  };
}
