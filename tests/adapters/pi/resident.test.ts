import { expect, it, vi } from "vitest";
import {
  normalizeContext,
  Type,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import type {
  ClaudeDriver,
  ClaudeDriverEvent,
  ClaudeDriverSession,
  DriverSessionRequest,
  HostToolResult,
} from "../../../src/contracts/index.js";
import { createClaudeRuntime } from "../../../src/core/index.js";
import { registerPiAdapter } from "../../../src/adapters/pi/index.js";
import {
  assistant,
  collect,
  configuration,
  driver,
  host,
  model,
} from "./support.js";

it("acknowledges actual core tool ordering and all out-of-order native results without rebuilding a resident session", async () => {
  const opened: DriverSessionRequest[] = [];
  const delivered: (readonly HostToolResult[])[] = [];
  const closes = vi.fn();
  const fake: ClaudeDriver = {
    kind: "cli",
    capabilities: {
      contractVersion: 1,
      driver: "cli",
      toolCorrelation: "claude-tool-use-meta",
      residentSessions: true,
      persistedResume: false,
      structuredToolResults: true,
      images: true,
      steering: "unsupported",
      interactions: [],
      supportedDialogKinds: [],
      forwardSubagentText: false,
    },
    async openSession(request): Promise<ClaudeDriverSession> {
      opened.push(request);
      const number = opened.length;
      let submitted!: () => void;
      const prompt = new Promise<void>((resolve) => {
        submitted = resolve;
      });
      let resultsArrived!: () => void;
      const results = new Promise<void>((resolve) => {
        resultsArrived = resolve;
      });
      let close!: () => void;
      const closed = new Promise<void>((resolve) => {
        close = resolve;
      });
      let isClosed = false;
      const call = (id: string) => ({
        type: "tool_call" as const,
        id,
        name: "native",
        arguments: { newText: id },
      });
      let sequence = 0;
      const frame = (
        payload: Parameters<typeof driver>[0],
      ): ClaudeDriverEvent => {
        const event = driver(payload, ++sequence);
        if (event.type !== "driver_event")
          throw new Error("Expected driver frame");
        return {
          ...event.event,
          attribution: { claudeSessionId: `resident-${number}` },
        };
      };
      return {
        events: (async function* () {
          await Promise.race([prompt, closed]);
          if (isClosed) return;
          yield frame({
            type: "initialized",
            claudeSessionId: `resident-${number}`,
            model: model.id,
            runtimeVersion: "offline",
            capabilities: [],
            tools: [],
            mcpServers: [],
          });
          yield frame({ type: "message_start", messageId: "first" });
          yield frame({
            type: "content_start",
            messageId: "first",
            index: 0,
            content: call("toolu_a"),
          });
          yield frame({
            type: "content_start",
            messageId: "first",
            index: 1,
            content: { type: "text", text: "" },
          });
          yield frame({ type: "content_end", messageId: "first", index: 1 });
          yield frame({
            type: "content_start",
            messageId: "first",
            index: 2,
            content: { type: "text", text: "later text" },
          });
          yield frame({ type: "content_end", messageId: "first", index: 2 });
          yield frame({
            type: "content_start",
            messageId: "first",
            index: 3,
            content: call("toolu_b"),
          });
          yield frame({ type: "host_tool_request", call: call("toolu_a") });
          yield frame({ type: "host_tool_request", call: call("toolu_b") });
          yield frame({
            type: "message_end",
            messageId: "first",
            stopReason: "tool_use",
          });
          await Promise.race([results, closed]);
          if (isClosed) return;
          yield frame({ type: "message_start", messageId: "final" });
          yield frame({
            type: "content_start",
            messageId: "final",
            index: 0,
            content: { type: "text", text: "both results received" },
          });
          yield frame({ type: "content_end", messageId: "final", index: 0 });
          yield frame({
            type: "message_end",
            messageId: "final",
            stopReason: "end_turn",
          });
          yield frame({
            type: "turn_end",
            status: "success",
            isError: false,
            subtype: "success",
          });
          await closed;
        })(),
        submitPrompt: async () => {
          submitted();
        },
        deliverToolResults: async (values) => {
          delivered.push(values);
          resultsArrived();
        },
        answerInteraction: async () => {},
        interrupt: async () => {
          isClosed = true;
          close();
        },
        close: async () => {
          closes();
          isClosed = true;
          close();
        },
      };
    },
  };
  const native = host();
  const backend = createClaudeRuntime({ driver: fake });
  registerPiAdapter(native.pi, {
    configuration,
    runtimeFactory: async () => backend,
  });
  await native.emit({ type: "session_start", reason: "startup" });
  const tools = [
    {
      name: "native",
      description: "Native replacement edit",
      parameters: Type.Object({ newText: Type.String() }),
    },
  ];
  const user = {
    role: "user" as const,
    content: "Use both native calls",
    timestamp: 1,
  };
  const firstEvents = await collect(
    native
      .provider()
      .streamSimple(model, normalizeContext({ tools, messages: [user] })),
  );
  const firstEnd = firstEvents.at(-1);
  expect(firstEnd?.type).toBe("done");
  if (firstEnd?.type !== "done") throw new Error("Expected a host tool round");
  const first: AssistantMessage = firstEnd.message;
  expect(first.content).toEqual([
    {
      type: "toolCall",
      id: "toolu_a",
      name: "native",
      arguments: { newText: "toolu_a" },
    },
    { type: "text", text: "later text" },
    {
      type: "toolCall",
      id: "toolu_b",
      name: "native",
      arguments: { newText: "toolu_b" },
    },
  ]);
  const response = vi.fn();
  const secondEvents = await collect(
    native.provider().streamSimple(
      model,
      normalizeContext({
        tools,
        messages: [
          user,
          first,
          {
            role: "toolResult",
            toolCallId: "toolu_b",
            toolName: "native",
            content: [{ type: "text", text: "denied B" }],
            details: {
              structuredContent: { denied: true },
              _meta: { source: "policy" },
            },
            isError: true,
            timestamp: 2,
          },
          {
            role: "toolResult",
            toolCallId: "toolu_a",
            toolName: "native",
            content: [
              { type: "image", data: "image-data", mimeType: "image/png" },
            ],
            details: { value: "A" },
            isError: false,
            timestamp: 3,
          },
        ],
      }),
      { onResponse: response },
    ),
  );
  expect(secondEvents.at(-1)).toMatchObject({
    type: "done",
    reason: "stop",
    message: { content: [{ type: "text", text: "both results received" }] },
  });
  expect(opened).toHaveLength(1);
  expect(delivered[0].map((result) => result.toolCallId)).toEqual([
    "toolu_b",
    "toolu_a",
  ]);
  expect(delivered[0][0]).toMatchObject({
    isError: true,
    structuredContent: { denied: true },
    _meta: { source: "policy" },
  });
  expect(delivered[0][1].content).toEqual([
    { type: "image", data: "image-data", mimeType: "image/png" },
  ]);
  expect(response.mock.calls[0][0].headers["x-pi-claude-session-id"]).toBe(
    "resident-1",
  );
  await native.emit({ type: "session_shutdown", reason: "quit" });
  expect(closes).toHaveBeenCalledTimes(1);
});

for (const kind of ["cli", "sdk"] as const) {
  it.each(["interleaved", "trailing"] as const)(
    `${kind} reports unsupported %s tool-boundary steering before inference`,
    async (placement) => {
      const openSession = vi.fn(async (): Promise<ClaudeDriverSession> => {
        throw new Error("Unexpected inference");
      });
      const fake: ClaudeDriver = {
        kind,
        capabilities: {
          contractVersion: 1,
          driver: kind,
          toolCorrelation: "claude-tool-use-meta",
          residentSessions: true,
          persistedResume: false,
          structuredToolResults: true,
          images: true,
          steering: "unsupported",
          interactions: [],
          supportedDialogKinds: [],
          forwardSubagentText: false,
        },
        openSession,
      };
      const native = host();
      const backend = createClaudeRuntime({ driver: fake });
      registerPiAdapter(native.pi, {
        configuration: { ...configuration, driver: kind },
        runtimeFactory: async () => backend,
      });
      await native.emit({ type: "session_start", reason: "startup" });
      const calls = assistant(
        [
          { type: "toolCall", id: "a", name: "native", arguments: {} },
          { type: "toolCall", id: "b", name: "native", arguments: {} },
        ],
        "toolUse",
      );
      const resultA = {
        role: "toolResult" as const,
        toolCallId: "a",
        toolName: "native",
        content: [{ type: "text" as const, text: "A" }],
        isError: false,
        timestamp: 2,
      };
      const resultB = {
        ...resultA,
        toolCallId: "b",
        content: [{ type: "text" as const, text: "B" }],
      };
      const steering = {
        role: "user" as const,
        content: "steering",
        timestamp: 3,
      };
      const response = vi.fn();
      const events = await collect(
        native.provider().streamSimple(
          model,
          normalizeContext({
            messages:
              placement === "interleaved"
                ? [calls, resultB, steering, resultA]
                : [calls, resultB, resultA, steering],
          }),
          { onResponse: response },
        ),
      );
      expect(events.at(-1)).toMatchObject({
        type: "error",
        reason: "error",
        error: {
          stopReason: "error",
          errorMessage: expect.stringContaining("steering"),
        },
      });
      expect(openSession).not.toHaveBeenCalled();
      expect(response).not.toHaveBeenCalled();
      await native.emit({ type: "session_shutdown", reason: "quit" });
    },
  );
}
