import { describe, expect, it } from "vitest";
import { PiProjection } from "../../../src/adapters/pi/projection.js";
import { collect, driver, model, tool } from "./support.js";
import type { ClaudeRoundEvent } from "../../../src/contracts/index.js";

const end = (
  content: Extract<ClaudeRoundEvent, { type: "round_end" }>["content"] = [],
): ClaudeRoundEvent => ({
  type: "round_end",
  roundId: "r",
  reason: "stop",
  content,
  pendingToolCallIds: [],
});
const call = {
  type: "tool_call" as const,
  id: "toolu_native",
  name: "custom",
  arguments: { input: "yes" },
};

describe("Pi event projection", () => {
  it("streams shared partial text before completion and reconciles full snapshots once", async () => {
    const projection = new PiProjection(model, [tool]);
    const iterator = projection.stream[Symbol.asyncIterator]();
    projection.accept(
      driver({
        type: "content_start",
        messageId: "m",
        index: 4,
        content: { type: "text", text: "" },
      }),
    );
    expect((await iterator.next()).value.type).toBe("start");
    expect((await iterator.next()).value.type).toBe("text_start");
    projection.accept(
      driver({
        type: "content_delta",
        messageId: "m",
        index: 4,
        delta: { kind: "text", text: "hel" },
      }),
    );
    const delta = (await iterator.next()).value;
    expect(delta).toMatchObject({
      type: "text_delta",
      delta: "hel",
      partial: { content: [{ type: "text", text: "hel" }] },
    });
    projection.accept(
      driver({
        type: "assistant_snapshot",
        messageId: "m",
        contentIndexes: [4],
        content: [{ type: "text", text: "hello" }],
        model: "observed-model",
      }),
    );
    projection.accept(
      driver({
        type: "assistant_snapshot",
        messageId: "m",
        contentIndexes: [4],
        content: [{ type: "text", text: "hello" }],
      }),
    );
    projection.accept(end([{ type: "text", text: "hello" }]));
    const remaining = [];
    for (;;) {
      const item = await iterator.next();
      if (item.done) break;
      remaining.push(item.value);
    }
    expect(
      remaining
        .filter((event) => event.type === "text_delta")
        .map((event) => event.delta),
    ).toEqual(["lo"]);
    expect(projection.message.content).toEqual([
      { type: "text", text: "hello" },
    ]);
    expect(projection.message.responseModel).toBe("observed-model");
    expect(remaining.filter((event) => event.type === "done")).toHaveLength(1);
  });
  it("keeps original block indexes across partial snapshots and preserves completed prefix", async () => {
    const projection = new PiProjection(model, []);
    projection.accept(
      driver({
        type: "assistant_snapshot",
        messageId: "m",
        contentIndexes: [2],
        content: [{ type: "thinking", thinking: "reason", signature: "sig" }],
      }),
    );
    projection.accept(
      driver({ type: "content_end", messageId: "m", index: 2 }),
    );
    projection.accept(
      driver({
        type: "assistant_snapshot",
        messageId: "m",
        contentIndexes: [3],
        content: [{ type: "text", text: "answer" }],
      }),
    );
    projection.accept(
      end([
        { type: "thinking", thinking: "reason", signature: "sig" },
        { type: "text", text: "answer" },
      ]),
    );
    const events = await collect(projection.stream);
    expect(
      events.filter((event) => event.type === "thinking_end"),
    ).toHaveLength(1);
    expect(projection.message.content).toEqual([
      {
        type: "thinking",
        thinking: "reason",
        thinkingSignature: "sig",
        redacted: undefined,
      },
      { type: "text", text: "answer" },
    ]);
  });
  it("adds signature deltas without adding text and doesn't regress content on older snapshots", async () => {
    const projection = new PiProjection(model, []);
    projection.accept(
      driver({
        type: "content_start",
        messageId: "m",
        index: 0,
        content: { type: "thinking", thinking: "" },
      }),
    );
    projection.accept(
      driver({
        type: "content_delta",
        messageId: "m",
        index: 0,
        delta: { kind: "thinking", thinking: "reason" },
      }),
    );
    projection.accept(
      driver({
        type: "content_delta",
        messageId: "m",
        index: 0,
        delta: { kind: "signature", signature: "signed" },
      }),
    );
    projection.accept(
      driver({
        type: "assistant_snapshot",
        messageId: "m",
        content: [{ type: "thinking", thinking: "rea" }],
      }),
    );
    projection.accept(
      end([{ type: "thinking", thinking: "reason", signature: "signed" }]),
    );
    const events = await collect(projection.stream);
    expect(
      events.filter((event) => event.type === "thinking_delta"),
    ).toHaveLength(1);
    expect(projection.message.content[0]).toMatchObject({
      thinking: "reason",
      thinkingSignature: "signed",
    });
  });
  it("projects only effective authoritative host calls once with canonical ids", async () => {
    const projection = new PiProjection(model, [tool]);
    projection.accept(
      driver({
        type: "content_start",
        messageId: "m",
        index: 0,
        content: { ...call, name: "Bash" },
      }),
    );
    projection.accept(
      driver({
        type: "assistant_snapshot",
        messageId: "m",
        content: [{ ...call, name: "Bash" }],
      }),
    );
    projection.accept(driver({ type: "host_tool_request", call }));
    projection.accept(driver({ type: "host_tool_request", call }));
    projection.accept({
      type: "round_end",
      roundId: "r",
      reason: "toolUse",
      content: [call],
      pendingToolCallIds: [call.id],
    });
    const events = await collect(projection.stream);
    expect(
      events.filter((event) => event.type === "toolcall_start"),
    ).toHaveLength(1);
    expect(
      events.filter((event) => event.type === "toolcall_end"),
    ).toHaveLength(1);
    expect(projection.message.content).toEqual([{ ...call, type: "toolCall" }]);
    expect(projection.message.stopReason).toBe("toolUse");
  });
  it("orders final history by original Claude blocks when MCP parking arrives after later text", async () => {
    const projection = new PiProjection(model, [tool]);
    projection.accept(
      driver({
        type: "content_start",
        messageId: "m",
        index: 0,
        content: call,
      }),
    );
    projection.accept(
      driver({
        type: "content_start",
        messageId: "m",
        index: 1,
        content: { type: "text", text: "after tool" },
      }),
    );
    projection.accept(driver({ type: "host_tool_request", call }));
    projection.accept({
      type: "round_end",
      roundId: "r",
      reason: "toolUse",
      content: [call, { type: "text", text: "after tool" }],
      pendingToolCallIds: [call.id],
    });
    const events = await collect(projection.stream);
    expect(projection.message.content).toEqual([
      { ...call, type: "toolCall" },
      { type: "text", text: "after tool" },
    ]);
    const textEnd = events.find((event) => event.type === "text_end");
    expect(textEnd).toMatchObject({
      contentIndex: 0,
      partial: {
        content: [
          { type: "text", text: "after tool" },
          { ...call, type: "toolCall" },
        ],
      },
    });
  });
  it("omits empty streamed text from final history to match core acknowledgement", async () => {
    const projection = new PiProjection(model, [tool]);
    projection.accept(
      driver({
        type: "content_start",
        messageId: "m",
        index: 0,
        content: { type: "text", text: "" },
      }),
    );
    projection.accept(driver({ type: "host_tool_request", call }));
    projection.accept({
      type: "round_end",
      roundId: "r",
      reason: "toolUse",
      content: [call],
      pendingToolCallIds: [call.id],
    });
    await collect(projection.stream);
    expect(projection.message.content).toEqual([{ ...call, type: "toolCall" }]);
  });
  it("rejects inactive host calls and conflicting snapshots", () => {
    const projection = new PiProjection(model, []);
    expect(() =>
      projection.accept(driver({ type: "host_tool_request", call })),
    ).toThrow("inactive Pi tool");
    projection.accept(
      driver({
        type: "content_start",
        messageId: "m",
        index: 0,
        content: { type: "text", text: "first" },
      }),
    );
    expect(() =>
      projection.accept(
        driver({
          type: "assistant_snapshot",
          messageId: "m",
          content: [{ type: "text", text: "different" }],
        }),
      ),
    ).toThrow("conflicts");
  });
  it("ignores subagent content attribution", async () => {
    const projection = new PiProjection(model, []);
    const event = driver({
      type: "assistant_snapshot",
      messageId: "child",
      content: [{ type: "text", text: "private subagent" }],
    });
    if (event.type === "driver_event")
      event.event.attribution.parentToolUseId = "parent";
    projection.accept(event);
    projection.accept(end([{ type: "text", text: "parent output" }]));
    await collect(projection.stream);
    expect(projection.message.content).toEqual([
      { type: "text", text: "parent output" },
    ]);
  });
  it("takes incremental round usage only, including observed cost and reasoning", async () => {
    const projection = new PiProjection(model, []);
    const usage = {
      inputTokens: 10,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
      reasoningTokens: 1,
      costUsd: 0.009,
    };
    projection.accept(
      driver({
        type: "turn_end",
        status: "success",
        isError: false,
        subtype: "success",
        usage: { ...usage, inputTokens: 100 },
      }),
    );
    projection.accept({ ...end(), usage } as ClaudeRoundEvent);
    await collect(projection.stream);
    expect(projection.message.usage).toEqual({
      input: 10,
      output: 2,
      cacheRead: 3,
      cacheWrite: 4,
      reasoning: 1,
      totalTokens: 19,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.009 },
    });
  });
  it.each(["error", "aborted"] as const)(
    "terminates %s with an AssistantMessage exactly once",
    async (reason) => {
      const projection = new PiProjection(model, []);
      projection.accept({
        ...end([{ type: "text", text: "partial" }]),
        reason,
        error: {
          code: reason === "aborted" ? "aborted" : "transport",
          message: "driver failed",
        },
      } as ClaudeRoundEvent);
      projection.fail("duplicate");
      projection.finish();
      const events = await collect(projection.stream);
      expect(events.filter((event) => event.type === "error")).toEqual([
        {
          type: "error",
          reason,
          error: expect.objectContaining({
            role: "assistant",
            stopReason: reason,
            errorMessage: "driver failed",
            content: [{ type: "text", text: "partial" }],
          }),
        },
      ]);
      expect(events.filter((event) => event.type === "done")).toHaveLength(0);
    },
  );
  it("reports a missing runtime boundary as a host error", async () => {
    const projection = new PiProjection(model, []);
    projection.finish();
    expect(await collect(projection.stream)).toEqual([
      {
        type: "error",
        reason: "error",
        error: expect.objectContaining({
          stopReason: "error",
          errorMessage: "Claude runtime ended without a round boundary",
        }),
      },
    ]);
  });
});
