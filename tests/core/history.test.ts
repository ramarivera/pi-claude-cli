import { describe, expect, it } from "vitest";
import { messageDigest } from "../../src/core/history.js";
import type { TranscriptMessage } from "../../src/contracts/index.js";

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
