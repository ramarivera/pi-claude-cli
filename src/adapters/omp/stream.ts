import { createAssistantMessageEventStream } from "@oh-my-pi/pi-ai";
import type {
  AssistantMessage,
  AssistantMessageEventStream,
  Model,
  SimpleStreamOptions,
} from "@oh-my-pi/pi-ai";
import type {
  AssistantContent,
  ClaudeDriverEvent,
  ClaudeRuntime,
  HostRoundRequest,
  Usage,
} from "../../contracts/index.js";

export interface StreamObservation {
  driver: "cli" | "sdk";
  claudeSessionId?: string;
  observe?(event: ClaudeDriverEvent): void;
  terminal?(reason: AssistantMessage["stopReason"]): void;
}
function nativeContent(
  block: AssistantContent,
): AssistantMessage["content"][number] {
  switch (block.type) {
    case "thinking":
      return block.redacted
        ? { type: "redactedThinking", data: block.signature ?? "" }
        : {
            type: "thinking",
            thinking: block.thinking,
            thinkingSignature: block.signature,
          };
    case "tool_call":
      return {
        type: "toolCall",
        id: block.id,
        name: block.name,
        arguments: block.arguments,
      };
    default:
      return { ...block };
  }
}
function usage(value?: Usage): AssistantMessage["usage"] {
  const input = value?.inputTokens ?? 0,
    output = value?.outputTokens ?? 0;
  const cacheRead = value?.cacheReadTokens ?? 0,
    cacheWrite = value?.cacheWriteTokens ?? 0;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: value?.costUsd ?? 0,
    },
  };
}

