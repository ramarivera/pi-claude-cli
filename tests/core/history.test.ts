import { describe, expect, it } from "vitest";
import {
  currentPromptMessages,
  messageDigest,
  precedingHistory,
} from "../../src/core/history.js";
import type {
  HostRoundRequest,
  TranscriptMessage,
} from "../../src/contracts/index.js";

describe("native assistant history acknowledgements", () => {
  it("only elides empty text while preserving whitespace, signatures and tool order", () => {
    const message: TranscriptMessage = {
      role: "assistant",
      content: [
        { type: "text", text: "" },
        { type: "thinking", thinking: "", signature: "signed" },
        { type: "tool_call", id: "a", name: "read", arguments: {} },
        { type: "text", text: " " },
      ],
      stopReason: "toolUse",
    };
    const omitted = { ...message, content: message.content.slice(1) };
    expect(messageDigest(message)).toBe(messageDigest(omitted));
    expect(messageDigest(message)).not.toBe(
      messageDigest({ ...omitted, content: omitted.content.slice(0, -1) }),
    );
    expect(messageDigest(message)).not.toBe(
      messageDigest({ ...omitted, content: [...omitted.content].reverse() }),
    );
    expect(messageDigest(message)).not.toBe(
      messageDigest({
        ...omitted,
        content: [
          { type: "thinking", thinking: "", signature: "changed" },
          ...omitted.content.slice(1),
        ],
      }),
    );
  });
  it("retains error outcomes even when their content is empty", () => {
    const failed: TranscriptMessage = {
      role: "assistant",
      content: [{ type: "text", text: "" }],
      stopReason: "error",
      errorMessage: "failed",
    };
    expect(messageDigest(failed)).toBe(
      messageDigest({ ...failed, content: [] }),
    );
    expect(messageDigest(failed)).not.toBe(
      messageDigest({ ...failed, stopReason: "stop" }),
    );
    expect(messageDigest(failed)).not.toBe(
      messageDigest({ ...failed, errorMessage: "other failure" }),
    );
  });
});

describe("role-aware current input history", () => {
  const developer = {
    role: "developer" as const,
    content: [{ type: "text" as const, text: "Completed research" }],
  };
  const attachment = {
    role: "user" as const,
    content: [{ type: "image" as const, data: "YQ==", mimeType: "image/png" }],
  };
  const previous = {
    role: "assistant" as const,
    content: [{ type: "text" as const, text: "Waiting" }],
  };
  function request(transcript: readonly TranscriptMessage[]): HostRoundRequest {
    return {
      roundId: "wake",
      session: { sessionId: "host", branchId: "root", historyRevision: "0" },
      cwd: "/project",
      model: "model",
      systemPrompt: "",
      tools: [],
      transcript,
      input: {
        kind: "prompt",
        content: [...developer.content, ...attachment.content],
        messages: [developer, attachment],
      },
      settings: {
        claudeTools: [],
        userMcpServers: [],
        toolResultTimeoutMs: 1000,
      },
      auth: { mode: "claude-login" },
    };
  }
  it("excludes the exact role-aware pending suffix, retaining prior notification history", () => {
    const value = request([developer, previous, developer, attachment]);
    expect(precedingHistory(value)).toEqual([developer, previous]);
    expect(currentPromptMessages(value)).toEqual([developer, attachment]);
  });
  it("rejects a reordered current suffix instead of replaying or silently dropping it", () => {
    expect(() =>
      precedingHistory(request([previous, attachment, developer])),
    ).toThrow("current transcript suffix");
  });
  it("rejects message content inconsistent with the actual wire payload", () => {
    const value = request([previous, developer, attachment]);
    value.input = {
      kind: "prompt",
      content: developer.content,
      messages: [developer, attachment],
    };
    expect(() => precedingHistory(value)).toThrow("ordered prompt content");
  });
});
