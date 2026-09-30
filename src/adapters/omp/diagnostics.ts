import type {
  ClaudeDriverEvent,
  JsonObject,
  JsonValue,
} from "../../contracts/index.js";

const subtypes = new Set([
  "core-message-start",
  "core-message-stop",
  "core-assistant-snapshot",
  "host-mcp-park",
  "steering-admission",
]);
function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
export function diagnosticId(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    !/\p{Cc}/u.test(value)
    ? value
    : undefined;
}
function number(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function ids(value: unknown): JsonValue[] | undefined {
  return Array.isArray(value)
    ? value.slice(0, 32).flatMap((entry) => {
        const id = diagnosticId(entry);
        return id === undefined ? [] : [id];
      })
    : undefined;
}
function fields(
  value: unknown,
  idKeys: readonly string[],
  booleanKeys: readonly string[],
  numberKeys: readonly string[],
): JsonObject {
  const source = record(value);
  const result: JsonObject = {};
  if (!source) return result;
  for (const key of idKeys) {
    const id = diagnosticId(source[key]);
    if (id !== undefined) result[key] = id;
  }
  for (const key of booleanKeys)
    if (typeof source[key] === "boolean") result[key] = source[key];
  for (const key of numberKeys)
    if (number(source[key])) result[key] = source[key];
  return result;
}
function objects(
  value: unknown,
  project: (value: unknown) => JsonObject,
): JsonValue[] | undefined {
  return Array.isArray(value)
    ? value
        .slice(0, 32)
        .filter((entry) => record(entry))
        .map(project)
    : undefined;
}
function runtimeBoundary(value: unknown): JsonObject | undefined {
  const source = record(value);
  if (!source) return undefined;
  const result = fields(
    source,
    [],
    ["roundDone"],
    ["messageCount", "proposalCount", "parkedCount", "deliveredCount"],
  );
  const messages = objects(source.messages, (entry) => {
    const item = fields(entry, ["messageId"], ["ended"], ["blockCount"]);
    const calls = ids(record(entry)?.toolCallIds);
    if (calls !== undefined) item.toolCallIds = calls;
    return item;
  });
  if (messages !== undefined) result.messages = messages;
  for (const key of [
    "unendedMessageIds",
    "proposalIds",
    "unparkedProposalIds",
    "parkedIds",
    "deliveredIds",
  ]) {
    const list = ids(source[key]);
    if (list !== undefined) result[key] = list;
  }
  return result;
}

/** Metadata-only native diagnostics; raw observation payloads never cross this bus. */
export function projectOmpDiagnostic(
  event: ClaudeDriverEvent,
): Extract<ClaudeDriverEvent, { type: "observation" }> | undefined {
  if (
    event.type !== "observation" ||
    event.family !== "diagnostic" ||
    !subtypes.has(event.subtype) ||
    !number(event.sequence)
  )
    return undefined;
  const data =
    event.subtype === "steering-admission"
      ? fields(event.data, ["commandId"], [], [])
      : event.subtype === "host-mcp-park"
        ? fields(event.data, ["toolUseId", "toolName"], [], [])
        : fields(
            event.data,
            ["messageId"],
            ["ended", "stopReasonPresent"],
            ["blockCount"],
          );
  if (event.subtype === "steering-admission") {
    if (event.data.state === "queued" || event.data.state === "started")
      data.state = event.data.state;
  } else if (event.subtype === "host-mcp-park") {
    if (event.data.serverName === "host") data.serverName = "host";
  } else {
    for (const key of ["previousActiveMessageId", "activeMessageId"]) {
      const id = diagnosticId(event.data[key]);
      if (id !== undefined || event.data[key] === null) data[key] = id ?? null;
    }
    const blocks = objects(event.data.blocks, (entry) => {
      const block = fields(entry, ["toolCallId"], ["ended"], ["index"]);
      const type = record(entry)?.type;
      if (
        typeof type === "string" &&
        ["text", "thinking", "image", "tool_call"].includes(type)
      )
        block.type = type;
      return block;
    });
    if (blocks !== undefined) data.blocks = blocks;
    if (event.subtype === "core-assistant-snapshot")
      Object.assign(
        data,
        fields(
          event.data,
          ["snapshotId"],
          ["snapshotKnownMessage", "snapshotFull", "snapshotStopReasonPresent"],
          [],
        ),
      );
  }
  const boundary = runtimeBoundary(event.data.runtimeBoundary);
  if (boundary !== undefined) data.runtimeBoundary = boundary;
  const attribution = fields(
    event.attribution,
    [
      "claudeSessionId",
      "turnId",
      "messageId",
      "parentToolUseId",
      "toolUseId",
      "taskId",
      "agentId",
    ],
    [],
    [],
  );
  if (event.attribution.parentToolUseId === null)
    attribution.parentToolUseId = null;
  return {
    type: "observation",
    family: "diagnostic",
    subtype: event.subtype,
    sequence: event.sequence,
    attribution,
    data,
  };
}
