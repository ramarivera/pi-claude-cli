import { describe, expect, it, vi } from "vitest";
import type {
  ExtensionAPI,
  ExtensionContext,
  ProviderConfig,
} from "@oh-my-pi/pi-coding-agent";
import type { Model, ProviderSessionState } from "@oh-my-pi/pi-ai";
import type {
  ClaudeRoundEvent,
  ClaudeRuntime,
  HostRoundRequest,
} from "../../../src/contracts/index.js";
import { readRuntimeConfiguration } from "../../../entrypoints/config.js";
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
import { registerOmpAdapter } from "../../../src/adapters/omp/index.js";

const model = {
  id: "claude-haiku-4-5",
  api: "pi-claude-cli",
  provider: "pi-claude-cli",
  reasoning: false,
} as Model;
function context(id = "host", agent = "Main", kind: "main" | "sub" = "main") {
  return {
    cwd: `/project/${agent}`,
    agent: {
      kind,
      id: agent,
      name: agent.toLowerCase(),
      depth: kind === "main" ? 0 : 1,
    },
    sessionManager: {
      getSessionId: () => id,
      getLeafId: () => crypto.randomUUID(),
    },
    ui: { setStatus: vi.fn() },
    setTimeout: vi.fn((callback: () => void, milliseconds: number) =>
      setTimeout(callback, milliseconds),
    ),
    clearTimer: vi.fn((timer: NodeJS.Timeout) => clearTimeout(timer)),
  } as unknown as ExtensionContext;
}
type Handler = (
  event: unknown,
  ctx: ExtensionContext,
) => void | Promise<unknown>;
function setup(
  round: (
    request: HostRoundRequest,
    index: number,
  ) => AsyncIterable<ClaudeRoundEvent> = async function* (request) {
    yield {
      type: "round_end",
      roundId: request.roundId,
      reason: "stop",
      pendingToolCallIds: [],
      content: [{ type: "text", text: "done" }],
    };
  },
) {
  const handlers = new Map<string, Handler>();
  let provider: ProviderConfig | undefined;
  const events = { emit: vi.fn() };
  const api = {
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    registerProvider: (_name: string, config: ProviderConfig) => {
      provider = config;
    },
    events,
  } as unknown as ExtensionAPI;
  const requests: HostRoundRequest[] = [];
  const runtime: ClaudeRuntime = {
    streamRound(request) {
      requests.push(request);
      return round(request, requests.length);
    },
    invalidate: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    closeAll: vi.fn(async () => {}),
  };
  const factory = vi.fn(async () => runtime);
  registerOmpAdapter(api, {
    configuration: readRuntimeConfiguration({}),
    runtimeFactory: factory,
  });
  if (!provider?.streamSimple) throw new Error("Missing provider");
  const stream = provider.streamSimple;
  const emit = async (
    name: string,
    ctx: ExtensionContext,
    event: unknown = { type: name },
  ) => {
    await handlers.get(name)?.(event, ctx);
  };
  return { emit, requests, runtime, factory, events, stream };
}
const prompt = {
  messages: [{ role: "user" as const, content: "hello", timestamp: 0 }],
};
const flush = async () => {
  await new Promise<void>((resolve) => setImmediate(resolve));
};

