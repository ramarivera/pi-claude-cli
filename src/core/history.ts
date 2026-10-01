import { createHash } from "node:crypto";
import type {
  HostRoundRequest,
  PromptMessage,
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
  if (message.role !== "assistant") return digest(message);
  // Native hosts may elide empty text blocks after a streamed assistant turn.
  // Preserve whitespace, thinking/signatures, calls and meaningful block order.
  const semantic = {
    ...message,
    content: message.content.filter(
      (block) => block.type !== "text" || block.text !== "",
    ),
  };
  // Hosts differ in whether they spell a successful stop reason explicitly.
  if (message.stopReason === "stop" || message.stopReason === "toolUse") {
    const { stopReason: _stopReason, ...successful } = semantic;
    return digest(successful);
  }
  return digest(semantic);
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
  const messages =
    request.input.kind === "prompt"
      ? request.input.messages
      : request.input.steeringMessages;
  if (messages) {
    currentPromptMessages(request);
    const boundary =
      request.transcript.findLastIndex(
        (message) => message.role === "assistant",
      ) + 1;
    const tail = request.transcript.slice(boundary);
    const prompts = tail.filter(
      (message): message is PromptMessage =>
        message.role === "user" || message.role === "developer",
    );
    if (digest(prompts) === digest(messages))
      return request.transcript.slice(0, boundary);
    throw new Error(
      "Host input messages must match the current transcript suffix",
    );
  }
  const input = currentPrompt(request),
    last = request.transcript.at(-1);
  return input &&
    last?.role === "user" &&
    digest(last.content) === digest(input)
    ? request.transcript.slice(0, -1)
    : request.transcript;
}
export function currentPromptMessages(
  request: HostRoundRequest,
): readonly PromptMessage[] {
  const content = currentPrompt(request);
  const messages =
    request.input.kind === "prompt"
      ? request.input.messages
      : request.input.steeringMessages;
  if (!messages) return content ? [{ role: "user", content }] : [];
  if (
    !messages.length ||
    messages.some(
      (message) => message.role !== "user" && message.role !== "developer",
    ) ||
    digest(messages.flatMap((message) => [...message.content])) !==
      digest(content)
  )
    throw new Error(
      "Host input messages must match the ordered prompt content",
    );
  return messages;
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
