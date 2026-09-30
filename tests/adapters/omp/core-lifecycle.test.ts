import { describe, expect, it, vi } from "vitest";
import type { Context, Model, ToolResultMessage } from "@oh-my-pi/pi-ai";
import type {
  ClaudeDriver,
  ClaudeDriverEvent,
  ClaudeDriverSession,
  DriverSessionRequest,
  HostRoundRequest,
  HostToolCall,
  HostToolResult,
  UnsequencedClaudeDriverEvent,
} from "../../../src/contracts/index.js";
import { createClaudeRuntime } from "../../../src/core/index.js";
import { Channel } from "../../../src/core/channel.js";
import { readRuntimeConfiguration } from "../../../entrypoints/config.js";
import { toRequest } from "../../../src/adapters/omp/request.js";
vi.mock(
  "@oh-my-pi/pi-utils",
  async () => import("@oh-my-pi/pi-utils/fetch-retry"),
);
vi.mock("@oh-my-pi/pi-ai", async () => {
  const native = await import("@oh-my-pi/pi-ai/utils/event-stream");
  return {
    createAssistantMessageEventStream: native.createAssistantMessageEventStream,
    getBundledModels: () => [],
  };
});
vi.mock("@oh-my-pi/pi-coding-agent", () => ({ VERSION: "18.4.4" }));
import { OmpLifecycle } from "../../../src/adapters/omp/lifecycle.js";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { ExtensionAPI, ProviderConfig } from "@oh-my-pi/pi-coding-agent";
import { projectRound } from "../../../src/adapters/omp/stream.js";
import { registerOmpAdapter } from "../../../src/adapters/omp/index.js";

const model = {
  id: "claude-haiku-4-5",
  api: "pi-claude-cli",
  provider: "pi-claude-cli",
  reasoning: false,
} as Model;
const configuration = readRuntimeConfiguration({});
const sessionIdentity = {
  sessionId: "host",
  branchId: "root",
  historyRevision: "0",
};
const tools: Context["tools"] = [
  {
    name: "edit",
    description: "native edit",
    parameters: { type: "object", properties: { input: { type: "string" } } },
  },
];
const call: HostToolCall = {
  type: "tool_call",
  id: "claude-call",
  name: "edit",
  arguments: { input: "12:AB|replacement" },
};
function scriptedDriver(
  emptyText: boolean,
  behavior: "gate" | "wait" | "stop" = "gate",
) {
  const opened: DriverSessionRequest[] = [],
    results: HostToolResult[] = [];
  const submitPrompt = vi.fn(async () => {
    if (behavior === "wait") return;
    if (behavior === "stop") {
      emit({
        type: "assistant_snapshot",
        messageId: "aux",
        content: [{ type: "text", text: "auxiliary done" }],
        attribution: {},
      });
      emit({ type: "message_end", messageId: "aux", attribution: {} });
      emit({
        type: "turn_end",
        status: "success",
        subtype: "success",
        isError: false,
        attribution: {},
      });
      return;
    }
    emit({ type: "message_start", messageId: "m1", attribution: {} });
    emit({
      type: "content_start",
      messageId: "m1",
      index: emptyText ? 0 : 1,
      content: { type: "text", text: "" },
      attribution: {},
    });
    if (!emptyText)
      emit({
        type: "content_delta",
        messageId: "m1",
        index: 1,
        delta: { kind: "text", text: "after tool proposal" },
        attribution: {},
      });
    emit({
      type: "content_end",
      messageId: "m1",
      index: emptyText ? 0 : 1,
      attribution: {},
    });
    emit({
      type: "assistant_snapshot",
      messageId: "m1",
      content: emptyText
        ? [{ type: "text", text: "" }, call]
        : [call, { type: "text", text: "after tool proposal" }],
      contentIndexes: [0, 1],
      attribution: {},
    });
    emit({ type: "message_end", messageId: "m1", attribution: {} });
    // Actual MCP parking occurs after a later assistant block streamed.
    emit({ type: "host_tool_request", call, attribution: {} });
  });
  const events = new Channel<ClaudeDriverEvent>();
  let sequence = 0;
  const emit = (event: UnsequencedClaudeDriverEvent) =>
    events.push({
      ...event,
      attribution: { ...event.attribution, claudeSessionId: "resident-claude" },
      sequence: ++sequence,
    });
  const query: ClaudeDriverSession = {
    events,
    submitPrompt,
    async deliverToolResults(delivered) {
      results.push(...delivered);
      emit({
        type: "assistant_snapshot",
        messageId: "m2",
        content: [{ type: "text", text: "result consumed" }],
        attribution: {},
      });
      emit({ type: "message_end", messageId: "m2", attribution: {} });
      emit({
        type: "turn_end",
        status: "success",
        subtype: "success",
        isError: false,
        attribution: {},
      });
    },
    answerInteraction: vi.fn(async () => {}),
    interrupt: vi.fn(async () => {}),
    close: vi.fn(async () => {
      await query.interrupt("session closed");
      events.end();
    }),
  };
  const driver: ClaudeDriver = {
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
    async openSession(request) {
      opened.push(request);
      emit({
        type: "initialized",
        claudeSessionId: "resident-claude",
        model: request.model,
        runtimeVersion: "offline",
        capabilities: [],
        tools: ["mcp__host__edit"],
        mcpServers: [{ name: "host", status: "connected" }],
        attribution: {},
      });
      return query;
    },
  };
  return { driver, opened, results, query, submitPrompt };
}
function request(context: Context): HostRoundRequest {
  return toRequest(
    model,
    context,
    {},
    configuration,
    sessionIdentity,
    "/project",
  );
}

