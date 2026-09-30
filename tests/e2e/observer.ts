import { appendFileSync } from "node:fs";

/** Only synthetic sandbox content and whitelisted public transport metadata. */
export function record(type: string, data: unknown): void {
  const path = process.env.PCC_E2E_OBSERVATIONS;
  if (!path) throw new Error("PCC_E2E_OBSERVATIONS is required");
  appendFileSync(path, JSON.stringify({ type, data }) + "\n", { mode: 0o600 });
}

export function response(
  status: number,
  headers: Record<string, string>,
): void {
  record("response", {
    status,
    driver: headers["x-pi-claude-driver"],
    claudeSessionId: headers["x-pi-claude-session-id"],
    transport: headers["x-pi-claude-transport"],
  });
}

export function systemPrompt(stage: string, value: unknown): void {
  const marker = process.env.PCC_E2E_SYSTEM_MARKER;
  const parts =
    typeof value === "string"
      ? [value]
      : Array.isArray(value) && value.every((part) => typeof part === "string")
        ? value
        : undefined;
  record("system-prompt", {
    stage,
    available: parts !== undefined,
    markerConfigured: Boolean(marker),
    markerIncluded: Boolean(
      marker && parts?.some((part) => part.includes(marker)),
    ),
    length: parts?.join("\n\n").length,
    parts: parts?.length,
  });
}

