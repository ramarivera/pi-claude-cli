import { describe, expect, it, vi } from "vitest";
import type { AssistantMessageEvent, Model } from "@oh-my-pi/pi-ai";
import type {
  ClaudeDriverEvent,
  DriverEventPayload,
  ClaudeRoundEvent,
  ClaudeRuntime,
  HostRoundRequest,
} from "../../../src/contracts/index.js";
import { toRequest } from "../../../src/adapters/omp/request.js";
import { readRuntimeConfiguration } from "../../../entrypoints/config.js";
// Use OMP's actual stream implementation while keeping Bun-only provider modules out of Node's offline runner.
vi.mock(
  "@oh-my-pi/pi-utils",
  async () => import("@oh-my-pi/pi-utils/fetch-retry"),
);
vi.mock("@oh-my-pi/pi-ai", async () => {
  const native = await import("@oh-my-pi/pi-ai/utils/event-stream");
  return {
    createAssistantMessageEventStream: native.createAssistantMessageEventStream,
  };
});
import { projectRound } from "../../../src/adapters/omp/stream.js";
const model = {
  id: "claude",
  api: "pi-claude-cli",
  provider: "pi-claude-cli",
  reasoning: false,
} as Model;
const request = toRequest(
  model,
  {
    messages: [{ role: "user", content: "hello", timestamp: 0 }],
    tools: [
      {
        name: "edit",
        description: "edit",
        parameters: {
          type: "object",
          properties: { input: { type: "string" } },
        },
      },
    ],
  },
  {},
  readRuntimeConfiguration({}),
  { sessionId: "host", branchId: "root", historyRevision: "0" },
  "/project",
);
function driver(event: DriverEventPayload): ClaudeRoundEvent {
  return {
    type: "driver_event",
    roundId: "round",
    event: { ...event, attribution: {}, sequence: 1 } as ClaudeDriverEvent,
  };
}
function runtime(events: ClaudeRoundEvent[]): ClaudeRuntime {
  return {
    async *streamRound(_request: HostRoundRequest) {
      yield* events;
    },
    invalidate: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    closeAll: vi.fn(async () => {}),
  };
}
async function collect(source: ReturnType<typeof projectRound>) {
  const events: AssistantMessageEvent[] = [];
  for await (const event of source) events.push(event);
  return { events, message: await source.result() };
}

