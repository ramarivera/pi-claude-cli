import assert from "node:assert/strict";

const numericKeys = [
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "cacheWrite1h",
  "reasoning",
  "total",
  "totalTokens",
];
function numbers(value, keys = numericKeys) {
  if (!value || typeof value !== "object") return undefined;
  return Object.fromEntries(
    keys
      .filter(
        (key) => typeof value[key] === "number" && Number.isFinite(value[key]),
      )
      .map((key) => [key, value[key]]),
  );
}

export function publicAssistant(message) {
  if (!message || message.role !== "assistant") return undefined;
  const usage = numbers(message.usage);
  if (usage && message.usage.cost) usage.cost = numbers(message.usage.cost);
  return {
    text: (message.content ?? [])
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join(""),
    stopReason: message.stopReason,
    errorMessage: message.errorMessage,
    usage,
  };
}

export function publicStats(stats) {
  if (!stats || typeof stats !== "object") return undefined;
  return {
    ...numbers(stats, [
      "userMessages",
      "assistantMessages",
      "toolCalls",
      "toolResults",
      "totalMessages",
      "cost",
    ]),
    tokens: numbers(stats.tokens),
  };
}

export function textProof(text, marker, expected) {
  assert.ok(
    text.includes(marker),
    "Distinctive actual system prompt wasn't honored",
  );
  assert.ok(
    text.includes(expected),
    `Assistant didn't use the expected synthetic value: ${expected}`,
  );
}
