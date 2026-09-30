import type {
  AssistantContent,
  ClaudeEventNormalizer,
  ClaudeEventNormalizerOptions,
  ContentDelta,
  EventAttribution,
  JsonObject,
  JsonValue,
  RuntimeError,
  UnsequencedClaudeDriverEvent as Event,
  Usage,
} from "../contracts/index.js";

type RecordValue = Record<string, unknown>;
interface BlockState {
  content?: AssistantContent;
  ended: boolean;
  snapshotSeen: boolean;
}
interface MessageState {
  id: string;
  model?: string;
  blocks: Map<number, BlockState>;
  ended: boolean;
  usage?: Usage;
  stopReason?: string;
}

function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined;
}
function string(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}
function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
function redact(text: string): string {
  return text
    .replace(/\b(?:sk-ant-|sk-)[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, "$1 [redacted]")
    .replace(
      /((?:api[_-]?key|token|password|secret|authorization)\s*[=:]\s*)[^\s,;]+/gi,
      "$1[redacted]",
    )
    .slice(0, 512);
}
function diagnostic(
  value: unknown,
  depth = 0,
  budget = { left: 4096 },
): JsonValue {
  if (budget.left <= 0 || depth > 4) return "[bounded]";
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const text = redact(value).slice(0, budget.left);
    budget.left -= text.length;
    return text;
  }
  if (Array.isArray(value))
    return value
      .slice(0, 32)
      .map((item) => diagnostic(item, depth + 1, budget));
  const object = record(value);
  if (!object) return null;
  const result: JsonObject = {};
  for (const [key, item] of Object.entries(object).slice(0, 32)) {
    budget.left -= key.length;
    if (budget.left <= 0) break;
    result[key.slice(0, 80)] =
      /key|token|secret|password|authorization|cookie|env|headers/i.test(key)
        ? "[redacted]"
        : diagnostic(item, depth + 1, budget);
  }
  return result;
}
function json(value: unknown, depth = 0): JsonValue | undefined {
  if (depth > 64) return undefined;
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number")
    return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    const items = value.map((item) => json(item, depth + 1));
    return items.some((item) => item === undefined)
      ? undefined
      : (items as JsonValue[]);
  }
  const object = record(value);
  if (!object) return undefined;
  const result: JsonObject = {};
  for (const [key, item] of Object.entries(object)) {
    const parsed = json(item, depth + 1);
    if (parsed === undefined) return undefined;
    result[key] = parsed;
  }
  return result;
}
function jsonObject(value: unknown): JsonObject | undefined {
  const parsed = record(value) ? json(value) : undefined;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed
    : undefined;
}
function usage(
  value: unknown,
  envelope?: RecordValue,
  prior?: Usage,
): Usage | undefined {
  const data = record(value);
  if (!data && !envelope?.modelUsage && envelope?.total_cost_usd === undefined)
    return prior;
  return {
    inputTokens:
      data?.input_tokens === undefined
        ? (prior?.inputTokens ?? 0)
        : number(data.input_tokens),
    outputTokens:
      data?.output_tokens === undefined
        ? (prior?.outputTokens ?? 0)
        : number(data.output_tokens),
    cacheReadTokens:
      data?.cache_read_input_tokens === undefined
        ? (prior?.cacheReadTokens ?? 0)
        : number(data.cache_read_input_tokens),
    cacheWriteTokens:
      data?.cache_creation_input_tokens === undefined
        ? (prior?.cacheWriteTokens ?? 0)
        : number(data.cache_creation_input_tokens),
    ...(data?.reasoning_tokens !== undefined
      ? { reasoningTokens: number(data.reasoning_tokens) }
      : {}),
    ...(envelope?.total_cost_usd !== undefined
      ? { costUsd: number(envelope.total_cost_usd) }
      : {}),
    ...(jsonObject(envelope?.modelUsage)
      ? { modelUsage: jsonObject(envelope?.modelUsage) }
      : {}),
  };
}
function attribution(data: RecordValue): EventAttribution {
  return {
    ...(string(data.session_id)
      ? { claudeSessionId: string(data.session_id) }
      : {}),
    ...(string(data.user_message_uuid) || string(data.turn_id)
      ? { turnId: string(data.user_message_uuid) ?? string(data.turn_id) }
      : {}),
    ...(data.parent_tool_use_id === null || string(data.parent_tool_use_id)
      ? { parentToolUseId: data.parent_tool_use_id as string | null }
      : {}),
    ...(string(data.tool_use_id)
      ? { toolUseId: string(data.tool_use_id) }
      : {}),
    ...(string(data.task_id) ? { taskId: string(data.task_id) } : {}),
    ...(string(data.agent_id) ? { agentId: string(data.agent_id) } : {}),
  };
}

