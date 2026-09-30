import { withSignal } from "./lifecycle.js";
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
  restoration?: "runtime-managed" | "user-history-replay";
  activity?(): void;
  failure?(): Error | undefined;
  observe?(event: ClaudeDriverEvent): void;
  terminal?(reason: AssistantMessage["stopReason"]): void | Promise<void>;
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
  function reconcile(index: number, content: AssistantContent): void {
    const block = message.content[index];
    const next = nativeContent(content);
    if (block.type !== next.type)
      throw new Error("Claude snapshot conflicts with OMP content type");
    if (
      (block.type === "text" && next.type === "text") ||
      (block.type === "thinking" && next.type === "thinking")
    ) {
      const currentText = block.type === "text" ? block.text : block.thinking;
      const nextText = next.type === "text" ? next.text : next.thinking;
      if (
        !nextText.startsWith(currentText) &&
        !currentText.startsWith(nextText)
      )
        throw new Error(
          "Claude snapshot conflicts with already emitted OMP content",
        );
      const delta = nextText.startsWith(currentText)
        ? nextText.slice(currentText.length)
        : "";
      if (delta && ended.has(index))
        throw new Error(
          "Claude snapshot changed a completed OMP content block",
        );
      if (
        block.type === "thinking" &&
        next.type === "thinking" &&
        next.thinkingSignature !== undefined
      ) {
        if (
          ended.has(index) &&
          block.thinkingSignature !== next.thinkingSignature
        )
          throw new Error("Claude snapshot changed a completed OMP signature");
        block.thinkingSignature = next.thinkingSignature;
      }
      if (delta) {
        if (block.type === "text") {
          block.text += delta;
          stream.push({
            type: "text_delta",
            contentIndex: index,
            delta,
            partial: snapshot(),
          });
        } else {
          block.thinking += delta;
          stream.push({
            type: "thinking_delta",
            contentIndex: index,
            delta,
            partial: snapshot(),
          });
        }
      }
    } else if (JSON.stringify(block) !== JSON.stringify(next))
      throw new Error(
        "Claude snapshot conflicts with already emitted OMP content",
      );
  }
  function set(key: string, block: AssistantContent): number | undefined {
    if (block.type === "tool_call") return undefined;
    let index = slots.get(key);
    if (index === undefined) {
      index = message.content.length;
      slots.set(key, index);
      const initial = nativeContent(block);
      if (initial.type === "text") initial.text = "";
      if (initial.type === "thinking") {
        initial.thinking = "";
        initial.thinkingSignature = undefined;
      }
      message.content.push(initial);
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
    }
    reconcile(index, block);
    return index;
  }
  function hostCall(
    call: Extract<AssistantContent, { type: "tool_call" }>,
  ): void {
    if (!allowed.has(call.name))
      throw new Error(`Claude requested inactive OMP tool ${call.name}`);
    if (toolIds.has(call.id)) {
      const previous = message.content.find(
        (block) => block.type === "toolCall" && block.id === call.id,
      );
      if (JSON.stringify(previous) !== JSON.stringify(nativeContent(call)))
        throw new Error(`Conflicting host tool call ${call.id}`);
      return;
    }
    toolIds.add(call.id);
    const index = message.content.length;
    message.content.push(nativeContent(call));
    stream.push({
      type: "toolcall_start",
      contentIndex: index,
      partial: snapshot(),
    });
    end(index);
  }
  void (async () => {
    try {
      stream.push({ type: "start", partial: snapshot() });
      for await (let item of runtime.streamRound(request)) {
        if (stream.done) break;
        if (item.type === "round_end") {
          const failure = observation.failure?.();
          if (failure)
            item = {
              ...item,
              reason: "error",
              error: { code: "timeout", message: failure.message },
            };
          // Core order owns history. MCP parking can arrive after later text blocks.
          const finalContent: AssistantMessage["content"] = [];
          const used = new Set<number>();
          for (const block of item.content) {
            if (block.type === "tool_call") {
              if (!item.pendingToolCallIds.includes(block.id)) continue;
              hostCall(block);
              const index = message.content.findIndex(
                (previous) =>
                  previous.type === "toolCall" && previous.id === block.id,
              );
              used.add(index);
              finalContent.push(message.content[index]);
              continue;
            }
            const next = nativeContent(block);
            const text = (value: AssistantMessage["content"][number]) =>
              value.type === "text"
                ? value.text
                : value.type === "thinking"
                  ? value.thinking
                  : undefined;
            let index = message.content.findIndex(
              (previous, position) =>
                !used.has(position) &&
                previous.type === next.type &&
                (text(previous) !== undefined
                  ? text(previous) === text(next)
                  : JSON.stringify(previous) === JSON.stringify(next)),
            );
            if (index === -1)
              index = message.content.findIndex(
                (previous, position) =>
                  !used.has(position) &&
                  previous.type === next.type &&
                  text(previous) !== undefined &&
                  text(next)?.startsWith(text(previous) ?? ""),
              );
            if (index === -1)
              index = message.content.findIndex(
                (previous, position) =>
                  !used.has(position) && previous.type === next.type,
              );
            if (index === -1)
              index = set(`terminal:${finalContent.length}`, block) ?? -1;
            if (index >= 0) {
              reconcile(index, block);
              used.add(index);
              if (!(next.type === "text" && next.text === ""))
                finalContent.push(message.content[index]);
            }
          }
          // Preserve meaningful completed output when a partial terminal omits it.
          message.content.forEach((block, index) => {
            if (
              !used.has(index) &&
              !(block.type === "text" && block.text === "")
            )
              finalContent.push(block);
          });
          for (let index = 0; index < message.content.length; index++)
            end(index);
          message = {
            ...message,
            content: structuredClone(finalContent),
            model: item.model ?? message.model,
            stopReason: item.reason,
            usage: usage(item.usage),
            ...(item.error ? { errorMessage: item.error.message } : {}),
          };
          await observation.terminal?.(item.reason);
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
        observation.activity?.();
        const event = item.event;
        const mainEvent =
          !event.attribution.parentToolUseId && !event.attribution.agentId;
        if (mainEvent) {
          if (event.type === "initialized")
            observation.claudeSessionId = event.claudeSessionId;
          else if (event.attribution.claudeSessionId)
            observation.claudeSessionId = event.attribution.claudeSessionId;
        }
        // Startup transport diagnostics can precede initialization. Wait for the
        // authoritative main session identity, or report an actual startup failure
        // without fabricating one.
        if (
          !responded &&
          (observation.claudeSessionId ||
            (mainEvent &&
              (event.type === "initialized" ||
                event.type === "session_error" ||
                event.type === "session_closed")))
        ) {
          responded = true;
          await withSignal(
            Promise.resolve(
              options.onResponse?.(
                {
                  status: 0,
                  headers: {
                    "x-pi-claude-transport":
                      observation.driver === "cli" ? "stdio" : "sdk",
                    "x-pi-claude-driver": observation.driver,
                    ...(observation.claudeSessionId
                      ? {
                          "x-pi-claude-session-id": observation.claudeSessionId,
                        }
                      : {}),
                  },
                  metadata: {
                    transport: observation.driver === "cli" ? "stdio" : "sdk",
                    driver: observation.driver,
                    steering: "unsupported",
                    restoration: observation.restoration ?? "runtime-managed",
                    cost: "Claude reported USD estimate; not subscription billing",
                  },
                },
                model,
                request.signal,
              ),
            ),
            request.signal,
          );
        }
        observation.observe?.(event);
        if (event.attribution.parentToolUseId || event.attribution.agentId)
          continue;
        switch (event.type) {
          case "message_start":
            if (event.model) message.model = event.model;
            break;
          case "content_start":
            set(`${event.messageId}:${event.index}`, event.content);
            break;
          case "content_delta": {
            const index = slots.get(`${event.messageId}:${event.index}`);
            if (index === undefined) break;
            const block = message.content[index];
            if (event.delta.kind === "text" && block.type === "text")
              reconcile(index, {
                type: "text",
                text: block.text + event.delta.text,
              });
            else if (
              event.delta.kind === "thinking" &&
              block.type === "thinking"
            )
              reconcile(index, {
                type: "thinking",
                thinking: block.thinking + event.delta.thinking,
                signature: block.thinkingSignature,
              });
            else if (
              event.delta.kind === "signature" &&
              block.type === "thinking"
            ) {
              if (ended.has(index))
                throw new Error(
                  "Claude delta changed a completed OMP signature",
                );
              block.thinkingSignature =
                (block.thinkingSignature ?? "") + event.delta.signature;
            }
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
          case "host_tool_request":
            hostCall(event.call);
            break;
        }
      }
      throw new Error("Claude runtime ended without a provider round terminal");
    } catch (error) {
      const failure = observation.failure?.();
      const reason = !failure && request.signal?.aborted ? "aborted" : "error";
      message.stopReason = reason;
      message.errorMessage =
        failure?.message ??
        (error instanceof Error ? error.message : "Claude OMP adapter failed");
      try {
        await runtime.invalidate(
          request.session,
          reason === "aborted" ? "abort" : "reset",
        );
      } catch {
        /* Preserve the original stream failure. */
      }
      try {
        await observation.terminal?.(reason);
      } catch {
        /* Always settle the native stream even if cleanup UI fails. */
      }
      stream.push({ type: "error", reason, error: snapshot() });
      stream.end();
    }
  })();
  return stream;
}
