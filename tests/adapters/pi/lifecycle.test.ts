import { afterEach, describe, expect, it, vi } from "vitest";
import {
  normalizeContext,
  getCurrentTools,
  Type,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type {
  ExtensionContext,
  SessionCompactEvent,
} from "@earendil-works/pi-coding-agent";
import type {
  ClaudeRoundEvent,
  ClaudeRuntime,
  HostRoundRequest,
} from "../../../src/contracts/index.js";
import { registerPiAdapter } from "../../../src/adapters/pi/index.js";
import {
  PiLifecycle,
  idleWatchdog,
} from "../../../src/adapters/pi/lifecycle.js";
import {
  assistant,
  collect,
  configuration,
  host,
  initialized,
  model,
  runtime,
  tool,
} from "./support.js";

const prompt = () =>
  normalizeContext({
    messages: [{ role: "user", content: "hello", timestamp: 1 }],
  });
const call = {
  type: "tool_call" as const,
  id: "toolu_1",
  name: "custom",
  arguments: { input: "value" },
};
const stop: ClaudeRoundEvent = {
  type: "round_end",
  roundId: "r",
  reason: "stop",
  content: [{ type: "text", text: "done" }],
  pendingToolCallIds: [],
};
const parked: ClaudeRoundEvent = {
  type: "round_end",
  roundId: "r",
  reason: "toolUse",
  content: [call],
  pendingToolCallIds: [call.id],
};
const toolPrompt = () =>
  normalizeContext({
    tools: [
      {
        name: tool.name,
        description: tool.description,
        parameters: Type.Object({ input: Type.String() }),
      },
    ],
    messages: [{ role: "user", content: "tool", timestamp: 1 }],
  });
function ctx(
  sessionId = "host-session",
  cwd = "/native/cwd",
  leafId = "leaf",
  signal?: AbortSignal,
): ExtensionContext {
  return {
    cwd,
    signal,
    sessionManager: { getSessionId: () => sessionId, getLeafId: () => leafId },
  } as unknown as ExtensionContext;
}
const compact: SessionCompactEvent = {
  type: "session_compact",
  compactionEntry: {
    type: "compaction",
    id: "compact",
    parentId: null,
    timestamp: new Date(0).toISOString(),
    summary: "shorter history",
    firstKeptEntryId: "entry",
    tokensBefore: 100,
  },
  fromExtension: false,
  reason: "manual",
  willRetry: false,
};
async function setup(events: ClaudeRoundEvent[] = [initialized(), stop]) {
  const native = host();
  const backend = runtime(events);
  const factory = vi.fn(async () => backend);
  registerPiAdapter(native.pi, { configuration, runtimeFactory: factory });
  await native.emit({ type: "session_start", reason: "startup" });
  return {
    ...native,
    backend,
    factory,
    run: (options: SimpleStreamOptions = {}) =>
      collect(native.provider().streamSimple(model, prompt(), options)),
    toolRun: (options: SimpleStreamOptions = {}) =>
      collect(native.provider().streamSimple(model, toolPrompt(), options)),
  };
}
const flush = async () => {
  for (let i = 0; i < 15; i++) await Promise.resolve();
};
afterEach(() => {
  vi.useRealTimers();
});

describe("Pi native lifecycle", () => {
  it("keeps branch/revision stable as ordinary leaves advance and captures actual cwd", async () => {
    const native = await setup();
    await native.run();
    await native.emit(
      { type: "context_with_system", messages: [] },
      ctx("host-session", "/new/cwd", "new-leaf"),
    );
    await native.run();
    expect(native.backend.requests.map((request) => request.session)).toEqual([
      { sessionId: "host-session", branchId: "main", historyRevision: "0" },
      { sessionId: "host-session", branchId: "main", historyRevision: "0" },
    ]);
    expect(native.backend.requests[1].cwd).toBe("/new/cwd");
    expect(native.backend.invalidate).not.toHaveBeenCalled();
  });
  it("increments revision only on successful compact/tree transitions", async () => {
    const native = await setup();
    await native.run();
    await native.emit(compact);
    await native.run();
    await native.emit({
      type: "session_tree",
      newLeafId: "branch-point",
      oldLeafId: "old",
    });
    await native.run();
    expect(native.backend.invalidate).toHaveBeenNthCalledWith(
      1,
      { sessionId: "host-session", branchId: "main", historyRevision: "0" },
      "compaction",
    );
    expect(native.backend.invalidate).toHaveBeenNthCalledWith(
      2,
      { sessionId: "host-session", branchId: "main", historyRevision: "1" },
      "tree",
    );
    expect(native.backend.requests[2].session).toEqual({
      sessionId: "host-session",
      branchId: "tree:branch-point",
      historyRevision: "2",
    });
  });
  it("doesn't invalidate a failed compaction without a history change", async () => {
    const native = await setup();
    await native.run();
    await native.emit({
      type: "session_compact_failed",
      reason: "manual",
      aborted: false,
      errorMessage: "summary failure",
      willRetry: false,
      fromExtension: false,
    });
    await native.run();
    expect(native.backend.invalidate).not.toHaveBeenCalled();
    expect(native.backend.requests[1].session.historyRevision).toBe("0");
  });
  it("closes outgoing forks and gives the new host session a distinct branch", async () => {
    const native = await setup();
    await native.run();
    await native.emit({ type: "session_shutdown", reason: "fork" });
    await native.emit(
      {
        type: "session_start",
        reason: "fork",
        previousSessionFile: "old.jsonl",
      },
      ctx("forked", "/fork/cwd", "fork-leaf"),
    );
    await native.run({ sessionId: "forked" });
    expect(native.backend.close).toHaveBeenCalledWith("host-session");
    expect(native.backend.requests[1]).toMatchObject({
      cwd: "/fork/cwd",
      session: {
        sessionId: "forked",
        branchId: "fork:fork-leaf",
        historyRevision: "1",
      },
    });
  });
  it.each(["new", "resume"] as const)(
    "closes only the outgoing family on %s replacement",
    async (reason) => {
      const native = await setup();
      await native.run();
      await native.emit({ type: "session_shutdown", reason });
      await native.emit(
        { type: "session_start", reason, previousSessionFile: "old" },
        ctx("replacement", "/replacement"),
      );
      await native.run({ sessionId: "replacement" });
      expect(native.backend.close).toHaveBeenCalledTimes(1);
      expect(native.backend.close).toHaveBeenCalledWith("host-session");
      expect(native.backend.closeAll).not.toHaveBeenCalled();
      expect(native.backend.requests[1].session.sessionId).toBe("replacement");
    },
  );
  it("rebuilds the owned runtime after reload instead of claiming persisted Claude identity", async () => {
    const native = host();
    const first = runtime([initialized(), stop]);
    const second = runtime([stop]);
    const factory = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    registerPiAdapter(native.pi, { configuration, runtimeFactory: factory });
    await native.emit({ type: "session_start", reason: "startup" });
    await collect(native.provider().streamSimple(model, prompt()));
    await native.emit({ type: "session_shutdown", reason: "reload" });
    await native.emit({ type: "session_start", reason: "reload" });
    const response = vi.fn();
    await collect(
      native.provider().streamSimple(model, prompt(), { onResponse: response }),
    );
    expect(first.closeAll).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(second.requests[0].session.historyRevision).toBe("1");
    expect(response).not.toHaveBeenCalled();
  });
  it("closes all extension resources on quit without constructing an unused runtime", async () => {
    const unused = await setup();
    await unused.emit({ type: "session_shutdown", reason: "quit" });
    expect(unused.factory).not.toHaveBeenCalled();
    const used = await setup();
    await used.run();
    await used.emit({ type: "session_shutdown", reason: "quit" });
    expect(used.backend.closeAll).toHaveBeenCalledTimes(1);
  });
  it("retains host abort cancellation after toolUse while the next result round hasn't begun", async () => {
    const native = await setup([initialized(), parked]);
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const events = await native.toolRun({ signal: controller.signal });
    expect(events.at(-1)).toMatchObject({ type: "done", reason: "toolUse" });
    expect(add).toHaveBeenCalledTimes(1);
    expect(remove).not.toHaveBeenCalled();
    controller.abort();
    await flush();
    expect(native.backend.requests[0].signal?.aborted).toBe(true);
    expect(native.backend.invalidate).toHaveBeenCalledWith(
      { sessionId: "host-session", branchId: "main", historyRevision: "0" },
      "abort",
    );
    expect(remove).toHaveBeenCalledTimes(1);
  });
  it("removes the previous parked listener when a result round rebinds and clears it after final output", async () => {
    const native = host();
    const requests: HostRoundRequest[] = [];
    const backend: ClaudeRuntime = {
      ...runtime([]),
      streamRound: async function* (request) {
        requests.push(request);
        yield initialized();
        yield requests.length === 1 ? parked : stop;
      },
    };
    registerPiAdapter(native.pi, {
      configuration,
      runtimeFactory: async () => backend,
    });
    await native.emit({ type: "session_start", reason: "startup" });
    const first = new AbortController();
    const second = new AbortController();
    const firstRemove = vi.spyOn(first.signal, "removeEventListener");
    const secondRemove = vi.spyOn(second.signal, "removeEventListener");
    await collect(
      native
        .provider()
        .streamSimple(model, toolPrompt(), { signal: first.signal }),
    );
    const results = normalizeContext({
      tools: getCurrentTools(toolPrompt().messages),
      messages: [
        assistant([{ ...call, type: "toolCall" }], "toolUse"),
        {
          role: "toolResult",
          toolCallId: call.id,
          toolName: call.name,
          content: [{ type: "text", text: "result" }],
          details: { structuredContent: { value: true } },
          isError: false,
          timestamp: 2,
        },
      ],
    });
    await collect(
      native.provider().streamSimple(model, results, { signal: second.signal }),
    );
    first.abort();
    second.abort();
    await flush();
    expect(firstRemove).toHaveBeenCalledTimes(1);
    expect(secondRemove).toHaveBeenCalledTimes(1);
    expect(backend.invalidate).not.toHaveBeenCalled();
    expect(requests[1].input).toMatchObject({
      kind: "tool-results",
      results: [{ toolCallId: call.id, structuredContent: { value: true } }],
    });
  });
  it("cleans a parked Claude session when the next round fails before invoking the runtime", async () => {
    const native = await setup([initialized(), parked]);
    const controller = new AbortController();
    await native.toolRun({ signal: controller.signal });
    const events = await native.run({
      onPayload: () => {
        throw new Error("next payload failed");
      },
    });
    expect(events.at(-1)).toMatchObject({
      type: "error",
      error: { errorMessage: "next payload failed" },
    });
    expect(native.backend.streamRound).toHaveBeenCalledTimes(1);
    expect(native.backend.invalidate).toHaveBeenCalledWith(
      { sessionId: "host-session", branchId: "main", historyRevision: "0" },
      "reset",
    );
    controller.abort();
    await flush();
    expect(native.backend.invalidate).toHaveBeenCalledTimes(1);
  });
  it("settles abandoned parked calls when the native agent loop ends", async () => {
    const native = await setup([initialized(), parked]);
    await native.toolRun();
    await native.emit({ type: "agent_end", messages: [] });
    expect(native.backend.invalidate).toHaveBeenCalledWith(
      { sessionId: "host-session", branchId: "main", historyRevision: "0" },
      "reset",
    );
  });
  it("isolates concurrent native sessions even when another context was captured most recently", async () => {
    const native = await setup();
    await native.emit(
      { type: "session_start", reason: "startup" },
      ctx("other", "/other"),
    );
    await Promise.all([
      native.run({ sessionId: "host-session" }),
      native.run({ sessionId: "other" }),
    ]);
    expect(native.backend.requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          cwd: "/native/cwd",
          session: expect.objectContaining({ sessionId: "host-session" }),
        }),
        expect.objectContaining({
          cwd: "/other",
          session: expect.objectContaining({ sessionId: "other" }),
        }),
      ]),
    );
    await native.emit(compact, ctx("other", "/other"));
    expect(native.backend.invalidate).toHaveBeenCalledTimes(1);
    expect(
      vi.mocked(native.backend.invalidate).mock.calls[0][0].sessionId,
    ).toBe("other");
  });
  it("isolates separate extension instances and rejects same-session reentrancy without cancelling its owner", async () => {
    const native = host();
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const backend: ClaudeRuntime = {
      ...runtime([]),
      streamRound: async function* () {
        yield initialized();
        await wait;
        yield stop;
      },
    };
    registerPiAdapter(native.pi, {
      configuration,
      runtimeFactory: async () => backend,
    });
    await native.emit({ type: "session_start", reason: "startup" });
    const first = collect(native.provider().streamSimple(model, prompt()));
    await flush();
    const duplicate = await collect(
      native.provider().streamSimple(model, prompt()),
    );
    expect(duplicate.at(-1)).toMatchObject({
      type: "error",
      error: {
        errorMessage:
          "Concurrent Pi provider rounds for one session aren't supported",
      },
    });
    expect(backend.invalidate).not.toHaveBeenCalled();
    const other = await setup();
    await other.run();
    await other.emit({ type: "session_shutdown", reason: "quit" });
    expect(backend.closeAll).not.toHaveBeenCalled();
    release();
    await first;
  });
  it("handles a shutdown racing runtime creation without beginning stale inference", async () => {
    const native = host();
    const backend = runtime([initialized(), stop]);
    let release!: (runtime: ClaudeRuntime) => void;
    const pending = new Promise<ClaudeRuntime>((resolve) => {
      release = resolve;
    });
    registerPiAdapter(native.pi, {
      configuration,
      runtimeFactory: () => pending,
    });
    await native.emit({ type: "session_start", reason: "startup" });
    const events = collect(native.provider().streamSimple(model, prompt()));
    await flush();
    const shutdown = native.emit({ type: "session_shutdown", reason: "quit" });
    release(backend);
    await shutdown;
    expect((await events).at(-1)).toMatchObject({
      type: "error",
      reason: "aborted",
    });
    expect(backend.streamRound).not.toHaveBeenCalled();
    expect(backend.closeAll).toHaveBeenCalledTimes(1);
  });
  it("allows a new factory attempt after factory failure without falling back to a different driver", async () => {
    const native = host();
    const backend = runtime([initialized(), stop]);
    const factory = vi
      .fn()
      .mockRejectedValueOnce(new Error("factory failed"))
      .mockResolvedValueOnce(backend);
    registerPiAdapter(native.pi, { configuration, runtimeFactory: factory });
    await native.emit({ type: "session_start", reason: "startup" });
    expect(
      (await collect(native.provider().streamSimple(model, prompt()))).at(-1),
    ).toMatchObject({ type: "error" });
    expect(
      (await collect(native.provider().streamSimple(model, prompt()))).at(-1),
    ).toMatchObject({ type: "done" });
    expect(factory).toHaveBeenCalledTimes(2);
    expect(factory.mock.calls.every((args) => args[0].driver === "cli")).toBe(
      true,
    );
  });
  it("isolates native summary sessions and closes them on completion without touching a parked parent", async () => {
    const native = host();
    const requests: HostRoundRequest[] = [];
    const backend: ClaudeRuntime = {
      ...runtime([]),
      streamRound: async function* (request) {
        requests.push(request);
        yield initialized();
        yield request.session.sessionId === "host-session" ? parked : stop;
      },
    };
    registerPiAdapter(native.pi, {
      configuration,
      runtimeFactory: async () => backend,
    });
    await native.emit({ type: "session_start", reason: "startup" });
    const parent = new AbortController();
    await collect(
      native
        .provider()
        .streamSimple(model, toolPrompt(), { signal: parent.signal }),
    );
    const summary = await collect(
      native.provider().streamSimple(model, prompt(), {
        sessionId: "native-summary",
        maxTokens: 8192,
        cacheRetention: "none",
        timeoutMs: 300_000,
        maxRetryDelayMs: 60_000,
        transport: "auto",
      }),
    );
    expect(summary.at(-1)).toMatchObject({ type: "done" });
    expect(requests[1]).toMatchObject({
      session: { sessionId: "native-summary" },
      cwd: "/native/cwd",
      settings: { maxOutputTokens: 8192 },
    });
    expect(backend.close).toHaveBeenCalledWith("native-summary");
    expect(backend.invalidate).not.toHaveBeenCalled();
    expect(requests[0].signal?.aborted).toBe(false);
    parent.abort();
    await flush();
    expect(backend.invalidate).toHaveBeenCalledWith(
      { sessionId: "host-session", branchId: "main", historyRevision: "0" },
      "abort",
    );
  });
  it("closes an auxiliary session on failure without invalidating its parked parent", async () => {
    const native = host();
    const backend: ClaudeRuntime = {
      ...runtime([]),
      streamRound: async function* (request) {
        yield initialized();
        if (request.session.sessionId === "host-session") yield parked;
        else throw new Error("summary failed");
      },
    };
    registerPiAdapter(native.pi, {
      configuration,
      runtimeFactory: async () => backend,
    });
    await native.emit({ type: "session_start", reason: "startup" });
    await collect(native.provider().streamSimple(model, toolPrompt()));
    const events = await collect(
      native
        .provider()
        .streamSimple(model, prompt(), { sessionId: "summary-failure" }),
    );
    expect(events.at(-1)).toMatchObject({
      type: "error",
      error: { errorMessage: "summary failed" },
    });
    expect(backend.close).toHaveBeenCalledWith("summary-failure");
    expect(
      vi
        .mocked(backend.invalidate)
        .mock.calls.map(([identity]) => identity.sessionId),
    ).toEqual(["summary-failure"]);
    await native.emit({ type: "session_shutdown", reason: "quit" });
  });
  it("isolates auxiliary cancellation from a parked parent", async () => {
    const native = host();
    const requests: HostRoundRequest[] = [];
    const backend: ClaudeRuntime = {
      ...runtime([]),
      streamRound: async function* (request) {
        requests.push(request);
        yield initialized();
        if (request.session.sessionId === "host-session") yield parked;
        else {
          await new Promise<void>((resolve) =>
            request.signal?.addEventListener("abort", () => resolve(), {
              once: true,
            }),
          );
          yield { ...stop, reason: "aborted" };
        }
      },
    };
    registerPiAdapter(native.pi, {
      configuration,
      runtimeFactory: async () => backend,
    });
    await native.emit({ type: "session_start", reason: "startup" });
    await collect(native.provider().streamSimple(model, toolPrompt()));
    const controller = new AbortController();
    const events = collect(
      native.provider().streamSimple(model, prompt(), {
        sessionId: "summary-abort",
        signal: controller.signal,
      }),
    );
    await flush();
    controller.abort();
    expect((await events).at(-1)).toMatchObject({
      type: "error",
      reason: "aborted",
    });
    expect(backend.close).toHaveBeenCalledWith("summary-abort");
    expect(
      vi
        .mocked(backend.invalidate)
        .mock.calls.every(
          ([identity]) => identity.sessionId === "summary-abort",
        ),
    ).toBe(true);
    expect(requests[0].signal?.aborted).toBe(false);
    await native.emit({ type: "session_shutdown", reason: "quit" });
  });
  it("attempts final runtime cleanup even after an earlier session invalidation failed", async () => {
    const native = await setup();
    await native.run();
    vi.mocked(native.backend.invalidate).mockRejectedValue(
      new Error("invalidation failed"),
    );
    await expect(native.emit(compact)).rejects.toThrow("invalidation failed");
    await expect(
      native.emit({ type: "session_shutdown", reason: "quit" }),
    ).rejects.toThrow("Pi session cleanup failed");
    expect(native.backend.closeAll).toHaveBeenCalledTimes(1);
  });
  it("accepts actual createAgentSession default options and doesn't pretend HTTP retries exist", async () => {
    const native = await setup();
    expect(
      (
        await native.run({
          transport: "auto",
          timeoutMs: 300_000,
          websocketConnectTimeoutMs: undefined,
          maxRetryDelayMs: 60_000,
        })
      ).at(-1),
    ).toMatchObject({ type: "done" });
    expect((await native.run({ maxRetryDelayMs: 7 })).at(-1)).toMatchObject({
      type: "error",
      error: {
        errorMessage:
          "Pi custom maxRetryDelayMs isn't supported by the Claude runtime adapter",
      },
    });
  });
});

