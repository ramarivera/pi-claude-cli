import { describe, expect, it, vi } from "vitest";
import type {
  Context,
  LiveSteering,
  Model,
  UserMessage,
} from "@oh-my-pi/pi-ai";
import type {
  ClaudeDriver,
  ClaudeDriverEvent,
  ClaudeDriverSession,
  DriverPrompt,
  UnsequencedClaudeDriverEvent,
} from "../../../src/contracts/index.js";
import { Channel } from "../../../src/core/channel.js";
import { createClaudeRuntime } from "../../../src/core/index.js";
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
  };
});
import { projectRound } from "../../../src/adapters/omp/stream.js";

const model = {
  id: "claude-haiku-4-5",
  api: "pi-claude-cli",
  provider: "pi-claude-cli",
  reasoning: false,
} as Model;
const configuration = readRuntimeConfiguration({});
const session = { sessionId: "host", branchId: "root", historyRevision: "0" };
const initial: Context = {
  messages: [{ role: "user", content: "start", timestamp: 0 }],
};
const correction: UserMessage = {
  role: "user",
  content: [
    {
      type: "text",
      text: "use this image instead",
      textSignature: "native-text-id",
    },
    {
      type: "image",
      data: "aW1hZ2U=",
      mimeType: "image/png",
      detail: "original",
    },
  ],
  timestamp: 1,
};
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function queue() {
  const ready = deferred();
  let available = false;
  const accept = vi.fn();
  const reject = vi.fn();
  const source: LiveSteering = {
    wait: vi.fn(async (signal) => {
      if (available || signal.aborted) return;
      await Promise.race([
        ready.promise,
        new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        ),
      ]);
      // Once consumed, future waits stay asleep until the round stops.
      if (!available && !signal.aborted)
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
    }),
    claim: vi.fn(async () => {
      if (!available) return undefined;
      available = false;
      return { messages: [correction], accept, reject };
    }),
  };
  return {
    source,
    accept,
    reject,
    inject() {
      available = true;
      ready.resolve();
    },
  };
}
function driver() {
  const events = new Channel<ClaudeDriverEvent>();
  const admission = deferred();
  let sequence = 0;
  const emit = (event: UnsequencedClaudeDriverEvent) =>
    events.push({
      ...event,
      sequence: ++sequence,
      attribution: { ...event.attribution, claudeSessionId: "resident" },
    });
  const submitPrompt = vi.fn(async (prompt: DriverPrompt) => {
    if (prompt.steering) await admission.promise;
    else emit({ type: "message_start", messageId: "first", attribution: {} });
  });
  const query: ClaudeDriverSession = {
    events,
    submitPrompt,
    deliverToolResults: vi.fn(async () => {}),
    answerInteraction: vi.fn(async () => {}),
    interrupt: vi.fn(async () => {}),
    close: vi.fn(async () => events.end()),
  };
  const backend: ClaudeDriver = {
    kind: "cli",
    capabilities: {
      contractVersion: 1,
      driver: "cli",
      toolCorrelation: "claude-tool-use-meta",
      residentSessions: true,
      persistedResume: false,
      structuredToolResults: true,
      images: true,
      steering: "active-queue",
      interactions: [],
      supportedDialogKinds: [],
      forwardSubagentText: false,
    },
    openSession: vi.fn(async () => {
      emit({
        type: "initialized",
        claudeSessionId: "resident",
        model: model.id,
        runtimeVersion: "offline",
        capabilities: [],
        tools: [],
        mcpServers: [],
        attribution: {},
      });
      return query;
    }),
  };
  function complete(id: string, text: string) {
    emit({
      type: "assistant_snapshot",
      messageId: id,
      content: [{ type: "text", text }],
      attribution: {},
    });
    emit({ type: "message_end", messageId: id, attribution: {} });
    emit({
      type: "turn_end",
      status: "success",
      subtype: "success",
      isError: false,
      attribution: {},
    });
  }
  return {
    backend,
    query,
    submitPrompt,
    admission,
    complete,
    startQueued() {
      emit({
        type: "observation",
        family: "user-input",
        subtype: "steering-admission",
        data: {
          commandId: submitPrompt.mock.calls[1][0].commandId!,
          state: "started",
        },
        attribution: {},
      });
    },
  };
}
function request(context: Context, source: LiveSteering) {
  return toRequest(
    model,
    context,
    { sessionId: "host", liveSteering: source },
    configuration,
    session,
    "/project",
  );
}

