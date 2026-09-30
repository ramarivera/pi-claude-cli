import {
  resolveResumePlan,
  type AssistantContent,
  type ClaudeDriverEvent,
  type ClaudeDriverSession,
  type ClaudeRoundEvent,
  type ClaudeRuntime,
  type ClaudeRuntimeOptions,
  type ContentDelta,
  type DriverSessionRequest,
  type HistoryInvalidationReason,
  type HostRoundRequest,
  type HostSessionIdentity,
  type HostToolCall,
  type HostToolResult,
  type InteractionRequest,
  type InteractionResponse,
  type RuntimeError,
  type SessionIdentity,
  type TranscriptMessage,
  type Usage,
} from "../contracts/index.js";
import { Channel } from "./channel.js";
import {
  currentPrompt,
  digest,
  identity,
  messageDigest,
  precedingHistory,
} from "./history.js";

interface Message {
  id: string;
  blocks: Map<number, AssistantContent>;
  partialJson: Map<number, string>;
  snapshotIds: Set<string>;
  snapshotIndexes: Map<string, readonly number[]>;
  ended: boolean;
  model?: string;
  usage?: Usage;
  stopReason?: string;
}
interface ParkedCall {
  call: HostToolCall;
  timer: ReturnType<typeof setTimeout>;
}
interface Round {
  request: HostRoundRequest;
  channel: Channel<ClaudeRoundEvent>;
  messages: Map<string, Message>;
  proposals: Map<string, HostToolCall>;
  done: boolean;
  finished: Promise<void>;
  settle: () => void;
  abort?: () => void;
  proposalTimer?: ReturnType<typeof setTimeout>;
}
interface Session {
  identity: SessionIdentity;
  driver: ClaudeDriverSession;
  request: HostRoundRequest;
  expected: TranscriptMessage[];
  active?: Round;
  backlog: ClaudeDriverEvent[];
  parked: Map<string, ParkedCall>;
  delivered: Map<string, HostToolResult>;
  projectedMessages: Set<string>;
  turnId?: string;
  turnUsage: Usage;
  lastCost?: number;
  sequence: number;
  closed: boolean;
  closing?: Promise<void>;
  pump: Promise<void>;
  failure?: RuntimeError;
  invalidated?: HistoryInvalidationReason;
  operations: Set<Promise<void>>;
}
const zero = (): Usage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});
const tokenKeys = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
] as const;
function add(a: Usage, b: Usage): Usage {
  const sum = { ...a };
  for (const key of tokenKeys) sum[key] += b[key];
  if (b.reasoningTokens !== undefined)
    sum.reasoningTokens = (sum.reasoningTokens ?? 0) + b.reasoningTokens;
  return sum;
}
function error(code: RuntimeError["code"], message: string): RuntimeError {
  return {
    code,
    message: message
      .replace(/\b(?:sk-ant-|sk-)[A-Za-z0-9_-]+/g, "[redacted]")
      .replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, "$1 [redacted]")
      .replace(
        /((?:api[_-]?key|token|password|secret|authorization)\s*[=:]\s*)[^\s,;]+/gi,
        "$1[redacted]",
      )
      .slice(0, 1024),
  };
}
function failure(
  value: unknown,
  code: RuntimeError["code"] = "runtime",
): RuntimeError {
  if (
    value &&
    typeof value === "object" &&
    "code" in value &&
    "message" in value &&
    typeof value.message === "string" &&
    [
      "auth",
      "unsupported",
      "spawn",
      "protocol",
      "transport",
      "timeout",
      "runtime",
      "history",
      "tool-correlation",
      "closed",
      "aborted",
    ].includes(String(value.code))
  )
    return error(value.code as RuntimeError["code"], value.message);
  return error(
    code,
    value instanceof Error ? value.message : "Claude operation failed",
  );
}
function copy(content: AssistantContent): AssistantContent {
  return content.type === "tool_call"
    ? { ...content, arguments: structuredClone(content.arguments) }
    : { ...content };
}
function contentOf(round: Round): AssistantContent[] {
  const output: AssistantContent[] = [],
    ids = new Set<string>();
  for (const message of round.messages.values()) {
    for (const [, content] of [...message.blocks].sort(([a], [b]) => a - b)) {
      if (content.type === "tool_call") {
        if (ids.has(content.id)) continue;
        ids.add(content.id);
        output.push(copy(round.proposals.get(content.id) ?? content));
      } else if (content.type !== "text" || content.text !== "")
        output.push(copy(content));
    }
  }
  for (const call of round.proposals.values())
    if (!ids.has(call.id)) output.push(copy(call));
  return output;
}
function message(round: Round, id: string): Message {
  let existing = round.messages.get(id);
  if (!existing) {
    existing = {
      id,
      blocks: new Map(),
      partialJson: new Map(),
      snapshotIds: new Set(),
      snapshotIndexes: new Map(),
      ended: false,
    };
    round.messages.set(id, existing);
  }
  return existing;
}
function permission(
  request: InteractionRequest,
  round: HostRoundRequest,
): InteractionResponse {
  if (request.kind === "permission") {
    const host = round.tools.some(
      (tool) => request.toolName === `mcp__host__${tool.name}`,
    );
    const native = round.settings.claudeTools.includes(request.toolName);
    const userMcp = round.settings.userMcpServers.some((server) =>
      request.toolName.startsWith(`mcp__${server.name}__`),
    );
    return {
      kind: "permission",
      requestId: request.requestId,
      decision:
        host || native || userMcp
          ? { behavior: "allow", updatedInput: request.input }
          : {
              behavior: "deny",
              message: `Tool ${request.toolName} isn't enabled for this session`,
            },
    };
  }
  if (request.kind === "elicitation")
    return {
      kind: "elicitation",
      requestId: request.requestId,
      decision: { action: "decline" },
    };
  return {
    kind: "unsupported",
    requestId: request.requestId,
    error: `Host dialog ${request.dialogKind} isn't supported`,
  };
}