export function providerPrompt(payload: unknown): void {
  const prompt =
    typeof payload === "object" && payload !== null && "systemPrompt" in payload
      ? payload.systemPrompt
      : undefined;
  systemPrompt("before_provider_request", prompt);
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function safeId(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    !/\p{Cc}/u.test(value)
    ? value
    : undefined;
}
function safeCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function metadata(
  value: unknown,
  ids: readonly string[],
  flags: readonly string[] = [],
  counts: readonly string[] = [],
): Record<string, unknown> {
  const source = object(value),
    result: Record<string, unknown> = {};
  for (const key of ids) {
    const id = safeId(source[key]);
    if (id !== undefined) result[key] = id;
  }
  for (const key of flags)
    if (typeof source[key] === "boolean") result[key] = source[key];
  for (const key of counts)
    if (safeCount(source[key])) result[key] = source[key];
  return result;
}
function boundedIds(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.slice(0, 32).flatMap((entry) => {
        const id = safeId(entry);
        return id === undefined ? [] : [id];
      })
    : undefined;
}
function boundedObjects(
  value: unknown,
  project: (entry: unknown) => Record<string, unknown>,
): Record<string, unknown>[] | undefined {
  return Array.isArray(value)
    ? value
        .slice(0, 32)
        .filter(
          (entry) =>
            entry !== null &&
            typeof entry === "object" &&
            !Array.isArray(entry),
        )
        .map(project)
    : undefined;
}

/** Independently whitelist the dedicated safe bus; raw spreads are forbidden. */
export function nativeDiagnostic(value: unknown): void {
  const envelope = object(value),
    event = object(envelope.event);
  if (
    envelope.owner !== "claude" ||
    event.type !== "observation" ||
    event.family !== "diagnostic" ||
    !safeCount(event.sequence) ||
    ![
      "core-message-start",
      "core-message-stop",
      "core-assistant-snapshot",
      "host-mcp-park",
    ].includes(String(event.subtype))
  )
    return;
  const source = object(event.data);
  const data =
    event.subtype === "host-mcp-park"
      ? metadata(source, ["toolUseId", "toolName"])
      : metadata(
          source,
          ["messageId", "snapshotId"],
          [
            "ended",
            "stopReasonPresent",
            "snapshotKnownMessage",
            "snapshotFull",
            "snapshotStopReasonPresent",
          ],
          ["blockCount"],
        );
  if (event.subtype === "host-mcp-park") {
    if (source.serverName === "host") data.serverName = "host";
  } else {
    for (const key of ["previousActiveMessageId", "activeMessageId"]) {
      const id = safeId(source[key]);
      if (id !== undefined || source[key] === null) data[key] = id ?? null;
    }
    const blocks = boundedObjects(source.blocks, (entry) => {
      const block = metadata(entry, ["toolCallId"], ["ended"], ["index"]);
      const type = object(entry).type;
      if (["text", "thinking", "image", "tool_call"].includes(String(type)))
        block.type = type;
      return block;
    });
    if (blocks !== undefined) data.blocks = blocks;
  }
  if (
    source.runtimeBoundary !== null &&
    typeof source.runtimeBoundary === "object" &&
    !Array.isArray(source.runtimeBoundary)
  ) {
    const boundarySource = object(source.runtimeBoundary);
    const boundary = metadata(
      boundarySource,
      [],
      ["roundDone"],
      ["messageCount", "proposalCount", "parkedCount", "deliveredCount"],
    );
    const messages = boundedObjects(boundarySource.messages, (entry) => {
      const message = metadata(entry, ["messageId"], ["ended"], ["blockCount"]);
      const calls = boundedIds(object(entry).toolCallIds);
      if (calls !== undefined) message.toolCallIds = calls;
      return message;
    });
    if (messages !== undefined) boundary.messages = messages;
    for (const key of [
      "unendedMessageIds",
      "proposalIds",
      "unparkedProposalIds",
      "parkedIds",
      "deliveredIds",
    ]) {
      const ids = boundedIds(boundarySource[key]);
      if (ids !== undefined) boundary[key] = ids;
    }
    data.runtimeBoundary = boundary;
  }
  const attribution = metadata(event.attribution, [
    "claudeSessionId",
    "turnId",
    "messageId",
    "parentToolUseId",
    "toolUseId",
    "taskId",
    "agentId",
  ]);
  if (object(event.attribution).parentToolUseId === null)
    attribution.parentToolUseId = null;
  const hostAgent = metadata(
    envelope.hostAgent,
    ["id", "parentId"],
    [],
    ["depth"],
  );
  const kind = object(envelope.hostAgent).kind;
  if (kind === "main" || kind === "sub") hostAgent.kind = kind;
  record("native-diagnostic", {
    owner: "claude",
    hostSession: metadata(envelope.hostSession, [
      "sessionId",
      "branchId",
      "historyRevision",
    ]),
    hostAgent,
    event: {
      type: "observation",
      family: "diagnostic",
      subtype: event.subtype,
      sequence: event.sequence,
      attribution,
      data,
    },
  });
}

/** Metadata only: never persist observation data, tool arguments or error details. */
export function normalizedObservation(value: unknown): void {
  const envelope = object(value);
  if (envelope.owner !== "claude") return;
  const event = object(envelope.event);
  if (
    !["observation", "host_tool_request", "session_error", "turn_end"].includes(
      String(event.type),
    )
  )
    return;
  const attribution = object(event.attribution);
  const ids: Record<string, string | null> = {};
  for (const key of [
    "claudeSessionId",
    "turnId",
    "messageId",
    "parentToolUseId",
    "toolUseId",
    "taskId",
    "agentId",
  ])
    if (typeof attribution[key] === "string")
      ids[key] = attribution[key].slice(0, 256);
    else if (attribution[key] === null) ids[key] = null;
  const call = object(event.call);
  const error = object(event.error);
  record("normalized-observation", {
    type: event.type,
    sequence: typeof event.sequence === "number" ? event.sequence : undefined,
    attribution: ids,
    family:
      typeof event.family === "string" ? event.family.slice(0, 64) : undefined,
    subtype:
      typeof event.subtype === "string"
        ? event.subtype.slice(0, 128)
        : undefined,
    status: typeof event.status === "string" ? event.status : undefined,
    isError: typeof event.isError === "boolean" ? event.isError : undefined,
    call:
      event.type === "host_tool_request" &&
      ["read", "edit", "pcc_sentinel", "pcc_slow"].includes(String(call.name))
        ? {
            id: call.id,
            name: call.name,
            inputKeys: Object.keys(object(call.arguments)),
          }
        : undefined,
    errorCode: typeof error.code === "string" ? error.code : undefined,
  });
}

let calls = 0;
export async function sentinel(toolCallId: string) {
  const nonce = process.env.PCC_E2E_NONCE;
  if (!nonce) throw new Error("PCC_E2E_NONCE is required");
  calls++;
  const structuredContent = { nonce, calls, toolCallId };
  record("sentinel", structuredContent);
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(structuredContent) },
    ],
    details: { structuredContent, _meta: { fixture: "native-live-sentinel" } },
    structuredContent,
  };
}

export async function slow(
  toolCallId: string,
  signal: AbortSignal | undefined,
) {
  record("slow-start", { toolCallId });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", aborted);
      record("slow-effect", { toolCallId });
      resolve();
    }, 30_000);
    function aborted() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      record("slow-abort", { toolCallId });
      reject(new Error("Native E2E slow tool aborted"));
    }
    if (signal?.aborted) aborted();
    else signal?.addEventListener("abort", aborted, { once: true });
  });
  return {
    content: [{ type: "text" as const, text: "slow-effect" }],
    details: {},
  };
}
