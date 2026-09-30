import { describe, expect, it, vi } from "vitest";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import {
  normalizeContext,
  type AssistantMessageEvent,
  type ProviderResponse,
} from "@earendil-works/pi-ai";
import {
  registerPiAdapter,
  assertPiVersion,
} from "../../../src/adapters/pi/index.js";
import {
  collect,
  configuration,
  driver,
  host,
  initialized,
  model,
  runtime,
} from "./support.js";
import type {
  ClaudeRoundEvent,
  ClaudeRuntime,
  HostRoundRequest,
} from "../../../src/contracts/index.js";

const transcript = () =>
  normalizeContext({
    systemPrompt: "host prompt",
    messages: [{ role: "user", content: "hello", timestamp: 1 }],
  });
const terminal = {
  type: "round_end" as const,
  roundId: "r",
  reason: "stop" as const,
  content: [{ type: "text" as const, text: "answer" }],
  pendingToolCallIds: [],
};

const diagnostic: ClaudeRoundEvent = {
  type: "driver_event",
  roundId: "r",
  event: {
    type: "observation",
    family: "diagnostic",
    subtype: "host-mcp-transport",
    data: { phase: "socket-closed", sessionClosing: false },
    sequence: 1,
    attribution: {},
  },
};
describe("current Pi provider registration", () => {
  it.each(["cli", "sdk"] as const)(
    "routes %s through the injected neutral runtime and preserves host policy",
    async (kind) => {
      const native = host();
      const backend = runtime([initialized(), terminal]);
      const factory = vi.fn(async () => backend);
      registerPiAdapter(native.pi, {
        configuration: { ...configuration, driver: kind },
        runtimeFactory: factory,
      });
      await native.emit({ type: "session_start", reason: "startup" });
      const order: string[] = [];
      const response = vi.fn(async (value: ProviderResponse) => {
        order.push("response");
        expect(value.status).toBe(0);
        expect(value.headers).toMatchObject({
          "x-pi-claude-driver": kind,
          "x-pi-claude-session-id": "claude-real",
        });
      });
      const observed = vi.fn(async () => {
        order.push("event");
      });
      const events = await collect(
        native.provider().streamSimple(model, transcript(), {
          onPayload: async (payload) => {
            order.push("payload");
            return {
              ...(payload as HostRoundRequest),
              systemPrompt: "replacement prompt",
            };
          },
          onResponse: response,
          onProviderStreamEvent: observed,
        }),
      );
      expect(factory).toHaveBeenCalledTimes(1);
      expect(response).toHaveBeenCalledTimes(1);
      expect(observed).toHaveBeenCalledTimes(1);
      expect(order).toEqual(["payload", "response", "event"]);
      expect(backend.requests[0]).toMatchObject({
        cwd: "/native/cwd",
        systemPrompt: "replacement prompt",
        session: {
          sessionId: "host-session",
          branchId: "main",
          historyRevision: "0",
        },
      });
      expect(native.pi.setActiveTools).not.toHaveBeenCalled();
      expect(native.pi.getAllTools).not.toHaveBeenCalled();
      expect(events.at(-1)).toMatchObject({
        type: "done",
        message: { content: [{ type: "text", text: "answer" }] },
      });
    },
  );
  it.each(["cli", "sdk"] as const)(
    "preserves %s pre-init diagnostics and observes the response once with initialized identity",
    async (kind) => {
      const native = host();
      const backend = runtime([diagnostic, initialized(), terminal]);
      registerPiAdapter(native.pi, {
        configuration: { ...configuration, driver: kind },
        runtimeFactory: async () => backend,
      });
      await native.emit({ type: "session_start", reason: "startup" });
      const order: string[] = [];
      const response = vi.fn((value: ProviderResponse) => {
        order.push("response");
        expect(value).toMatchObject({
          status: 0,
          headers: { "x-pi-claude-session-id": "claude-real" },
        });
      });
      const observed = vi.fn((event: unknown) => {
        order.push((event as { type: string }).type);
      });
      const events = await collect(
        native.provider().streamSimple(model, transcript(), {
          onResponse: response,
          onProviderStreamEvent: observed,
        }),
      );
      expect(order).toEqual(["observation", "response", "initialized"]);
      expect(response).toHaveBeenCalledTimes(1);
      expect(observed.mock.calls.map(([event]) => event)).toEqual([
        diagnostic.event,
        expect.objectContaining({ type: "initialized" }),
      ]);
      expect(events.at(-1)).toMatchObject({ type: "done" });
    },
  );
  it.each([{ parentToolUseId: "toolu_parent" }, { agentId: "agent-child" }])(
    "keeps child initialization $parentToolUseId$agentId observable without consuming the parent response",
    async (attribution) => {
      const native = host();
      const child: ClaudeRoundEvent = {
        type: "driver_event",
        roundId: "r",
        event: {
          type: "initialized",
          claudeSessionId: "claude-child",
          model: model.id,
          runtimeVersion: "2.1",
          capabilities: [],
          tools: [],
          mcpServers: [],
          sequence: 1,
          attribution: { ...attribution, claudeSessionId: "claude-child" },
        },
      };
      const backend = runtime([child, initialized(), terminal]);
      registerPiAdapter(native.pi, {
        configuration: {
          ...configuration,
          settings: { ...configuration.settings, forwardSubagentText: true },
        },
        runtimeFactory: async () => backend,
      });
      await native.emit({ type: "session_start", reason: "startup" });
      const order: string[] = [];
      const response = vi.fn((value: ProviderResponse) => {
        order.push("response");
        expect(value.headers["x-pi-claude-session-id"]).toBe("claude-real");
      });
      const observed = vi.fn((event: unknown) => {
        order.push((event as { claudeSessionId: string }).claudeSessionId);
      });
      const events = await collect(
        native.provider().streamSimple(model, transcript(), {
          onResponse: response,
          onProviderStreamEvent: observed,
        }),
      );
      expect(order).toEqual(["claude-child", "response", "claude-real"]);
      expect(response).toHaveBeenCalledTimes(1);
      expect(observed.mock.calls[0][0]).toEqual(child.event);
      expect(events.at(-1)).toMatchObject({ type: "done" });
    },
  );
  it("doesn't reuse a cached session ID for diagnostics before a replacement query initializes", async () => {
    const native = host();
    let turn = 0;
    const replacement: ClaudeRoundEvent = {
      type: "driver_event",
      roundId: "r",
      event: {
        type: "initialized",
        claudeSessionId: "claude-replacement",
        model: model.id,
        runtimeVersion: "2.1",
        capabilities: [],
        tools: [],
        mcpServers: [],
        sequence: 2,
        attribution: {},
      },
    };
    const backend: ClaudeRuntime = {
      ...runtime([]),
      streamRound: async function* () {
        yield* turn++ === 0
          ? [initialized(), terminal]
          : [diagnostic, replacement, terminal];
      },
    };
    registerPiAdapter(native.pi, {
      configuration,
      runtimeFactory: async () => backend,
    });
    await native.emit({ type: "session_start", reason: "startup" });
    const response = vi.fn();
    await collect(
      native
        .provider()
        .streamSimple(model, transcript(), { onResponse: response }),
    );
    await collect(
      native
        .provider()
        .streamSimple(model, transcript(), { onResponse: response }),
    );
    expect(
      response.mock.calls.map(
        ([value]) => value.headers["x-pi-claude-session-id"],
      ),
    ).toEqual(["claude-real", "claude-replacement"]);
  });
  it("reports a terminal startup failure without fabricating a Claude session ID", async () => {
    const native = host();
    const backend = runtime([
      diagnostic,
      {
        ...terminal,
        reason: "error",
        content: [],
        error: { code: "transport", message: "startup failed" },
      },
    ]);
    registerPiAdapter(native.pi, {
      configuration,
      runtimeFactory: async () => backend,
    });
    await native.emit({ type: "session_start", reason: "startup" });
    const response = vi.fn();
    const order: string[] = [];
    const events = await collect(
      native.provider().streamSimple(model, transcript(), {
        onProviderStreamEvent: () => {
          order.push("diagnostic");
        },
        onResponse: (value) => {
          order.push("response");
          response(value);
        },
      }),
    );
    expect(order).toEqual(["diagnostic", "response"]);
    expect(response).toHaveBeenCalledExactlyOnceWith({
      status: 0,
      headers: {
        "x-pi-claude-call-scope": "session",
        "x-pi-claude-driver": "cli",
        "x-pi-claude-transport": "subprocess",
        "x-pi-claude-cost": "reported-estimate-usd",
        "x-pi-claude-initialization": "unobserved",
      },
    });
    expect(events.at(-1)).toMatchObject({
      type: "error",
      error: { errorMessage: "startup failed" },
    });
  });
  it("delivers partial output while runtime is still waiting", async () => {
    const native = host();
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const backend: ClaudeRuntime = {
      ...runtime([]),
      streamRound: async function* () {
        yield initialized();
        yield driver({
          type: "content_start",
          messageId: "m",
          index: 0,
          content: { type: "text", text: "" },
        });
        yield driver({
          type: "content_delta",
          messageId: "m",
          index: 0,
          delta: { kind: "text", text: "partial" },
        });
        await wait;
        yield { ...terminal, content: [{ type: "text", text: "partial" }] };
      },
    };
    registerPiAdapter(native.pi, {
      configuration,
      runtimeFactory: async () => backend,
    });
    await native.emit({ type: "session_start", reason: "startup" });
    const stream = native.provider().streamSimple(model, transcript());
    const events: AssistantMessageEvent[] = [];
    for await (const event of stream) {
      events.push(structuredClone(event));
      if (event.type === "text_delta") {
        expect(event.delta).toBe("partial");
        release();
      }
    }
    expect(events.map((event) => event.type)).toEqual([
      "start",
      "text_start",
      "text_delta",
      "text_end",
      "done",
    ]);
  });
  it("runs response callbacks each resident round and remembers authoritative Claude identity", async () => {
    const native = host();
    let turn = 0;
    const backend: ClaudeRuntime = {
      ...runtime([]),
      streamRound: async function* () {
        if (turn++ === 0) yield initialized();
        else yield driver({ type: "message_start", messageId: "second" });
        yield terminal;
      },
    };
    registerPiAdapter(native.pi, {
      configuration,
      runtimeFactory: async () => backend,
    });
    await native.emit({ type: "session_start", reason: "startup" });
    const response = vi.fn();
    await collect(
      native
        .provider()
        .streamSimple(model, transcript(), { onResponse: response }),
    );
    await collect(
      native
        .provider()
        .streamSimple(model, transcript(), { onResponse: response }),
    );
    expect(response).toHaveBeenCalledTimes(2);
    expect(response.mock.calls[1][0].headers["x-pi-claude-session-id"]).toBe(
      "claude-real",
    );
  });
  it.each(["payload", "response", "event"])(
    "settles callback failure in %s as one host error",
    async (callback) => {
      const native = host();
      const backend = runtime([initialized(), terminal]);
      registerPiAdapter(native.pi, {
        configuration,
        runtimeFactory: async () => backend,
      });
      await native.emit({ type: "session_start", reason: "startup" });
      const fail = () => {
        throw new Error(`${callback} failure`);
      };
      const events = await collect(
        native.provider().streamSimple(model, transcript(), {
          onPayload: callback === "payload" ? fail : undefined,
          onResponse: callback === "response" ? fail : undefined,
          onProviderStreamEvent: callback === "event" ? fail : undefined,
        }),
      );
      expect(events.filter((event) => event.type === "error")).toHaveLength(1);
      expect(events.at(-1)).toMatchObject({
        type: "error",
        error: {
          role: "assistant",
          errorMessage: `${callback} failure`,
          stopReason: "error",
        },
      });
      if (callback !== "payload")
        expect(backend.invalidate).toHaveBeenCalledWith(
          { sessionId: "host-session", branchId: "main", historyRevision: "0" },
          "reset",
        );
    },
  );
  it("redacts API and MCP credentials in hooks while keeping original driver credentials", async () => {
    const native = host();
    const backend = runtime([initialized(), terminal]);
    const configured = {
      ...configuration,
      auth: { mode: "api-key" as const, apiKey: "private-api-key" },
      settings: {
        ...configuration.settings,
        userMcpServers: [
          {
            name: "stdio-secret",
            config: {
              type: "stdio" as const,
              command: "local-tool",
              env: { TOKEN: "private-stdio-token" },
            },
          },
          {
            name: "http-secret",
            config: {
              type: "http" as const,
              url: "https://example.test",
              headers: { Authorization: "private-http-token" },
            },
          },
        ],
      },
    };
    registerPiAdapter(native.pi, {
      configuration: configured,
      runtimeFactory: async () => backend,
    });
    await native.emit({ type: "session_start", reason: "startup" });
    const events = await collect(
      native.provider().streamSimple(model, transcript(), {
        onPayload: (value) => {
          const payload = value as HostRoundRequest;
          const serialized = JSON.stringify(payload);
          for (const secret of [
            "private-api-key",
            "private-stdio-token",
            "private-http-token",
          ])
            expect(serialized).not.toContain(secret);
          expect(payload.auth).toEqual({
            mode: "api-key",
            apiKey: "[redacted]",
          });
          expect(payload.settings.userMcpServers).toMatchObject([
            { config: { env: { TOKEN: "[redacted]" } } },
            { config: { headers: { Authorization: "[redacted]" } } },
          ]);
          return { ...payload, systemPrompt: "safe replacement" };
        },
      }),
    );
    expect(events.at(-1)).toMatchObject({ type: "done" });
    expect(backend.requests[0].auth).toEqual(configured.auth);
    expect(backend.requests[0].settings.userMcpServers).toEqual(
      configured.settings.userMcpServers,
    );
    expect(backend.requests[0].systemPrompt).toBe("safe replacement");
  });
  it("disables unsupported minimal effort while preserving native reasoning metadata", () => {
    const native = host();
    registerPiAdapter(native.pi, { configuration });
    const models = native.provider().models ?? [];
    for (const catalogModel of models)
      if (!("type" in catalogModel) || catalogModel.type === "chat") {
        const chat = catalogModel as Extract<
          typeof catalogModel,
          { reasoning: boolean }
        >;
        if (chat.reasoning) expect(chat.thinkingLevelMap?.minimal).toBeNull();
        expect(chat.reasoning).toBe(
          getBuiltinModels("anthropic").find(
            (original) => original.id === chat.id,
          )?.reasoning,
        );
      }
  });
  it("rejects minimal reasoning before opening a runtime", async () => {
    const native = host();
    const factory = vi.fn(async () => runtime([initialized(), terminal]));
    registerPiAdapter(native.pi, { configuration, runtimeFactory: factory });
    await native.emit({ type: "session_start", reason: "startup" });
    const events = await collect(
      native
        .provider()
        .streamSimple(model, transcript(), { reasoning: "minimal" }),
    );
    expect(factory).not.toHaveBeenCalled();
    expect(events).toEqual([
      {
        type: "error",
        reason: "error",
        error: expect.objectContaining({
          role: "assistant",
          stopReason: "error",
          errorMessage:
            "Pi reasoning minimal isn't supported by the Claude runtime adapter",
        }),
      },
    ]);
  });
  it("doesn't claim a response when construction fails", async () => {
    const native = host();
    registerPiAdapter(native.pi, {
      configuration,
      runtimeFactory: async () => {
        throw new Error("construct failed");
      },
    });
    await native.emit({ type: "session_start", reason: "startup" });
    const response = vi.fn();
    const events = await collect(
      native
        .provider()
        .streamSimple(model, transcript(), { onResponse: response }),
    );
    expect(response).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({
      type: "error",
      error: { errorMessage: "construct failed" },
    });
  });
  it("fails clearly outside the supported version and doesn't hide registration errors", () => {
    expect(() => assertPiVersion("0.99.1")).not.toThrow();
    expect(() => assertPiVersion("0.98.0")).toThrow("requires Pi 0.99.1");
    const native = host();
    vi.mocked(native.pi.registerProvider).mockImplementation(() => {
      throw new Error("host failed");
    });
    expect(() => registerPiAdapter(native.pi, { configuration })).toThrow(
      "host failed",
    );
  });
});
