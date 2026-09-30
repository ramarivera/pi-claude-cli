import { readFileSync } from "node:fs";
import type {
  AssistantContent,
  ClaudeEventNormalizerOptions,
  JsonObject,
  UnsequencedClaudeDriverEvent,
} from "../../src/contracts/index.js";

export interface ProtocolFixture {
  id: string;
  coverage: string[];
  frames: { payload: unknown; expected: JsonObject[] }[];
  outcome: {
    terminalStatuses: string[];
    text?: string;
    thinking?: JsonObject[];
    toolCalls?: JsonObject[];
    forbiddenOutput?: string[];
    hostToolRequests?: number;
  };
}
export interface FixtureCatalog {
  schemaVersion: 1;
  fixtureVersion: string;
  provenance: {
    kind: "synthetic";
    description: string;
    author: string;
    license: string;
    source: string;
    capturedAt: null;
  };
  targets: {
    claudeCli: string;
    claudeAgentSdk: string;
    pi: string;
    omp: string;
  };
  flags: { cli: string[]; sdk: { includePartialMessages: boolean } };
  normalizerOptions: ClaudeEventNormalizerOptions;
  cases: ProtocolFixture[];
}
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");
function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid fixture catalog: ${message}`);
}
function isJson(value: unknown): boolean {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    (Array.isArray(value) && value.every(isJson)) ||
    (isObject(value) && Object.values(value).every(isJson))
  );
}
function isJsonObjects(value: unknown): value is JsonObject[] {
  return Array.isArray(value) && value.every((v) => isObject(v) && isJson(v));
}

/** Reject missing provenance/expectations before passing payloads to production. */
export function loadFixtureCatalog(): FixtureCatalog {
  const raw: unknown = JSON.parse(
    readFileSync(
      new URL("../fixtures/claude/v1/catalog.json", import.meta.url),
      "utf8",
    ),
  );
  requireValue(isObject(raw), "object required");
  requireValue(raw.schemaVersion === 1, "unsupported schemaVersion");
  requireValue(
    typeof raw.fixtureVersion === "string",
    "fixtureVersion required",
  );
  const provenance = raw.provenance;
  requireValue(isObject(provenance), "provenance required");
  requireValue(provenance.kind === "synthetic", "this catalog is synthetic");
  requireValue(
    provenance.capturedAt === null,
    "synthetic cases have no capture date",
  );
  for (const key of ["description", "author", "license", "source"])
    requireValue(
      typeof provenance[key] === "string" && provenance[key].length > 0,
      `provenance.${key} required`,
    );
  requireValue(isObject(raw.targets), "version targets required");
  for (const key of ["claudeCli", "claudeAgentSdk", "pi", "omp"])
    requireValue(
      typeof raw.targets[key] === "string",
      `targets.${key} required`,
    );
  requireValue(
    isObject(raw.flags) && isStrings(raw.flags.cli),
    "CLI flags required",
  );
  requireValue(
    isObject(raw.flags.sdk) &&
      typeof raw.flags.sdk.includePartialMessages === "boolean",
    "SDK partial-event flag required",
  );
  const options = raw.normalizerOptions;
  requireValue(
    isObject(options) &&
      typeof options.hostMcpServerName === "string" &&
      typeof options.requestedModel === "string",
    "normalizer options required",
  );
  requireValue(
    Array.isArray(options.tools) && options.tools.length > 0,
    "tool inventory required",
  );
  for (const tool of options.tools)
    requireValue(
      isObject(tool) &&
        typeof tool.name === "string" &&
        tool.owner === "host" &&
        typeof tool.description === "string" &&
        isObject(tool.inputSchema) &&
        isJson(tool.inputSchema),
      "malformed tool inventory",
    );
  requireValue(
    Array.isArray(raw.cases) && raw.cases.length > 0,
    "cases required",
  );
  const ids = new Set<string>();
  for (const fixture of raw.cases) {
    requireValue(
      isObject(fixture) &&
        typeof fixture.id === "string" &&
        fixture.id.length > 0,
      "case ID required",
    );
    requireValue(!ids.has(fixture.id), `duplicate ID ${fixture.id}`);
    ids.add(fixture.id);
    requireValue(
      isStrings(fixture.coverage) && fixture.coverage.length > 0,
      `${fixture.id}: coverage required`,
    );
    requireValue(
      Array.isArray(fixture.frames) && fixture.frames.length > 0,
      `${fixture.id}: frames required`,
    );
    for (const frame of fixture.frames) {
      requireValue(
        isObject(frame) && "payload" in frame && isJsonObjects(frame.expected),
        `${fixture.id}: payload and expectations required`,
      );
      requireValue(
        frame.expected.every((event) => typeof event.type === "string"),
        `${fixture.id}: expected event type required`,
      );
    }
    const outcome = fixture.outcome;
    requireValue(
      isObject(outcome) && isStrings(outcome.terminalStatuses),
      `${fixture.id}: terminal count/status expectations required`,
    );
    requireValue(
      outcome.text === undefined || typeof outcome.text === "string",
      `${fixture.id}: invalid text expectation`,
    );
    for (const key of ["thinking", "toolCalls"])
      requireValue(
        outcome[key] === undefined || isJsonObjects(outcome[key]),
        `${fixture.id}: invalid ${key} expectation`,
      );
    requireValue(
      outcome.forbiddenOutput === undefined ||
        isStrings(outcome.forbiddenOutput),
      `${fixture.id}: invalid privacy expectations`,
    );
    requireValue(
      outcome.hostToolRequests === undefined ||
        (typeof outcome.hostToolRequests === "number" &&
          Number.isInteger(outcome.hostToolRequests) &&
          outcome.hostToolRequests >= 0),
      `${fixture.id}: invalid host request count`,
    );
  }
  // The schema above validates every field consumed by the replay test.
  return raw as unknown as FixtureCatalog;
}

/** Canonical snapshots replace indexed stream blocks instead of appending them. */
export function projectMainContent(
  events: readonly UnsequencedClaudeDriverEvent[],
): AssistantContent[] {
  const messages = new Map<string, Map<number, AssistantContent>>();
  for (const event of events) {
    if (event.attribution.parentToolUseId) continue;
    if (!("messageId" in event)) continue;
    let blocks = messages.get(event.messageId);
    if (!blocks) {
      blocks = new Map();
      messages.set(event.messageId, blocks);
    }
    if (event.type === "content_start")
      blocks.set(event.index, structuredClone(event.content));
    if (event.type === "content_delta") {
      const block = blocks.get(event.index);
      if (block?.type === "text" && event.delta.kind === "text")
        block.text += event.delta.text;
      if (block?.type === "thinking" && event.delta.kind === "thinking")
        block.thinking += event.delta.thinking;
      if (block?.type === "thinking" && event.delta.kind === "signature")
        block.signature = (block.signature ?? "") + event.delta.signature;
    }
    if (event.type === "assistant_snapshot")
      event.content.forEach((block, i) =>
        blocks?.set(event.contentIndexes?.[i] ?? i, structuredClone(block)),
      );
  }
  return [...messages.values()].flatMap((blocks) =>
    [...blocks].sort(([a], [b]) => a - b).map(([, block]) => block),
  );
}