/** Version-neutral envelope parsing shared by CLI and SDK. Never infers an MCP park. */
export function createClaudeEventNormalizer(
  options: ClaudeEventNormalizerOptions,
): ClaudeEventNormalizer {
  const messages = new Map<string, MessageState>();
  const active = new Map<string, string>();
  const snapshots = new Set<string>();
  const results = new Set<string>();
  const terminalContexts = new Set<string>();
  const tools = new Set(options.tools.map((tool) => tool.name));
  const prefix = `mcp__${options.hostMcpServerName}__`;
  let initializedId: string | undefined;
  let generation = 0;
  const context = (a: EventAttribution): string =>
    `${a.claudeSessionId ?? initializedId ?? ""}:${a.parentToolUseId ?? a.agentId ?? "main"}`;
  const fail = (
    message: string,
    a: EventAttribution,
    code: RuntimeError["code"] = "protocol",
  ): Event => ({
    type: "session_error",
    error: { code, message: redact(message) },
    attribution: a,
  });
  const observe = (
    family: Extract<Event, { type: "observation" }>["family"],
    subtype: string,
    data: unknown,
    a: EventAttribution,
  ): Event => ({
    type: "observation",
    family,
    subtype,
    data: diagnostic(data) as JsonObject,
    attribution: a,
  });
  const unknown = (data: RecordValue, a: EventAttribution): Event =>
    observe(
      "diagnostic",
      "unknown-event",
      {
        type: data.type,
        subtype: data.subtype,
        fields: Object.keys(data).slice(0, 32),
      },
      a,
    );
  const content = (
    value: unknown,
    a: EventAttribution,
    events: Event[],
  ): AssistantContent | undefined => {
    const block = record(value);
    if (!block) {
      events.push(fail("Malformed assistant content block", a));
      return;
    }
    switch (block.type) {
      case "text":
        if (typeof block.text === "string")
          return { type: "text", text: block.text };
        break;
      case "thinking":
        if (typeof block.thinking === "string")
          return {
            type: "thinking",
            thinking: block.thinking,
            ...(typeof block.signature === "string"
              ? { signature: block.signature }
              : {}),
          };
        break;
      case "redacted_thinking":
        if (typeof block.data === "string")
          return { type: "thinking", thinking: block.data, redacted: true };
        break;
      case "image": {
        const source = record(block.source);
        if (
          source?.type === "base64" &&
          typeof source.data === "string" &&
          typeof source.media_type === "string"
        )
          return {
            type: "image",
            data: source.data,
            mimeType: source.media_type,
          };
        break;
      }
      case "tool_use": {
        const id = string(block.id),
          name = string(block.name),
          input = jsonObject(block.input);
        if (!id || !name || !input) {
          events.push(
            fail(
              "Tool use requires id, name and object input",
              a,
              "tool-correlation",
            ),
          );
          return;
        }
        if (
          !a.parentToolUseId &&
          !a.agentId &&
          name.startsWith(prefix) &&
          tools.has(name.slice(prefix.length))
        )
          return {
            type: "tool_call",
            id,
            name: name.slice(prefix.length),
            arguments: input,
          };
        events.push(
          observe(
            "tool-progress",
            "claude-tool-proposal",
            {
              tool_use_id: id,
              tool_name: name,
              owner: a.parentToolUseId || a.agentId ? "subagent" : "claude",
            },
            { ...a, toolUseId: id },
          ),
        );
        return;
      }
      default:
        events.push(
          observe("diagnostic", "unknown-content", { type: block.type }, a),
        );
        return;
    }
    events.push(fail(`Malformed ${String(block.type)} content`, a));
  };
  const state = (id: string, model?: string): MessageState => {
    let existing = messages.get(id);
    if (!existing) {
      existing = { id, blocks: new Map(), ended: false, model };
      messages.set(id, existing);
    }
    if (model) existing.model = model;
    return existing;
  };
  return {
    normalize(payload: unknown): readonly Event[] {
      const data = record(payload);
      if (!data || !string(data.type))
        return [fail("Claude envelope requires a type", {})];
      const a = attribution(data),
        ctx = context(a),
        events: Event[] = [];
      if (data.type === "system" && data.subtype === "init") {
        const id = string(data.session_id),
          model = string(data.model),
          version = string(data.claude_code_version);
        if (
          !id ||
          !model ||
          !version ||
          !Array.isArray(data.tools) ||
          !Array.isArray(data.mcp_servers)
        )
          return [
            fail(
              "Initialization requires session_id, model, runtime version, tools and MCP servers",
              a,
            ),
          ];
        initializedId = id;
        const servers: { name: string; status: string; source?: string }[] = [];
        for (const item of data.mcp_servers) {
          const server = record(item);
          if (!server || !string(server.name) || !string(server.status)) {
            events.push(fail("Malformed MCP initialization status", a));
            continue;
          }
          servers.push({
            name: server.name as string,
            status: server.status as string,
            ...(string(server.source) ? { source: string(server.source) } : {}),
          });
        }
        events.unshift({
          type: "initialized",
          claudeSessionId: id,
          model,
          runtimeVersion: version,
          tools: strings(data.tools),
          capabilities: strings(data.capabilities),
          mcpServers: servers,
          ...(string(data.apiKeySource)
            ? { authSource: string(data.apiKeySource) }
            : {}),
          attribution: { ...a, claudeSessionId: id },
        });
        for (const server of servers.filter((server) =>
          /failed|error|disconnected/i.test(server.status),
        ))
          events.push(
            fail(
              `MCP server ${server.name} initialization ${server.status}`,
              a,
              "runtime",
            ),
          );
        return events;
      }
      if (data.type === "stream_event") {
        const event = record(data.event);
        if (!event || !string(event.type))
          return [fail("Stream envelope requires event.type", a)];
        if (event.type === "message_start") {
          const message = record(event.message),
            id = string(message?.id);
          if (!id) return [fail("message_start requires message.id", a)];
          const prior = messages.get(`${ctx}:${id}`);
          if (prior) return [];
          if (terminalContexts.delete(ctx)) generation++;
          active.set(ctx, id);
          const messageState = state(`${ctx}:${id}`, string(message?.model));
          messageState.usage = usage(message?.usage);
          return [
            {
              type: "message_start",
              messageId: id,
              ...(messageState.model ? { model: messageState.model } : {}),
              attribution: { ...a, messageId: id },
            },
          ];
        }
        const id = string(event.message_id) ?? active.get(ctx);
        if (!id)
          return event.type === "ping"
            ? []
            : [fail("Stream content requires an active message ID", a)];
        const message = state(`${ctx}:${id}`),
          attr = { ...a, messageId: id };
        if (message.ended || terminalContexts.has(ctx)) return [];
        const index = event.index;
        if (
          [
            "content_block_start",
            "content_block_delta",
            "content_block_stop",
          ].includes(event.type as string) &&
          (typeof index !== "number" || !Number.isInteger(index) || index < 0)
        )
          return [
            fail("Content event requires a nonnegative integer index", attr),
          ];
        if (event.type === "content_block_start") {
          if (message.blocks.has(index as number)) return [];
          const block = content(event.content_block, attr, events);
          message.blocks.set(index as number, {
            content: block,
            ended: false,
            snapshotSeen: false,
          });
          if (block)
            events.push({
              type: "content_start",
              messageId: id,
              index: index as number,
              content: { ...block },
              attribution: attr,
            });
        } else if (event.type === "content_block_delta") {
          const block = message.blocks.get(index as number),
            delta = record(event.delta);
          if (!block || !delta)
            return [
              fail("Delta requires a started block and delta object", attr),
            ];
          if (block.ended || !block.content) return [];
          let normalized: ContentDelta | undefined;
          if (
            delta.type === "text_delta" &&
            typeof delta.text === "string" &&
            block.content.type === "text"
          ) {
            normalized = { kind: "text", text: delta.text };
            block.content.text += delta.text;
          } else if (
            delta.type === "thinking_delta" &&
            typeof delta.thinking === "string" &&
            block.content.type === "thinking"
          ) {
            normalized = { kind: "thinking", thinking: delta.thinking };
            block.content.thinking += delta.thinking;
          } else if (
            delta.type === "signature_delta" &&
            typeof delta.signature === "string" &&
            block.content.type === "thinking"
          ) {
            normalized = { kind: "signature", signature: delta.signature };
            block.content.signature =
              (block.content.signature ?? "") + delta.signature;
          } else if (
            delta.type === "input_json_delta" &&
            typeof delta.partial_json === "string" &&
            block.content.type === "tool_call"
          )
            normalized = {
              kind: "tool-input",
              partialJson: delta.partial_json,
            };
          else
            return [
              observe(
                "diagnostic",
                "unknown-delta",
                { type: delta.type },
                attr,
              ),
            ];
          events.push({
            type: "content_delta",
            messageId: id,
            index: index as number,
            delta: normalized,
            attribution: attr,
          });
        } else if (event.type === "content_block_stop") {
          const block = message.blocks.get(index as number);
          if (!block)
            return [fail("Block stop requires a started block", attr)];
          if (!block.ended) {
            block.ended = true;
            if (block.content)
              events.push({
                type: "content_end",
                messageId: id,
                index: index as number,
                attribution: attr,
              });
          }
        } else if (event.type === "message_delta") {
          message.usage = usage(event.usage, undefined, message.usage);
          message.stopReason = string(record(event.delta)?.stop_reason);
        } else if (event.type === "message_stop") {
          message.ended = true;
          events.push({
            type: "message_end",
            messageId: id,
            ...(message.stopReason ? { stopReason: message.stopReason } : {}),
            ...(message.usage ? { usage: message.usage } : {}),
            attribution: attr,
          });
        } else if (event.type !== "ping") events.push(unknown(event, attr));
        return events;
      }
      if (data.type === "assistant") {
        const raw = record(data.message),
          id = string(raw?.id);
        if (!raw || !id || !Array.isArray(raw.content))
          return [
            fail("Assistant snapshot requires message.id and content array", a),
          ];
        const key = `${ctx}:${id}`,
          existing = messages.get(key);
        if (terminalContexts.has(ctx) && existing) return [];
        if (terminalContexts.delete(ctx)) generation++;
        const snapshotId = string(data.uuid),
          snapshotKey = `${ctx}:${snapshotId}`;
        if (snapshotId && snapshots.has(snapshotKey)) return [];
        if (snapshotId) snapshots.add(snapshotKey);
        // A late canonical snapshot can reconcile a known older message while a
        // newer message is streaming. Don't redirect its unlabelled deltas.
        const activeId = active.get(ctx);
        if (!existing || !activeId || activeId === id) active.set(ctx, id);
        const message = state(key, string(raw.model)),
          attr = { ...a, messageId: id };
        const parsed: AssistantContent[] = [],
          indexes: number[] = [];
        const full = raw.content.length > 1 || raw.stop_reason != null;
        for (let i = 0; i < raw.content.length; i++) {
          const block = content(raw.content[i], attr, events);
          if (!block) continue;
          let index = i;
          if (!full) {
            const match = [...message.blocks.entries()].find(
              ([, candidate]) =>
                !candidate.snapshotSeen &&
                candidate.content?.type === block.type &&
                (block.type !== "tool_call" ||
                  (candidate.content.type === "tool_call" &&
                    candidate.content.id === block.id)),
            );
            if (match) index = match[0];
            else
              index = message.blocks.size
                ? Math.max(...message.blocks.keys()) + 1
                : 0;
          }
          const prior = message.blocks.get(index);
          if (
            !snapshotId &&
            prior?.snapshotSeen &&
            JSON.stringify(prior.content) === JSON.stringify(block)
          )
            continue;
          message.blocks.set(index, {
            content: block,
            ended: true,
            snapshotSeen: true,
          });
          parsed.push(block);
          indexes.push(index);
        }
        message.usage = usage(raw.usage, undefined, message.usage);
        if (parsed.length || Array.isArray(data.supersedes))
          events.push({
            type: "assistant_snapshot",
            messageId: id,
            ...(snapshotId ? { snapshotId } : {}),
            content: parsed,
            contentIndexes: indexes,
            ...(message.model ? { model: message.model } : {}),
            ...(message.usage ? { usage: message.usage } : {}),
            ...(Array.isArray(data.supersedes)
              ? { supersedes: strings(data.supersedes) }
              : {}),
            attribution: attr,
          });
        const stopReason = string(raw.stop_reason);
        if (stopReason && !message.ended) {
          message.ended = true;
          message.stopReason = stopReason;
          events.push({
            type: "message_end",
            messageId: id,
            stopReason,
            ...(message.usage ? { usage: message.usage } : {}),
            attribution: attr,
          });
        }
        if (string(data.error))
          events.push({
            type: "session_error",
            error: {
              code: /auth|oauth|credential/.test(data.error as string)
                ? "auth"
                : "runtime",
              message: redact(
                typeof raw.content[0]?.text === "string"
                  ? raw.content[0].text
                  : (data.error as string),
              ),
              subtype: data.error as string,
            },
            attribution: attr,
          });
        return events;
      }
      if (data.type === "result") {
        const subtype = string(data.subtype);
        if (!subtype || typeof data.is_error !== "boolean")
          return [fail("Result requires subtype and is_error", a)];
        const resultKey = `${ctx}:${string(data.uuid) ?? a.turnId ?? data.result_index ?? generation}`;
        if (results.has(resultKey) || terminalContexts.has(ctx)) return [];
        results.add(resultKey);
        terminalContexts.add(ctx);
        const aborted =
          /abort|interrupt|cancel/.test(subtype) ||
          /abort|interrupt|cancel/.test(String(data.terminal_reason));
        const isError = data.is_error || subtype !== "success";
        const errorText =
          strings(data.errors).map(redact).join("; ") ||
          (typeof data.result === "string"
            ? redact(data.result)
            : `Claude turn ended: ${subtype}`);
        return [
          {
            type: "turn_end",
            status: aborted ? "aborted" : isError ? "error" : "success",
            subtype,
            isError: isError || aborted,
            ...(typeof data.result === "string"
              ? {
                  resultText:
                    isError || aborted ? redact(data.result) : data.result,
                }
              : {}),
            model:
              string(data.model) ??
              messages.get(`${ctx}:${active.get(ctx)}`)?.model ??
              options.requestedModel,
            ...(usage(data.usage, data)
              ? { usage: usage(data.usage, data) }
              : {}),
            ...(isError || aborted
              ? {
                  error: {
                    code: aborted
                      ? "aborted"
                      : /auth|credential|oauth/.test(errorText)
                        ? "auth"
                        : "runtime",
                    message: errorText,
                    subtype,
                  } as RuntimeError,
                }
              : {}),
            attribution: a,
          },
        ];
      }
      if (data.type === "user") return [observe("user-input", "user", data, a)];
      if (data.type === "rate_limit_event")
        return [observe("rate-limit", "rate_limit_event", data, a)];
      if (data.type === "tool_progress" && !string(data.tool_use_id))
        return [
          fail("Tool progress requires tool_use_id", a, "tool-correlation"),
        ];
      if (data.type === "tool_progress" || data.type === "tool_use_summary")
        return [observe("tool-progress", data.type, data, a)];
      if (data.type === "auth_status")
        return [observe("status", "auth_status", data, a)];
      if (data.type === "system") {
        const subtype = string(data.subtype);
        if (!subtype) return [fail("System event requires subtype", a)];
        if (subtype === "api_retry")
          return [observe("retry", subtype, data, a)];
        if (subtype.startsWith("task_") && !string(data.task_id))
          return [fail("Task progress requires task_id", a)];
        if (
          subtype.startsWith("task_") ||
          subtype === "background_tasks_changed"
        )
          return [observe("task", subtype, data, a)];
        if (subtype.startsWith("hook_"))
          return [observe("hook", subtype, data, a)];
        if (subtype.includes("compact"))
          return [observe("compaction", subtype, data, a)];
        if (subtype === "conversation_reset") {
          active.delete(ctx);
          terminalContexts.delete(ctx);
          generation++;
          return [observe("reset", subtype, data, a)];
        }
        if (
          [
            "status",
            "session_state_changed",
            "thinking_tokens",
            "notification",
            "informational",
            "commands_changed",
            "worker_shutting_down",
            "permission_denied",
            "elicitation_complete",
            "model_refusal_fallback",
            "model_refusal_no_fallback",
            "local_command_output",
            "control_request_progress",
            "prompt_suggestion",
            "files_persisted",
            "memory_recall",
            "active_goal",
            "mirror_error",
          ].includes(subtype)
        )
          return [observe("status", subtype, data, a)];
      }
      return [unknown(data, a)];
    },
  };
}