describe("provider idle watchdog", () => {
  it("resets on activity and releases its timer at a host tool boundary", () => {
    vi.useFakeTimers();
    const timeout = vi.fn();
    const watchdog = idleWatchdog(10, timeout);
    watchdog.touch();
    vi.advanceTimersByTime(8);
    watchdog.touch();
    vi.advanceTimersByTime(8);
    expect(timeout).not.toHaveBeenCalled();
    watchdog.stop();
    vi.advanceTimersByTime(100);
    expect(timeout).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("bounds an idle round, aborts its driver signal and emits an error rather than fabricated success", async () => {
    vi.useFakeTimers();
    const native = host();
    let driverSignal: AbortSignal | undefined;
    const backend: ClaudeRuntime = {
      ...runtime([]),
      streamRound: async function* (request) {
        driverSignal = request.signal;
        yield initialized();
        await new Promise<void>((resolve) =>
          request.signal?.addEventListener("abort", () => resolve(), {
            once: true,
          }),
        );
        yield { ...stop, reason: "aborted" };
      },
    };
    registerPiAdapter(native.pi, {
      configuration,
      runtimeFactory: async () => backend,
    });
    await native.emit({ type: "session_start", reason: "startup" });
    const events = collect(
      native.provider().streamSimple(model, prompt(), { timeoutMs: 10 }),
    );
    await flush();
    await vi.advanceTimersByTimeAsync(10);
    expect(driverSignal?.aborted).toBe(true);
    expect((await events).at(-1)).toMatchObject({
      type: "error",
      reason: "error",
      error: { errorMessage: "Claude provider stream was idle for 10ms" },
    });
    expect(backend.invalidate).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("doesn't apply provider idle timeout while Claude is waiting for host tool execution", async () => {
    vi.useFakeTimers();
    const native = await setup([initialized(), parked]);
    const controller = new AbortController();
    await native.toolRun({ timeoutMs: 10, signal: controller.signal });
    await vi.advanceTimersByTimeAsync(100);
    expect(native.backend.invalidate).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    controller.abort();
    await flush();
    expect(native.backend.invalidate).toHaveBeenCalledTimes(1);
  });
  it("doesn't construct a runtime for lifecycle operations alone", async () => {
    const native = host();
    const factory = vi.fn(async () => runtime([]));
    const lifecycle = new PiLifecycle(factory);
    lifecycle.register(native.pi);
    await native.emit({ type: "session_start", reason: "startup" });
    await native.emit(compact);
    await native.emit({
      type: "session_tree",
      newLeafId: "branch",
      oldLeafId: null,
    });
    await native.emit({ type: "session_shutdown", reason: "quit" });
    expect(factory).not.toHaveBeenCalled();
  });
});