describe("native OMP stream projection", () => {
  it("uses real native streams and emits text/signatures once across deltas and indexed snapshots", async () => {
    const events = [
      driver({
        type: "content_start",
        messageId: "m",
        index: 0,
        content: { type: "text", text: "" },
      }),
      driver({
        type: "content_delta",
        messageId: "m",
        index: 0,
        delta: { kind: "text", text: "hello" },
      }),
      driver({
        type: "assistant_snapshot",
        messageId: "m",
        content: [{ type: "text", text: "hello" }],
        contentIndexes: [0],
      }),
      driver({
        type: "assistant_snapshot",
        messageId: "m",
        content: [{ type: "thinking", thinking: "hmm", signature: "sig" }],
        contentIndexes: [1],
      }),
      {
        type: "round_end" as const,
        roundId: "round",
        reason: "stop" as const,
        pendingToolCallIds: [],
        content: [
          { type: "text" as const, text: "hello" },
          { type: "thinking" as const, thinking: "hmm", signature: "sig" },
        ],
        usage: {
          inputTokens: 10,
          outputTokens: 4,
          cacheReadTokens: 2,
          cacheWriteTokens: 1,
          costUsd: 0.02,
        },
      },
    ];
    const result = await collect(
      projectRound(model, request, {}, runtime(events), { driver: "cli" }),
    );
    expect(result.message.content).toEqual([
      { type: "text", text: "hello" },
      { type: "thinking", thinking: "hmm", thinkingSignature: "sig" },
    ]);
    expect(
      result.events.filter((event) => event.type === "text_delta"),
    ).toHaveLength(1);
    expect(result.events.filter((event) => event.type === "done")).toHaveLength(
      1,
    );
    expect(result.message.usage).toMatchObject({
      input: 10,
      output: 4,
      totalTokens: 17,
      cost: { total: 0.02, input: 0 },
    });
  });
  it("exposes truthful initialized response metadata before content and fails callback errors safely", async () => {
    const init = driver({
      type: "initialized",
      claudeSessionId: "claude-id",
      model: "claude",
      runtimeVersion: "2",
      capabilities: [],
      tools: [],
      mcpServers: [],
    });
    const onResponse = vi.fn(
      async (_response: import("@oh-my-pi/pi-ai").ProviderResponseMetadata) => {
        throw new Error("observer broke");
      },
    );
    const backend = runtime([init]);
    const result = await collect(
      projectRound(model, request, { onResponse }, backend, { driver: "sdk" }),
    );
    expect(onResponse).toHaveBeenCalledOnce();
    expect(onResponse.mock.calls[0]?.[0]).toMatchObject({
      status: 0,
      headers: {
        "x-pi-claude-driver": "sdk",
        "x-pi-claude-transport": "sdk",
        "x-pi-claude-session-id": "claude-id",
      },
    });
    expect(result.message).toMatchObject({
      stopReason: "error",
      errorMessage: "observer broke",
    });
    expect(
      result.events.filter((event) => event.type === "error"),
    ).toHaveLength(1);
    expect(backend.invalidate).toHaveBeenCalled();
  });
  it("emits only active parked host tools with canonical ids and native arguments", async () => {
    const call = {
      type: "tool_call" as const,
      id: "canonical",
      name: "edit",
      arguments: { input: "12:AB|replacement" },
    };
    const result = await collect(
      projectRound(
        model,
        request,
        {},
        runtime([
          driver({
            type: "assistant_snapshot",
            messageId: "m",
            content: [call],
          }),
          driver({ type: "host_tool_request", call }),
          {
            type: "round_end",
            roundId: "round",
            reason: "toolUse",
            pendingToolCallIds: ["canonical"],
            content: [call],
          },
        ]),
        { driver: "cli" },
      ),
    );
    expect(result.message.content).toEqual([
      {
        type: "toolCall",
        id: "canonical",
        name: "edit",
        arguments: { input: "12:AB|replacement" },
      },
    ]);
    expect(
      result.events.filter((event) => event.type === "toolcall_end"),
    ).toHaveLength(1);
    const bad = await collect(
      projectRound(
        model,
        request,
        {},
        runtime([
          driver({
            type: "host_tool_request",
            call: { ...call, name: "inactive" },
          }),
        ]),
        { driver: "cli" },
      ),
    );
    expect(bad.message.stopReason).toBe("error");
    expect(bad.message.errorMessage).toContain("inactive OMP tool");
  });
  it("doesn't add cumulative turn_end usage to incremental round usage", async () => {
    const result = await collect(
      projectRound(
        model,
        request,
        {},
        runtime([
          driver({
            type: "turn_end",
            status: "success",
            subtype: "success",
            isError: false,
            usage: {
              inputTokens: 27,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            },
          }),
          {
            type: "round_end",
            roundId: "round",
            reason: "stop",
            content: [],
            pendingToolCallIds: [],
            usage: {
              inputTokens: 5,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            },
          },
        ]),
        { driver: "cli" },
      ),
    );
    expect(result.message.usage.input).toBe(5);
  });
  it("streams snapshot-only text/thinking suffixes and appends split signatures", async () => {
    const result = await collect(
      projectRound(
        model,
        request,
        {},
        runtime([
          driver({
            type: "content_start",
            messageId: "m",
            index: 0,
            content: { type: "thinking", thinking: "" },
          }),
          driver({
            type: "content_delta",
            messageId: "m",
            index: 0,
            delta: { kind: "signature", signature: "part1" },
          }),
          driver({
            type: "content_delta",
            messageId: "m",
            index: 0,
            delta: { kind: "signature", signature: "part2" },
          }),
          driver({
            type: "assistant_snapshot",
            messageId: "m",
            contentIndexes: [0, 1],
            content: [
              {
                type: "thinking",
                thinking: "thought",
                signature: "part1part2",
              },
              { type: "text", text: "hello" },
            ],
          }),
          driver({
            type: "assistant_snapshot",
            messageId: "m",
            contentIndexes: [1],
            content: [{ type: "text", text: "hello world" }],
          }),
          {
            type: "round_end",
            roundId: "round",
            reason: "stop",
            pendingToolCallIds: [],
            content: [
              {
                type: "thinking",
                thinking: "thought",
                signature: "part1part2",
              },
              { type: "text", text: "hello world" },
            ],
          },
        ]),
        { driver: "cli" },
      ),
    );
    expect(
      result.events
        .filter((event) => event.type === "text_delta")
        .map((event) => event.delta),
    ).toEqual(["hello", " world"]);
    expect(
      result.events
        .filter((event) => event.type === "thinking_delta")
        .map((event) => event.delta),
    ).toEqual(["thought"]);
    expect(result.message.content[0]).toMatchObject({
      thinkingSignature: "part1part2",
    });
  });
  it.each(["conflict", "after-end"])(
    "rejects %s snapshot rewrites with one error terminal",
    async (kind) => {
      const events: ClaudeRoundEvent[] = [
        driver({
          type: "assistant_snapshot",
          messageId: "m",
          content: [{ type: "text", text: "hello" }],
        }),
      ];
      if (kind === "after-end")
        events.push(driver({ type: "content_end", messageId: "m", index: 0 }));
      events.push(
        driver({
          type: "assistant_snapshot",
          messageId: "m",
          content: [
            {
              type: "text",
              text: kind === "conflict" ? "wrong" : "hello changed",
            },
          ],
        }),
      );
      const result = await collect(
        projectRound(model, request, {}, runtime(events), { driver: "cli" }),
      );
      expect(result.message.stopReason).toBe("error");
      expect(result.message.content).toEqual([{ type: "text", text: "hello" }]);
      expect(
        result.events.filter((event) => event.type === "error"),
      ).toHaveLength(1);
    },
  );
  it("keeps agent-id-only child content out of the main stream and retains progress attribution", async () => {
    const child = driver({
      type: "assistant_snapshot",
      messageId: "child",
      content: [{ type: "text", text: "child-only" }],
    });
    if (child.type === "driver_event")
      child.event.attribution = { agentId: "child-id", taskId: "task" };
    const observe = vi.fn();
    const result = await collect(
      projectRound(
        model,
        request,
        {},
        runtime([
          child,
          {
            type: "round_end",
            roundId: "round",
            reason: "stop",
            pendingToolCallIds: [],
            content: [{ type: "text", text: "main" }],
          },
        ]),
        { driver: "cli", observe },
      ),
    );
    expect(result.message.content).toEqual([{ type: "text", text: "main" }]);
    expect(observe).toHaveBeenCalledWith(
      expect.objectContaining({
        attribution: { agentId: "child-id", taskId: "task" },
      }),
    );
  });
  it("reports the same authoritative resident id on a later round without another init", async () => {
    const onResponse = vi.fn();
    const first = driver({
      type: "initialized",
      claudeSessionId: "resident-id",
      model: "claude",
      runtimeVersion: "2",
      capabilities: [],
      tools: [],
      mcpServers: [],
    });
    const next = driver({ type: "message_start", messageId: "next" });
    if (next.type === "driver_event")
      next.event.attribution.claudeSessionId = "resident-id";
    for (const event of [first, next])
      await collect(
        projectRound(
          model,
          request,
          { onResponse },
          runtime([
            event,
            {
              type: "round_end",
              roundId: "round",
              reason: "stop",
              content: [],
              pendingToolCallIds: [],
            },
          ]),
          { driver: "cli" },
        ),
      );
    expect(onResponse).toHaveBeenCalledTimes(2);
    expect(
      onResponse.mock.calls.map(
        ([response]) => response.headers["x-pi-claude-session-id"],
      ),
    ).toEqual(["resident-id", "resident-id"]);
  });
});