/** Results in one host batch may be committed in a different completion order. */
function reconcile(
  expected: readonly TranscriptMessage[],
  appended: readonly TranscriptMessage[],
): TranscriptMessage[] | undefined {
  const remaining = [...expected];
  for (const entry of appended) {
    const hash = messageDigest(entry);
    if (entry.role === "tool_result" && remaining[0]?.role === "tool_result") {
      let end = 0;
      while (remaining[end]?.role === "tool_result") end++;
      const index = remaining
        .slice(0, end)
        .findIndex((candidate) => messageDigest(candidate) === hash);
      if (index < 0) return;
      remaining.splice(index, 1);
    } else {
      if (!remaining[0] || messageDigest(remaining[0]) !== hash) return;
      remaining.shift();
    }
  }
  return remaining;
}

/** The selected driver is the only transport; no cross-driver retry or global state. */
export function createClaudeRuntime(
  options: ClaudeRuntimeOptions,
): ClaudeRuntime {
  const sessions = new Map<string, Session>();
  const opening = new Map<string, Promise<Session>>();
  const invalidated = new Map<string, HistoryInvalidationReason>();
  let closed = false;

  const finish = (
    session: Session,
    round: Round,
    reason: Extract<ClaudeRoundEvent, { type: "round_end" }>["reason"],
    runtimeError?: RuntimeError,
    terminal?: Extract<ClaudeDriverEvent, { type: "turn_end" }>,
  ): void => {
    if (round.done) return;
    round.done = true;
    round.settle();
    if (round.proposalTimer) clearTimeout(round.proposalTimer);
    round.request.signal?.removeEventListener(
      "abort",
      round.abort as EventListener,
    );
    const content = contentOf(round);
    let roundUsage: Usage | undefined;
    for (const msg of round.messages.values())
      if (msg.usage) roundUsage = add(roundUsage ?? zero(), msg.usage);
    if (terminal?.usage) {
      // Message usage is per assistant step. Result usage is per turn, while
      // modelUsage/cost are cumulative query reports; never sum their totals.
      const reported = terminal.usage;
      if (tokenKeys.every((key) => reported[key] >= session.turnUsage[key])) {
        const remaining = zero();
        for (const key of tokenKeys)
          remaining[key] = Math.max(0, reported[key] - session.turnUsage[key]);
        if (reported.reasoningTokens !== undefined)
          remaining.reasoningTokens = Math.max(
            0,
            reported.reasoningTokens - (session.turnUsage.reasoningTokens ?? 0),
          );
        roundUsage = remaining;
      }
      if (reported.costUsd !== undefined) {
        roundUsage ??= zero();
        roundUsage.costUsd = Math.max(
          0,
          reported.costUsd - (session.lastCost ?? 0),
        );
        session.lastCost = reported.costUsd;
      }
    }
    if (roundUsage) session.turnUsage = add(session.turnUsage, roundUsage);
    const model =
      [...round.messages.values()].reverse().find((msg) => msg.model)?.model ??
      terminal?.model ??
      round.request.model;
    round.channel.push({
      type: "round_end",
      roundId: round.request.roundId,
      reason,
      content,
      pendingToolCallIds:
        reason === "toolUse" ? [...round.proposals.keys()] : [],
      model,
      ...(roundUsage ? { usage: roundUsage } : {}),
      ...(runtimeError ? { error: runtimeError } : {}),
    });
    round.channel.end();
    for (const id of round.messages.keys())
      if (id !== "result-fallback") session.projectedMessages.add(id);
    session.expected.push({
      role: "assistant",
      content,
      stopReason: reason,
      ...(runtimeError ? { errorMessage: runtimeError.message } : {}),
    });
    if (reason !== "toolUse") session.turnId = undefined;
  };

  const track = (session: Session, operation: Promise<void>): void => {
    session.operations.add(operation);
    void operation
      .catch((cause: unknown) => {
        if (!session.closed) {
          session.failure = failure(cause);
          if (session.active)
            finish(session, session.active, "error", session.failure);
          void dispose(session).catch(() => {});
        }
      })
      .finally(() => session.operations.delete(operation));
  };

  const dispose = (session: Session): Promise<void> => {
    if (session.closing) return session.closing;
    session.closed = true;
    for (const pending of session.parked.values()) clearTimeout(pending.timer);
    session.parked.clear();
    if (session.active && !session.active.done)
      finish(
        session,
        session.active,
        "aborted",
        error("aborted", "Claude session closed"),
      );
    session.closing = (async () => {
      await session.driver.close();
      await session.pump;
      await Promise.allSettled([...session.operations]);
    })();
    return session.closing;
  };

  const abort = (session: Session, round: Round, cause: RuntimeError): void => {
    if (round.done) return;
    session.invalidated ??= "abort";
    finish(
      session,
      round,
      cause.code === "aborted" ? "aborted" : "error",
      cause,
    );
    track(session, session.driver.interrupt(cause.message));
    void dispose(session).catch(() => {});
  };

  const maybeParked = (session: Session, round: Round): void => {
    if (round.done || round.proposals.size === 0 || round.messages.size === 0)
      return;
    if (![...round.messages.values()].every((msg) => msg.ended)) return;
    if ([...round.proposals.keys()].every((id) => session.parked.has(id)))
      finish(session, round, "toolUse");
  };
  const propose = (
    session: Session,
    round: Round,
    call: HostToolCall,
  ): boolean => {
    if (
      !call.id ||
      !round.request.tools.some((tool) => tool.name === call.name)
    ) {
      abort(
        session,
        round,
        error(
          "tool-correlation",
          "Host tool call lacks an authoritative ID or effective tool",
        ),
      );
      return false;
    }
    const prior = round.proposals.get(call.id);
    if (prior && prior.name !== call.name) {
      abort(
        session,
        round,
        error("tool-correlation", `Conflicting host call ${call.id}`),
      );
      return false;
    }
    round.proposals.set(call.id, {
      ...call,
      arguments: structuredClone(call.arguments),
    });
    if (!round.proposalTimer)
      round.proposalTimer = setTimeout(
        () =>
          abort(
            session,
            round,
            error(
              "timeout",
              "Proposed host calls didn't all reach parked MCP handlers",
            ),
          ),
        round.request.settings.toolResultTimeoutMs,
      );
    return true;
  };
  const delta = (
    session: Session,
    round: Round,
    msg: Message,
    index: number,
    change: ContentDelta,
  ): void => {
    const block = msg.blocks.get(index);
    if (!block) {
      abort(
        session,
        round,
        error("protocol", "Content delta lacks a started block"),
      );
      return;
    }
    if (change.kind === "text" && block.type === "text")
      block.text += change.text;
    else if (change.kind === "thinking" && block.type === "thinking")
      block.thinking += change.thinking;
    else if (change.kind === "signature" && block.type === "thinking")
      block.signature = (block.signature ?? "") + change.signature;
    else if (change.kind === "tool-input" && block.type === "tool_call")
      msg.partialJson.set(
        index,
        (msg.partialJson.get(index) ?? "") + change.partialJson,
      );
  };

  const handle = (
    session: Session,
    event: ClaudeDriverEvent,
    replay = false,
  ): void => {
    if (session.closed) return;
    if (event.sequence <= session.sequence) return;
    session.sequence = event.sequence;
    const child = Boolean(
      event.attribution.parentToolUseId || event.attribution.agentId,
    );
    if (event.type === "initialized" && !child) {
      if (
        session.identity.claudeSessionId &&
        session.identity.claudeSessionId !== event.claudeSessionId
      ) {
        session.failure = error(
          "history",
          "Claude initialization replaced the resident session identity",
        );
        if (session.active) abort(session, session.active, session.failure);
        return;
      }
      session.identity.claudeSessionId = event.claudeSessionId;
    }
    if (event.type === "interaction_request" && !replay) {
      if (
        !event.request.requestId ||
        (event.request.kind === "permission" && !event.request.toolUseId)
      ) {
        const cause = error(
          "tool-correlation",
          "Interaction lacks authoritative request/tool IDs",
        );
        if (session.active) abort(session, session.active, cause);
        else {
          session.failure = cause;
          void dispose(session).catch(() => {});
        }
        return;
      }
      track(
        session,
        session.driver.answerInteraction(
          permission(event.request, session.active?.request ?? session.request),
        ),
      );
    }
    if (
      !child &&
      "messageId" in event &&
      session.projectedMessages.has(event.messageId)
    )
      return;
    const round = session.active;
    if (!round || round.done) {
      if (event.type === "session_error") session.failure = event.error;
      if (event.type === "session_closed")
        session.failure = error(
          event.reason === "aborted" ? "aborted" : "closed",
          `Claude session ${event.reason}`,
        );
      if (event.type === "session_error" || event.type === "session_closed") {
        void dispose(session).catch(() => {});
        return;
      }
      if (event.type === "turn_end") {
        if (session.parked.size && !child) {
          session.failure = error(
            "tool-correlation",
            "Claude turn ended while host calls remained parked",
          );
          void dispose(session).catch(() => {});
        }
        return;
      }
      if (
        !session.turnId &&
        [
          "message_start",
          "content_start",
          "content_delta",
          "content_end",
          "assistant_snapshot",
          "message_end",
          "host_tool_request",
        ].includes(event.type)
      )
        return;
      if (session.backlog.length < 256) session.backlog.push(event);
      return;
    }
    if (child) {
      if (event.type === "host_tool_request")
        track(
          session,
          session.driver.deliverToolResults([
            {
              toolCallId: event.call.id,
              toolName: event.call.name,
              content: [
                {
                  type: "text",
                  text: "Host tools aren't exposed to Claude subagents",
                },
              ],
              isError: true,
            },
          ]),
        );
      if (
        round.request.settings.forwardSubagentText ||
        event.type === "observation"
      )
        round.channel.push({
          type: "driver_event",
          roundId: round.request.roundId,
          event,
        });
      return;
    }
    if (
      event.type === "host_tool_request" &&
      session.parked.has(event.call.id)
    ) {
      if (
        digest(session.parked.get(event.call.id)?.call) !== digest(event.call)
      )
        abort(
          session,
          round,
          error("tool-correlation", `Conflicting parked call ${event.call.id}`),
        );
      return;
    }
    round.channel.push({
      type: "driver_event",
      roundId: round.request.roundId,
      event,
    });
    switch (event.type) {
      case "message_start": {
        const msg = message(round, event.messageId);
        msg.model = event.model;
        break;
      }
      case "content_start": {
        const msg = message(round, event.messageId);
        if (!msg.blocks.has(event.index))
          msg.blocks.set(event.index, copy(event.content));
        if (event.content.type === "tool_call")
          propose(session, round, event.content);
        break;
      }
      case "content_delta":
        delta(
          session,
          round,
          message(round, event.messageId),
          event.index,
          event.delta,
        );
        break;
      case "content_end": {
        const msg = message(round, event.messageId),
          block = msg.blocks.get(event.index),
          partial = msg.partialJson.get(event.index);
        if (block?.type === "tool_call" && partial) {
          try {
            const args: unknown = JSON.parse(partial);
            if (!args || typeof args !== "object" || Array.isArray(args))
              throw new Error("Tool input must be an object");
            block.arguments = args as HostToolCall["arguments"];
            propose(session, round, block);
          } catch {
            abort(
              session,
              round,
              error("protocol", "Malformed streamed host tool arguments"),
            );
          }
        }
        break;
      }
      case "assistant_snapshot": {
        const msg = message(round, event.messageId);
        if (event.snapshotId && msg.snapshotIds.has(event.snapshotId)) break;
        if (event.snapshotId) msg.snapshotIds.add(event.snapshotId);
        for (const id of event.supersedes ?? []) {
          for (const [messageId, prior] of round.messages) {
            const positions = prior.snapshotIndexes.get(id);
            if (!positions) continue;
            for (const index of positions) {
              const old = prior.blocks.get(index);
              if (old?.type === "tool_call") {
                if (session.parked.has(old.id)) {
                  abort(
                    session,
                    round,
                    error(
                      "tool-correlation",
                      "Claude retracted a parked host call",
                    ),
                  );
                  return;
                }
                round.proposals.delete(old.id);
              }
              prior.blocks.delete(index);
            }
            prior.snapshotIndexes.delete(id);
            if (prior.blocks.size === 0 && messageId !== event.messageId)
              round.messages.delete(messageId);
          }
        }
        if (event.snapshotId)
          msg.snapshotIndexes.set(
            event.snapshotId,
            event.contentIndexes ?? event.content.map((_, index) => index),
          );
        event.content.forEach((content, index) => {
          const position = event.contentIndexes?.[index] ?? index;
          msg.blocks.set(position, copy(content));
          if (content.type === "tool_call") propose(session, round, content);
        });
        if (event.model) msg.model = event.model;
        if (event.usage) msg.usage = event.usage;
        break;
      }
      case "message_end": {
        const msg = message(round, event.messageId);
        msg.ended = true;
        msg.stopReason = event.stopReason;
        if (event.usage) msg.usage = event.usage;
        maybeParked(session, round);
        break;
      }
      case "host_tool_request": {
        if (session.delivered.has(event.call.id)) {
          abort(
            session,
            round,
            error(
              "tool-correlation",
              "Already completed host call was parked again",
            ),
          );
          break;
        }
        if (!propose(session, round, event.call)) break;
        const timer = setTimeout(() => {
          if (!session.parked.has(event.call.id)) return;
          const cause = error(
            "timeout",
            `Host result missing for ${event.call.id}`,
          );
          if (session.active && !session.active.done)
            abort(session, session.active, cause);
          else {
            session.failure = cause;
            track(session, session.driver.interrupt(cause.message));
            void dispose(session).catch(() => {});
          }
        }, round.request.settings.toolResultTimeoutMs);
        session.parked.set(event.call.id, {
          call: copy(event.call) as HostToolCall,
          timer,
        });
        maybeParked(session, round);
        break;
      }
      case "turn_end": {
        if (
          round.proposals.size &&
          [...round.proposals.keys()].some((id) => !session.delivered.has(id))
        ) {
          abort(
            session,
            round,
            error(
              "tool-correlation",
              "Claude turn ended with unresolved host calls",
            ),
          );
          break;
        }
        if (!round.messages.size && event.resultText)
          message(round, "result-fallback").blocks.set(0, {
            type: "text",
            text: event.resultText,
          });
        const reason =
          event.status === "aborted"
            ? "aborted"
            : event.isError || event.status === "error"
              ? "error"
              : [...round.messages.values()].some(
                    (msg) => msg.stopReason === "max_tokens",
                  )
                ? "length"
                : "stop";
        finish(session, round, reason, event.error, event);
        if (reason === "error" || reason === "aborted") {
          session.invalidated ??= "abort";
          void dispose(session).catch(() => {});
        }
        break;
      }
      case "session_error":
        session.failure = event.error;
        abort(session, round, event.error);
        break;
      case "session_closed":
        abort(
          session,
          round,
          error(
            event.reason === "aborted" ? "aborted" : "transport",
            `Claude session ${event.reason} before turn completion`,
          ),
        );
        break;
      case "observation":
        if (event.family === "reset") {
          session.invalidated = "reset";
          abort(
            session,
            round,
            error("history", "Claude reset invalidated active host history"),
          );
        }
        break;
      default:
        break;
    }
  };

  const pump = async (session: Session): Promise<void> => {
    try {
      for await (const event of session.driver.events) handle(session, event);
      if (!session.closed) {
        session.failure = error(
          "transport",
          "Claude event stream ended before session close",
        );
        if (session.active && !session.active.done)
          finish(session, session.active, "error", session.failure);
        void dispose(session).catch(() => {});
      }
    } catch (cause) {
      session.failure = failure(cause, "transport");
      if (session.active)
        finish(session, session.active, "error", session.failure);
      void dispose(session).catch(() => {});
    }
  };

  const open = async (
    request: HostRoundRequest,
    next: SessionIdentity,
    resume: DriverSessionRequest["resume"],
  ): Promise<Session> => {
    const driver = await options.driver.openSession({
      identity: next,
      resume,
      model: request.model,
      systemPrompt: request.systemPrompt,
      tools: request.tools,
      settings: request.settings,
      auth: request.auth,
    });
    const session: Session = {
      identity: next,
      driver,
      request,
      expected: [],
      backlog: [],
      parked: new Map(),
      delivered: new Map(),
      projectedMessages: new Set(),
      turnUsage: zero(),
      sequence: 0,
      closed: false,
      pump: Promise.resolve(),
      operations: new Set(),
    };
    sessions.set(request.session.sessionId, session);
    session.pump = pump(session);
    return session;
  };

  const acquire = async (
    request: HostRoundRequest,
  ): Promise<{ session: Session; rebuilt: boolean }> => {
    const key = request.session.sessionId;
    const inFlight = opening.get(key);
    if (inFlight) return { session: await inFlight, rebuilt: true };
    const previous = sessions.get(key);
    if (previous?.active && !previous.active.done)
      throw new Error("Another host round already owns this session");
    let history = precedingHistory(request);
    const incomingResults =
      request.input.kind === "tool-results"
        ? [
            ...new Map(
              request.input.results.map((result) => [
                result.toolCallId,
                result,
              ]),
            ).values(),
          ]
        : [];
    if (previous?.failure && request.input.kind === "tool-results")
      throw previous.failure;
    const seen = new Map<string, HostToolResult>();
    for (const result of request.input.kind === "tool-results"
      ? request.input.results
      : []) {
      if (!result.toolCallId || !result.toolName)
        throw error(
          "tool-correlation",
          "Tool result lacks authoritative ID/name",
        );
      const duplicate =
        seen.get(result.toolCallId) ??
        previous?.delivered.get(result.toolCallId);
      if (duplicate && digest(duplicate) !== digest(result))
        throw error(
          "tool-correlation",
          `Conflicting duplicate result ${result.toolCallId}`,
        );
      seen.set(result.toolCallId, result);
      if (previous && !previous.closed && !duplicate) {
        const pending = previous.parked.get(result.toolCallId);
        if (!pending || pending.call.name !== result.toolName)
          throw error(
            "tool-correlation",
            `Uncorrelated host result ${result.toolCallId}`,
          );
      }
    }
    const appendedResults = incomingResults.filter(
      (result) =>
        !history.some(
          (entry) =>
            entry.role === "tool_result" &&
            entry.toolCallId === result.toolCallId,
        ),
    );
    const candidateExpected = previous
      ? [
          ...previous.expected,
          ...incomingResults
            .filter(
              (result) =>
                ![
                  ...previous.expected,
                  ...previous.identity.history.messages,
                ].some(
                  (entry) =>
                    entry.role === "tool_result" &&
                    entry.toolCallId === result.toolCallId,
                ),
            )
            .map(
              (result): TranscriptMessage => ({
                role: "tool_result",
                ...result,
              }),
            ),
        ]
      : [];
    const next = identity(request, options.driver.kind, history);
    const append = previous
      ? history.slice(previous.identity.history.messages.length)
      : [];
    const remaining = reconcile(candidateExpected, append);
    const unrecorded = new Set(
      appendedResults.map((result) => result.toolCallId),
    );
    const matches =
      remaining !== undefined &&
      remaining.every(
        (entry) =>
          entry.role === "tool_result" && unrecorded.has(entry.toolCallId),
      );
    const acknowledgedHistory = matches
      ? append.map(messageDigest)
      : ["unacknowledged-history"];
    const resume = resolveResumePlan(previous?.identity, next, {
      residentSessionId:
        previous &&
        !previous.closed &&
        options.driver.capabilities.residentSessions
          ? previous.identity.claudeSessionId
          : undefined,
      invalidated: invalidated.get(key) ?? previous?.invalidated,
      acknowledgedAppendDigests: acknowledgedHistory,
    });
    if (previous && resume.mode === "resident") {
      previous.identity = {
        ...next,
        claudeSessionId: previous.identity.claudeSessionId,
      };
      previous.expected = remaining ?? [];
      previous.request = request;
      return { session: previous, rebuilt: false };
    }
    if (previous) await dispose(previous);
    if (request.input.kind === "tool-results") {
      history = [
        ...history,
        ...appendedResults.map(
          (result): TranscriptMessage => ({ role: "tool_result", ...result }),
        ),
      ];
    }
    const fresh = identity(request, options.driver.kind, history);
    const freshResume =
      resume.mode === "resident" || resume.mode === "resume"
        ? resolveResumePlan(undefined, fresh, {})
        : fresh.history.messages.length
          ? {
              mode: "replay" as const,
              restoration: "user-history-replay" as const,
              replayTranscript: fresh.history.messages,
              reason: resume.reason,
            }
          : {
              mode: "fresh" as const,
              restoration: "none" as const,
              reason: resume.reason,
            };
    const promise = open(request, fresh, freshResume);
    opening.set(key, promise);
    try {
      const session = await promise;
      invalidated.delete(key);
      return { session, rebuilt: true };
    } finally {
      opening.delete(key);
    }
  };

  return {
    async *streamRound(request): AsyncGenerator<ClaudeRoundEvent> {
      let session: Session | undefined, round: Round | undefined;
      try {
        if (closed) throw error("closed", "Claude runtime is closed");
        if (
          options.driver.capabilities.contractVersion !== 1 ||
          options.driver.capabilities.driver !== options.driver.kind
        )
          throw error(
            "unsupported",
            "Selected driver has an incompatible contract",
          );
        if (
          request.input.kind === "tool-results" &&
          request.input.steering?.length &&
          options.driver.capabilities.steering === "unsupported"
        ) {
          // Reject before replay can turn steering into another submitted prompt.
          const pending = opening.get(request.session.sessionId);
          const resident = pending
            ? await pending
            : sessions.get(request.session.sessionId);
          if (resident) {
            resident.invalidated = "reset";
            await dispose(resident);
          }
          throw error(
            "unsupported",
            "Selected driver doesn't support steering",
          );
        }
        if (
          request.settings.forwardSubagentText &&
          !options.driver.capabilities.forwardSubagentText
        )
          throw error(
            "unsupported",
            "Selected driver doesn't support subagent text forwarding",
          );
        if (
          !request.session.sessionId ||
          !request.roundId ||
          !Number.isFinite(request.settings.toolResultTimeoutMs) ||
          request.settings.toolResultTimeoutMs <= 0
        )
          throw new Error(
            "Round requires identity and a positive tool-result timeout",
          );
        const acquired = await acquire(request);
        session = acquired.session;
        if (session.active && !session.active.done)
          throw new Error("Another host round already owns this session");
        if (closed || session.closed)
          throw error("closed", "Claude runtime/session closed while opening");
        let settle = () => {};
        const finished = new Promise<void>((resolve) => {
          settle = resolve;
        });
        round = {
          request,
          channel: new Channel(),
          messages: new Map(),
          proposals: new Map(),
          done: false,
          finished,
          settle,
        };
        session.active = round;
        const owned = session,
          subscribed = round;
        round.abort = () =>
          abort(owned, subscribed, error("aborted", "Host round aborted"));
        request.signal?.addEventListener("abort", round.abort, { once: true });
        if (request.signal?.aborted) round.abort();
        // Backlog was already sequenced by the continuous pump. Re-dispatch its
        // relevant state through this subscription without pumping twice.
        const backlog = session.backlog.splice(0);
        const lastSequence = session.sequence;
        for (const event of backlog) {
          session.sequence = event.sequence - 1;
          handle(session, event, true);
        }
        session.sequence = lastSequence;
        if (!round.done) {
          if (session.failure) finish(session, round, "error", session.failure);
          else if (request.input.kind === "prompt" || acquired.rebuilt) {
            if (request.input.kind === "prompt" && session.parked.size)
              throw new Error(
                "Host tool results must settle before a new prompt",
              );
            session.turnId = request.roundId;
            session.turnUsage = zero();
            session.delivered.clear();
            const input = currentPrompt(request) ?? [
              {
                type: "text" as const,
                text: "Continue the conversation using the supplied host tool results.",
              },
            ];
            session.expected.push({ role: "user", content: input });
            await Promise.race([
              session.driver.submitPrompt({
                turnId: session.turnId,
                content: input,
              }),
              round.finished,
            ]);
          } else {
            const unique = new Map<string, HostToolResult>();
            for (const result of request.input.results) {
              const prior =
                session.delivered.get(result.toolCallId) ??
                unique.get(result.toolCallId);
              if (prior) {
                if (digest(prior) !== digest(result))
                  throw new Error(
                    `Conflicting duplicate result ${result.toolCallId}`,
                  );
                continue;
              }
              const pending = session.parked.get(result.toolCallId);
              if (
                !pending ||
                !result.toolCallId ||
                result.toolName !== pending.call.name
              )
                throw new Error(
                  `Uncorrelated host result ${result.toolCallId}`,
                );
              unique.set(result.toolCallId, result);
            }
            if (
              request.input.steering?.length &&
              options.driver.capabilities.steering === "unsupported"
            )
              throw new Error("Selected driver doesn't support steering");
            for (const result of unique.values()) {
              clearTimeout(session.parked.get(result.toolCallId)?.timer);
              session.parked.delete(result.toolCallId);
              session.delivered.set(result.toolCallId, result);
            }
            await Promise.race([
              session.driver.deliverToolResults([...unique.values()]),
              round.finished,
            ]);
            if (request.input.steering?.length && !round.done) {
              session.expected.push({
                role: "user",
                content: request.input.steering,
              });
              await Promise.race([
                session.driver.submitPrompt({
                  turnId: session.turnId ?? request.roundId,
                  content: request.input.steering,
                  priority: "now",
                }),
                round.finished,
              ]);
            }
          }
        }
        for await (const event of round.channel) yield event;
      } catch (cause) {
        const runtimeError = failure(cause, "protocol");
        if (session && round) {
          if (!round.done) abort(session, round, runtimeError);
          for await (const event of round.channel) yield event;
        } else if (!round?.done)
          yield {
            type: "round_end",
            roundId: request.roundId,
            reason: "error",
            content: [],
            pendingToolCallIds: [],
            error: runtimeError,
          };
      } finally {
        if (session && round) {
          if (!round.done)
            abort(
              session,
              round,
              error("aborted", "Host round subscription ended"),
            );
          request.signal?.removeEventListener(
            "abort",
            round.abort as EventListener,
          );
          if (session.active === round) session.active = undefined;
        }
      }
    },
    async invalidate(
      host: HostSessionIdentity,
      reason: HistoryInvalidationReason,
    ): Promise<void> {
      invalidated.set(host.sessionId, reason);
      const pending = opening.get(host.sessionId);
      const session = pending ? await pending : sessions.get(host.sessionId);
      if (session) {
        session.invalidated = reason;
        await dispose(session);
      }
    },
    async close(sessionId: string): Promise<void> {
      const pending = opening.get(sessionId);
      const session = pending ? await pending : sessions.get(sessionId);
      if (session) await dispose(session);
    },
    async closeAll(): Promise<void> {
      closed = true;
      await Promise.allSettled([...opening.values()]);
      await Promise.all([...sessions.values()].map(dispose));
      sessions.clear();
    },
  };
}