/** Every call owns a native host stream; no module-level stream or session state. */
export function projectRound(
  model: Model,
  request: HostRoundRequest,
  options: SimpleStreamOptions,
  runtime: ClaudeRuntime,
  observation: StreamObservation,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  let message: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    timestamp: Date.now(),
    usage: usage(),
    stopReason: "stop",
  };
  const slots = new Map<string, number>();
  const ended = new Set<number>();
  const allowed = new Set(request.tools.map((tool) => tool.name));
  const toolIds = new Set<string>();
  let responded = false;
  const snapshot = () => structuredClone(message);
  function end(index: number) {
    if (ended.has(index)) return;
    ended.add(index);
    const block = message.content[index];
    if (block.type === "text")
      stream.push({
        type: "text_end",
        contentIndex: index,
        content: block.text,
        partial: snapshot(),
      });
    else if (block.type === "thinking")
      stream.push({
        type: "thinking_end",
        contentIndex: index,
        content: block.thinking,
        partial: snapshot(),
      });
    else if (block.type === "image")
      stream.push({
        type: "image_end",
        contentIndex: index,
        content: block,
        partial: snapshot(),
      });
    else if (block.type === "toolCall")
      stream.push({
        type: "toolcall_end",
        contentIndex: index,
        toolCall: block,
        partial: snapshot(),
      });
  }
  function set(key: string, block: AssistantContent): number | undefined {
    if (block.type === "tool_call") return undefined; // Only parked MCP calls execute in OMP.
    let index = slots.get(key);
    if (index === undefined) {
      index = message.content.length;
      slots.set(key, index);
      message.content.push(nativeContent(block));
      if (block.type === "text")
        stream.push({
          type: "text_start",
          contentIndex: index,
          partial: snapshot(),
        });
      else if (block.type === "thinking" && !block.redacted)
        stream.push({
          type: "thinking_start",
          contentIndex: index,
          partial: snapshot(),
        });
    } else if (!ended.has(index)) message.content[index] = nativeContent(block);
    return index;
  }
  void (async () => {
    try {
      stream.push({ type: "start", partial: snapshot() });
      for await (const item of runtime.streamRound(request)) {
        if (stream.done) break;
        if (item.type === "round_end") {
          // Core is authoritative. Already-ended streamed content remains immutable.
          const final = item.content
            .filter(
              (block) => block.type !== "tool_call" || toolIds.has(block.id),
            )
            .map((block, index) =>
              ended.has(index) && message.content[index]
                ? message.content[index]
                : nativeContent(block),
            );
          message = {
            ...message,
            content: final,
            model: item.model ?? message.model,
            stopReason: item.reason,
            usage: usage(item.usage),
            ...(item.error ? { errorMessage: item.error.message } : {}),
          };
          for (let index = 0; index < message.content.length; index++)
            end(index);
          observation.terminal?.(item.reason);
          if (item.reason === "error" || item.reason === "aborted")
            stream.push({
              type: "error",
              reason: item.reason,
              error: snapshot(),
            });
          else
            stream.push({
              type: "done",
              reason: item.reason,
              message: snapshot(),
            });
          stream.end();
          return;
        }
        const event = item.event;
        if (event.type === "initialized")
          observation.claudeSessionId = event.claudeSessionId;
        if (!responded) {
          responded = true;
          await options.onResponse?.(
            {
              status: 0,
              headers: {
                "x-pi-claude-transport":
                  observation.driver === "cli" ? "stdio" : "sdk",
                "x-pi-claude-driver": observation.driver,
                ...(observation.claudeSessionId
                  ? { "x-pi-claude-session-id": observation.claudeSessionId }
                  : {}),
              },
              metadata: {
                transport: observation.driver === "cli" ? "stdio" : "sdk",
                driver: observation.driver,
                steering: "unsupported",
                restoration: "runtime-managed",
                cost: "Claude reported USD estimate; not subscription billing",
              },
            },
            model,
            request.signal,
          );
        }
        observation.observe?.(event);
        if (event.attribution.parentToolUseId) continue;
        switch (event.type) {
          case "message_start":
            if (event.model) message.model = event.model;
            break;
          case "content_start":
            set(`${event.messageId}:${event.index}`, event.content);
            break;
          case "content_delta": {
            const index = slots.get(`${event.messageId}:${event.index}`);
            if (index === undefined || ended.has(index)) break;
            const block = message.content[index];
            if (event.delta.kind === "text" && block.type === "text") {
              block.text += event.delta.text;
              stream.push({
                type: "text_delta",
                contentIndex: index,
                delta: event.delta.text,
                partial: snapshot(),
              });
            } else if (
              event.delta.kind === "thinking" &&
              block.type === "thinking"
            ) {
              block.thinking += event.delta.thinking;
              stream.push({
                type: "thinking_delta",
                contentIndex: index,
                delta: event.delta.thinking,
                partial: snapshot(),
              });
            } else if (
              event.delta.kind === "signature" &&
              block.type === "thinking"
            )
              block.thinkingSignature = event.delta.signature;
            break;
          }
          case "content_end": {
            const index = slots.get(`${event.messageId}:${event.index}`);
            if (index !== undefined) end(index);
            break;
          }
          case "assistant_snapshot":
            event.content.forEach((block, index) =>
              set(
                `${event.messageId}:${event.contentIndexes?.[index] ?? index}`,
                block,
              ),
            );
            if (event.model) message.model = event.model;
            break;
          case "host_tool_request": {
            const call = event.call;
            if (!allowed.has(call.name))
              throw new Error(
                `Claude requested inactive OMP tool ${call.name}`,
              );
            if (toolIds.has(call.id)) break;
            toolIds.add(call.id);
            const index = message.content.length;
            message.content.push(nativeContent(call));
            stream.push({
              type: "toolcall_start",
              contentIndex: index,
              partial: snapshot(),
            });
            end(index);
            break;
          }
        }
      }
      throw new Error("Claude runtime ended without a provider round terminal");
    } catch (error) {
      const reason = request.signal?.aborted ? "aborted" : "error";
      message.stopReason = reason;
      message.errorMessage =
        error instanceof Error ? error.message : "Claude OMP adapter failed";
      try {
        await runtime.invalidate(
          request.session,
          reason === "aborted" ? "abort" : "reset",
        );
      } catch {
        /* Preserve the original stream failure. */
      }
      observation.terminal?.(reason);
      stream.push({ type: "error", reason, error: snapshot() });
      stream.end();
    }
  })();
  return stream;
}