describe("native OMP lifecycle", () => {
  it("preserves the authoritative main host session ID without a routing override", async () => {
    const host = setup();
    await host.emit("session_start", context("native-session"));
    await host.stream(model, prompt, {}).result();
    expect(host.requests[0].session.sessionId).toBe("native-session");
    await host.stream(model, prompt, { sessionId: "native-session" }).result();
    expect(host.requests[1].session).toEqual(host.requests[0].session);
  });
  it("uses native cwd and stable history identity across ordinary leaves", async () => {
    const host = setup();
    const ctx = context();
    await host.emit("session_start", ctx);
    await host
      .stream(model, prompt, { cwd: "/native-override", sessionId: "route" })
      .result();
    await host.emit("context", ctx);
    await host
      .stream(model, prompt, { cwd: "/native-override", sessionId: "route" })
      .result();
    expect(host.requests[0].session).toEqual(host.requests[1].session);
    expect(host.requests[0].cwd).toBe("/native-override");
    expect(host.factory).toHaveBeenCalledOnce();
  });
  it("isolates main/subagent sessions even with the same host and routing IDs", async () => {
    const host = setup();
    const main = context("same");
    const child = context("same", "Child", "sub");
    const map = new Map<string, ProviderSessionState>();
    await host.emit("session_start", main);
    await host
      .stream(model, prompt, { sessionId: "same", providerSessionState: map })
      .result();
    await host.emit("before_agent_start", child);
    await host
      .stream(model, prompt, { sessionId: "same", providerSessionState: map })
      .result();
    expect(host.requests[0].session.sessionId).not.toBe(
      host.requests[1].session.sessionId,
    );
    expect(map.size).toBe(2);
    const [mainState] = map.values();
    mainState.close();
    await flush();
    expect(host.runtime.close).toHaveBeenCalledWith(
      host.requests[0].session.sessionId,
    );
    expect(host.runtime.close).not.toHaveBeenCalledWith(
      host.requests[1].session.sessionId,
    );
    expect(map.size).toBe(1);
  });
  it("invalidates compaction/tree/fork revisions and retires saved-session reload state", async () => {
    const host = setup();
    const ctx = context();
    await host.emit("session_start", ctx);
    await host.stream(model, prompt, {}).result();
    await host.emit("session_compact", ctx);
    await host.stream(model, prompt, {}).result();
    expect(host.requests[1].session.historyRevision).toBe("1");
    expect(host.requests[1].session.branchId).toBe("root");
    await host.emit("session_tree", ctx);
    await host.stream(model, prompt, {}).result();
    expect(host.requests[2].session.branchId).toBe("tree:2");
    await host.emit("session_before_switch", ctx, {
      type: "session_before_switch",
      reason: "fork",
    });
    expect(host.runtime.invalidate).toHaveBeenCalledWith(
      expect.anything(),
      "fork",
    );
    expect(host.runtime.close).toHaveBeenCalledWith(
      host.requests[0].session.sessionId,
    );
    const resumed = context("saved");
    await host.emit("session_switch", resumed, {
      type: "session_switch",
      reason: "resume",
    });
    await host.stream(model, prompt, {}).result();
    await host.emit("session_before_switch", resumed, {
      type: "session_before_switch",
      reason: "resume",
    });
    expect(host.runtime.invalidate).toHaveBeenCalledWith(
      expect.anything(),
      "reload",
    );
  });
  it("retains the abort listener while Claude parks for native host tool execution", async () => {
    const host = setup(async function* (request) {
      yield {
        type: "round_end",
        roundId: request.roundId,
        reason: "toolUse",
        content: [
          { type: "tool_call", id: "call", name: "slow", arguments: {} },
        ],
        pendingToolCallIds: ["call"],
      };
    });
    const ctx = context();
    await host.emit("session_start", ctx);
    const controller = new AbortController();
    await host
      .stream(
        model,
        {
          ...prompt,
          tools: [
            {
              name: "slow",
              description: "slow host tool",
              parameters: { type: "object" },
            },
          ],
        },
        { signal: controller.signal },
      )
      .result();
    expect(host.runtime.invalidate).not.toHaveBeenCalled();
    controller.abort("user stopped while host tool ran");
    await flush();
    expect(host.runtime.invalidate).toHaveBeenCalledWith(
      host.requests[0].session,
      "abort",
    );
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(
      "pi-claude-cli-progress",
      undefined,
    );
  });
  it("detaches final-turn abort listeners so old signals can't cancel later rounds", async () => {
    const host = setup();
    const ctx = context();
    await host.emit("session_start", ctx);
    const controller = new AbortController();
    await host.stream(model, prompt, { signal: controller.signal }).result();
    controller.abort();
    await flush();
    expect(host.runtime.invalidate).not.toHaveBeenCalled();
    await host.stream(model, prompt, {}).result();
    expect(host.requests).toHaveLength(2);
  });
  it("closes owned runtimes on shutdown and provider reload without touching unrelated map entries", async () => {
    const host = setup();
    const ctx = context();
    await host.emit("session_start", ctx);
    const unrelated = { close: vi.fn() };
    const map = new Map<string, ProviderSessionState>([["other", unrelated]]);
    await host.stream(model, prompt, { providerSessionState: map }).result();
    await host.emit("session_shutdown", ctx);
    expect(host.runtime.close).toHaveBeenCalledWith(
      host.requests[0].session.sessionId,
    );
    expect(host.runtime.closeAll).toHaveBeenCalledOnce();
    expect(unrelated.close).not.toHaveBeenCalled();
    expect(map.get("other")).toBe(unrelated);
  });
  it("presents attributed Claude tasks through actual status/event APIs without native task execution", async () => {
    const event = {
      type: "observation" as const,
      family: "task" as const,
      subtype: "task_progress",
      data: { description: "child working" },
      sequence: 1,
      attribution: {
        claudeSessionId: "claude",
        taskId: "task",
        agentId: "child",
        parentToolUseId: "parent",
      },
    };
    const host = setup(async function* (request) {
      yield { type: "driver_event", roundId: request.roundId, event };
      yield {
        type: "round_end",
        roundId: request.roundId,
        reason: "stop",
        content: [{ type: "text", text: "main" }],
        pendingToolCallIds: [],
      };
    });
    const ctx = context();
    await host.emit("session_start", ctx);
    await host.stream(model, prompt, {}).result();
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(
      "pi-claude-cli-progress",
      expect.stringContaining("Claude task: task_progress"),
    );
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(
      "pi-claude-cli-progress",
      expect.stringContaining("parentToolUseId=parent"),
    );
    expect(host.events.emit).toHaveBeenCalledWith(
      "pi-claude-cli:observation",
      expect.objectContaining({ owner: "claude", hostAgent: ctx.agent, event }),
    );
    expect(host.requests[0].tools).toEqual([]);
  });
  it("reports live steering unsupported without claiming queued steering", async () => {
    const host = setup();
    const ctx = context();
    await host.emit("session_start", ctx);
    const liveSteering = { claim: vi.fn(), wait: vi.fn() };
    await host.stream(model, prompt, { liveSteering }).result();
    expect(liveSteering.claim).not.toHaveBeenCalled();
    expect(liveSteering.wait).not.toHaveBeenCalled();
    expect(host.events.emit).toHaveBeenCalledWith(
      "pi-claude-cli:capability",
      expect.objectContaining({
        capability: "live-steering",
        supported: false,
        driver: "cli",
      }),
    );
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(
      "pi-claude-cli-steering",
      expect.stringContaining("queued input stays with OMP"),
    );
  });
  it("doesn't initialize the runtime for an already aborted provider request", async () => {
    const host = setup();
    const ctx = context();
    await host.emit("session_start", ctx);
    const controller = new AbortController();
    controller.abort();
    const result = await host
      .stream(model, prompt, { signal: controller.signal })
      .result();
    expect(result.stopReason).toBe("aborted");
    expect(host.factory).not.toHaveBeenCalled();
    expect(host.requests).toEqual([]);
  });
  it.each(["first", "idle"])(
    "honors native managed %s stream timeout with an error terminal",
    async (phase) => {
      const host = setup(async function* (request) {
        if (phase === "idle")
          yield {
            type: "driver_event",
            roundId: request.roundId,
            event: {
              type: "observation",
              family: "diagnostic",
              subtype: "transport-ready",
              data: {},
              attribution: {},
              sequence: 1,
            },
          };
        await new Promise<void>((resolve) => {
          request.signal?.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
        yield {
          type: "round_end",
          roundId: request.roundId,
          reason: "aborted",
          content: [],
          pendingToolCallIds: [],
        };
      });
      const ctx = context();
      await host.emit("session_start", ctx);
      const result = await host
        .stream(model, prompt, {
          streamFirstEventTimeoutMs: phase === "first" ? 5 : 1000,
          streamIdleTimeoutMs: 5,
        })
        .result();
      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).toContain(
        phase === "first" ? "first event timeout" : "stream idle timeout",
      );
      expect(ctx.setTimeout).toHaveBeenCalled();
      expect(host.runtime.invalidate).toHaveBeenCalledWith(
        expect.anything(),
        "reset",
      );
    },
  );
  it("clears a native timeout after a completed round and accepts zero to disable it", async () => {
    const host = setup();
    const ctx = context();
    await host.emit("session_start", ctx);
    await host
      .stream(model, prompt, {
        streamFirstEventTimeoutMs: 5000,
        streamIdleTimeoutMs: 0,
      })
      .result();
    expect(ctx.clearTimer).toHaveBeenCalledOnce();
    expect(host.runtime.invalidate).not.toHaveBeenCalled();
  });
  it("settles a timed-out payload hook before runtime initialization", async () => {
    const host = setup();
    const ctx = context();
    await host.emit("session_start", ctx);
    const result = await host
      .stream(model, prompt, {
        streamFirstEventTimeoutMs: 5,
        onPayload: async () => new Promise<never>(() => {}),
      })
      .result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("first event timeout");
    expect(host.factory).not.toHaveBeenCalled();
  });
});