describe("OMP active queue through the shared production runtime", () => {
  it("returns claimed input to OMP when native queue admission fails", async () => {
    const hostQueue = queue();
    const native = driver();
    const runtime = createClaudeRuntime({ driver: native.backend });
    try {
      const response = projectRound(
        model,
        request(initial, hostQueue.source),
        {},
        runtime,
        { driver: "cli" },
      ).result();
      await vi.waitFor(() =>
        expect(hostQueue.source.wait).toHaveBeenCalledOnce(),
      );
      hostQueue.inject();
      await vi.waitFor(() =>
        expect(native.submitPrompt).toHaveBeenCalledTimes(2),
      );
      native.admission.reject(new Error("native queue refused input"));
      const result = await response;
      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).toContain("native queue refused input");
      expect(hostQueue.reject).toHaveBeenCalledOnce();
      expect(hostQueue.accept).not.toHaveBeenCalled();
    } finally {
      await runtime.closeAll();
    }
  });
  it("waits quietly without claiming an ordinary empty queue", async () => {
    const hostQueue = queue();
    const native = driver();
    const runtime = createClaudeRuntime({ driver: native.backend });
    try {
      const response = projectRound(
        model,
        request(initial, hostQueue.source),
        {},
        runtime,
        { driver: "cli" },
      ).result();
      await vi.waitFor(() =>
        expect(hostQueue.source.wait).toHaveBeenCalledOnce(),
      );
      expect(hostQueue.source.claim).not.toHaveBeenCalled();
      native.complete("first", "ordinary response");
      expect((await response).stopReason).toBe("stop");
      expect(hostQueue.source.wait).toHaveBeenCalledOnce();
      expect(hostQueue.accept).not.toHaveBeenCalled();
      expect(hostQueue.reject).not.toHaveBeenCalled();
    } finally {
      await runtime.closeAll();
    }
  });
  it("accepts only after admission, preserves images, and consumes the queued successor on the next host request", async () => {
    const hostQueue = queue();
    const native = driver();
    const runtime = createClaudeRuntime({ driver: native.backend });
    const onResponse = vi.fn();
    try {
      const response = projectRound(
        model,
        request(initial, hostQueue.source),
        { onResponse },
        runtime,
        { driver: "cli" },
      ).result();
      await vi.waitFor(() =>
        expect(hostQueue.source.wait).toHaveBeenCalledOnce(),
      );
      hostQueue.inject();
      await vi.waitFor(() =>
        expect(native.submitPrompt).toHaveBeenCalledTimes(2),
      );
      expect(native.submitPrompt.mock.calls[1][0]).toMatchObject({
        priority: "next",
        steering: "active-queue",
        content: [
          { type: "text", text: "use this image instead" },
          { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
        ],
      });
      expect(hostQueue.accept).not.toHaveBeenCalled();
      native.admission.resolve();
      await vi.waitFor(() => expect(hostQueue.accept).toHaveBeenCalledOnce());
      native.complete("first", "original response");
      native.startQueued();
      native.complete("successor", "image correction applied");
      const first = await response;
      expect(first.content).toEqual([
        { type: "text", text: "original response" },
      ]);
      expect(onResponse.mock.calls[0][0].metadata.steering).toBe(
        "active-queue",
      );
      const next = projectRound(
        model,
        request(
          { messages: [...initial.messages, first, correction] },
          queue().source,
        ),
        {},
        runtime,
        { driver: "cli" },
      );
      const second = await next.result();
      expect(second.content).toEqual([
        { type: "text", text: "image correction applied" },
      ]);
      expect(second.stopReason).toBe("stop");
      expect(native.backend.openSession).toHaveBeenCalledOnce();
      expect(native.submitPrompt).toHaveBeenCalledTimes(2);
      expect(hostQueue.accept).toHaveBeenCalledOnce();
      expect(hostQueue.reject).not.toHaveBeenCalled();
    } finally {
      await runtime.closeAll();
    }
  });
});