describe("OMP projection through the actual shared runtime", () => {
  it("preserves a parked main tool request while disposable provider calls complete and abort", async () => {
    const sessions: ReturnType<typeof scriptedDriver>[] = [];
    const base = scriptedDriver(false);
    const runtime = createClaudeRuntime({
      driver: {
        ...base.driver,
        async openSession(request) {
          const scripted = scriptedDriver(
            false,
            sessions.length === 0
              ? "gate"
              : sessions.length === 1
                ? "wait"
                : "stop",
          );
          sessions.push(scripted);
          return scripted.driver.openSession(request);
        },
      },
    });
    const handlers = new Map<
      string,
      (event: unknown, ctx: ExtensionContext) => unknown
    >();
    let provider: ProviderConfig | undefined;
    const ctx = {
      cwd: "/project",
      agent: { kind: "main", id: "Main", name: "main", depth: 0 },
      sessionManager: { getSessionId: () => "host" },
      ui: { setStatus: vi.fn(), notify: vi.fn() },
      setTimeout: (callback: () => void, milliseconds: number) =>
        setTimeout(callback, milliseconds),
      clearTimer: (timer: NodeJS.Timeout) => clearTimeout(timer),
    } as unknown as ExtensionContext;
    registerOmpAdapter(
      {
        on: (
          name: string,
          handler: (event: unknown, ctx: ExtensionContext) => unknown,
        ) => handlers.set(name, handler),
        registerProvider: (_name: string, config: ProviderConfig) => {
          provider = config;
        },
        events: { emit: vi.fn() },
        logger: { error: vi.fn() },
      } as unknown as ExtensionAPI,
      { configuration, runtimeFactory: async () => runtime },
    );
    await handlers.get("session_start")!({ type: "session_start" }, ctx);
    if (!provider?.streamSimple) throw new Error("Missing provider");
    const stream = provider.streamSimple;
    const transcript: Context = {
      tools,
      messages: [{ role: "user", content: "edit", timestamp: 0 }],
    };
    try {
      const first = await stream(model, transcript, {
        sessionId: "host",
      }).result();
      expect(first.stopReason).toBe("toolUse");
      const controller = new AbortController();
      const cancelled = stream(
        model,
        { messages: transcript.messages },
        { signal: controller.signal },
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      const completed = await stream(
        model,
        { messages: transcript.messages },
        {},
      ).result();
      expect(completed.stopReason).toBe("stop");
      controller.abort("auxiliary cancelled");
      expect((await cancelled.result()).stopReason).toBe("aborted");
      expect(sessions).toHaveLength(3);
      expect(
        new Set(
          sessions.flatMap((session) =>
            session.opened.map((opened) => opened.identity.sessionId),
          ),
        ).size,
      ).toBe(3);
      expect(sessions[0].query.close).not.toHaveBeenCalled();
      expect(sessions[0].query.interrupt).not.toHaveBeenCalled();
      expect(sessions[1].query.close).toHaveBeenCalledOnce();
      expect(sessions[2].query.close).toHaveBeenCalledOnce();
      transcript.messages.push(first, {
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: "text", text: "changed" }],
        isError: false,
        timestamp: 1,
      });
      const final = await stream(model, transcript, {
        sessionId: "host",
      }).result();
      expect(final.content).toEqual([
        { type: "text", text: "result consumed" },
      ]);
      expect(sessions).toHaveLength(3);
      expect(sessions[0].submitPrompt).toHaveBeenCalledOnce();
      expect(sessions[0].results).toMatchObject([
        { toolCallId: call.id, content: [{ type: "text", text: "changed" }] },
      ]);
      await handlers.get("session_shutdown")!(
        { type: "session_shutdown" },
        ctx,
      );
      expect(sessions[0].query.close).toHaveBeenCalledOnce();
    } finally {
      await runtime.closeAll();
    }
  });
  it("keeps Claude block order and resident tool-result handoff when MCP parking arrives late", async () => {
    const scripted = scriptedDriver(false);
    const runtime = createClaudeRuntime({ driver: scripted.driver });
    try {
      const transcript: Context = {
        tools,
        messages: [{ role: "user", content: "edit", timestamp: 0 }],
      };
      const observation = { driver: "cli" as const };
      const onResponse = vi.fn();
      const first = await projectRound(
        model,
        request(transcript),
        { onResponse },
        runtime,
        observation,
      ).result();
      expect(first.content).toEqual([
        {
          type: "toolCall",
          id: call.id,
          name: call.name,
          arguments: call.arguments,
        },
        { type: "text", text: "after tool proposal" },
      ]);
      const result: ToolResultMessage = {
        role: "toolResult",
        toolCallId: call.id,
        toolName: "edit",
        content: [{ type: "text", text: "changed" }],
        details: {
          structuredContent: { changed: true },
          _meta: { source: "native" },
        },
        isError: false,
        timestamp: 1,
      };
      transcript.messages.push(first, result);
      const second = await projectRound(
        model,
        request(transcript),
        { onResponse },
        runtime,
        observation,
      ).result();
      expect(second.stopReason).toBe("stop");
      expect(second.content).toEqual([
        { type: "text", text: "result consumed" },
      ]);
      expect(scripted.opened).toHaveLength(1);
      expect(scripted.submitPrompt).toHaveBeenCalledOnce();
      expect(scripted.results).toMatchObject([
        {
          toolCallId: call.id,
          structuredContent: { changed: true },
          _meta: { source: "native" },
          details: result.details,
        },
      ]);
      expect(
        onResponse.mock.calls.map(
          ([response]) => response.headers["x-pi-claude-session-id"],
        ),
      ).toEqual(["resident-claude", "resident-claude"]);
    } finally {
      await runtime.closeAll();
    }
  });
  it("elides empty text without losing the canonical host tool block", async () => {
    const scripted = scriptedDriver(true);
    const runtime = createClaudeRuntime({ driver: scripted.driver });
    try {
      const transcript: Context = {
        tools,
        messages: [{ role: "user", content: "edit", timestamp: 0 }],
      };
      const first = await projectRound(
        model,
        request(transcript),
        {},
        runtime,
        { driver: "cli" },
      ).result();
      expect(first.content).toEqual([
        {
          type: "toolCall",
          id: call.id,
          name: call.name,
          arguments: call.arguments,
        },
      ]);
      transcript.messages.push(first, {
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: "text", text: "changed" }],
        isError: false,
        timestamp: 1,
      });
      const second = await projectRound(
        model,
        request(transcript),
        {},
        runtime,
        { driver: "cli" },
      ).result();
      expect(second.stopReason).toBe("stop");
      expect(scripted.opened).toHaveLength(1);
      expect(scripted.submitPrompt).toHaveBeenCalledOnce();
    } finally {
      await runtime.closeAll();
    }
  });
  it("closes the actual parked Claude driver query when a native host signal aborts between rounds", async () => {
    const scripted = scriptedDriver(false);
    const runtime = createClaudeRuntime({ driver: scripted.driver });
    const lifecycle = new OmpLifecycle(async () => runtime);
    lifecycle.capture({
      cwd: "/project",
      agent: { kind: "main", id: "Main", name: "main", depth: 0 },
      sessionManager: { getSessionId: () => "host" },
      ui: { setStatus: vi.fn() },
    } as unknown as ExtensionContext);
    const state = lifecycle.session({ sessionId: "host" });
    const controller = new AbortController();
    const round = {
      ...request({
        tools,
        messages: [{ role: "user", content: "edit", timestamp: 0 }],
      }),
      session: { ...state.identity },
      signal: lifecycle.bindAbort(state, controller.signal),
    };
    try {
      await lifecycle.runtime();
      const first = await projectRound(model, round, {}, runtime, {
        driver: "cli",
        terminal: (reason) => {
          state.parked = reason === "toolUse";
          if (!state.parked) lifecycle.detach(state);
        },
      }).result();
      expect(first.stopReason).toBe("toolUse");
      expect(scripted.query.close).not.toHaveBeenCalled();
      controller.abort("user cancelled during native tool execution");
      await state.cleanup;
      expect(scripted.query.close).toHaveBeenCalledOnce();
      expect(scripted.query.interrupt).toHaveBeenCalled();
      expect(state.identity.historyRevision).toBe("1");
    } finally {
      await runtime.closeAll();
    }
  });
});
