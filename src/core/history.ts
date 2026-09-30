import { createHash } from "node:crypto";
import type {
  HostRoundRequest,
  SessionIdentity,
  TranscriptMessage,
  UserContent,
} from "../contracts/index.js";

/** Stable object order; arrays retain conversation and content order. */
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(object)
        .sort()
        .filter((key) => object[key] !== undefined)
        .map((key) => [key, stable(object[key])]),
    );
  }
  return value;
}
export function digest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stable(value)))
    .digest("hex");
}
export function messageDigest(message: TranscriptMessage): string {
  // Hosts differ in whether they spell a successful stop reason explicitly.
  if (
    message.role === "assistant" &&
    (message.stopReason === "stop" || message.stopReason === "toolUse")
  ) {
    const { stopReason: _stopReason, ...semantic } = message;
    return digest(semantic);
  }
  return digest(message);
}
export function currentPrompt(
  request: HostRoundRequest,
): readonly UserContent[] | undefined {
  return request.input.kind === "prompt"
    ? request.input.content
    : request.input.steering;
}
export function precedingHistory(
  request: HostRoundRequest,
): readonly TranscriptMessage[] {
  const input = currentPrompt(request),
    last = request.transcript.at(-1);
  return input &&
    last?.role === "user" &&
    digest(last.content) === digest(input)
    ? request.transcript.slice(0, -1)
    : request.transcript;
}
export function identity(
  request: HostRoundRequest,
  driver: SessionIdentity["driver"],
  messages = precedingHistory(request),
): SessionIdentity {
  const snapshot = structuredClone(messages);
  const messageDigests = snapshot.map(messageDigest);
  return {
    ...request.session,
    driver,
    cwd: request.cwd,
    configurationDigest: digest({
      model: request.model,
      systemPrompt: request.systemPrompt,
      tools: [...request.tools].sort((a, b) => a.name.localeCompare(b.name)),
      settings: request.settings,
      auth: request.auth,
    }),
    history: {
      messages: snapshot,
      messageDigests,
      digest: digest(messageDigests),
    },
  };
}
