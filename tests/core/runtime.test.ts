import { describe, expect, it, vi } from "vitest";
import {
  createClaudeEventNormalizer,
  createClaudeRuntime,
} from "../../src/core/index.js";
import type {
  AssistantContent,
  ClaudeDriver,
  ClaudeDriverEvent,
  ClaudeDriverSession,
  ClaudeRoundEvent,
  DriverPrompt,
  DriverSessionRequest,
  HostRoundRequest,
  HostToolCall,
  HostToolResult,
  InteractionResponse,
  TranscriptMessage,
  UnsequencedClaudeDriverEvent,
  Usage,
} from "../../src/contracts/index.js";

// These are offline scripted driver doubles, not inference or protocol captures.
class OfflineSession implements ClaudeDriverSession {
  readonly prompts: DriverPrompt[] = [];
  readonly results: HostToolResult[] = [];
  readonly responses: InteractionResponse[] = [];
  readonly cancellations: HostToolResult[] = [];
  readonly pending = new Map<string, HostToolCall>();
  onPrompt?: (prompt: DriverPrompt) => void;
  onResults?: (results: readonly HostToolResult[]) => void;
  interruptCount = 0;
  closeCount = 0;
  sequence = 0;
  private frames: ClaudeDriverEvent[] = [];
  private notify?: () => void;
  private ended = false;
  readonly normalizer = createClaudeEventNormalizer({
    tools: [
      {
        name: "read",
        owner: "host",
        description: "read",
        inputSchema: { type: "object" },
      },
    ],
    hostMcpServerName: "host",
    requestedModel: "model",
  });
  readonly events: AsyncIterable<ClaudeDriverEvent> = {
    [Symbol.asyncIterator]: () => this.iterate(),
  };
  private async *iterate(): AsyncGenerator<ClaudeDriverEvent> {
    while (this.frames.length || !this.ended) {
      if (this.frames.length) yield this.frames.shift() as ClaudeDriverEvent;
      else
        await new Promise<void>((resolve) => {
          this.notify = resolve;
        });
    }
  }
  emit(event: UnsequencedClaudeDriverEvent): void {
    this.frames.push({ ...event, sequence: ++this.sequence });
    this.notify?.();
    this.notify = undefined;
  }
  raw(payload: unknown): void {
    for (const event of this.normalizer.normalize(payload)) this.emit(event);
  }
  end(): void {
    this.ended = true;
    this.notify?.();
    this.notify = undefined;
  }
  async submitPrompt(prompt: DriverPrompt): Promise<void> {
    this.prompts.push(prompt);
    this.onPrompt?.(prompt);
  }
  async deliverToolResults(results: readonly HostToolResult[]): Promise<void> {
    this.results.push(...results);
    for (const result of results) this.pending.delete(result.toolCallId);
    this.onResults?.(results);
  }
  async answerInteraction(response: InteractionResponse): Promise<void> {
    this.responses.push(response);
  }
  async interrupt(reason = "cancelled"): Promise<void> {
    this.interruptCount++;
    for (const call of this.pending.values())
      this.cancellations.push({
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: "text", text: reason }],
        isError: true,
      });
    this.pending.clear();
  }
  async close(): Promise<void> {
    if (this.closeCount) return;
    this.closeCount++;
    await this.interrupt("session closed");
    this.end();
  }
  park(call: HostToolCall, extra: object = {}): void {
    this.pending.set(call.id, call);
    this.emit({
      type: "host_tool_request",
      call,
      attribution: { claudeSessionId: "claude", ...extra },
    });
  }
}
class OfflineDriver implements ClaudeDriver {
  readonly kind = "cli";
  readonly capabilities = {
    contractVersion: 1 as const,
    driver: "cli" as const,
    toolCorrelation: "claude-tool-use-meta" as const,
    residentSessions: true,
    persistedResume: false,
    structuredToolResults: true,
    images: true,
    steering: "tool-boundary" as const,
    interactions: ["permission", "elicitation", "dialog"] as const,
    supportedDialogKinds: [],
    forwardSubagentText: true,
  };
  readonly opened: DriverSessionRequest[] = [];
  readonly sessions: OfflineSession[] = [];
  setup?: (session: OfflineSession, request: DriverSessionRequest) => void;
  async openSession(request: DriverSessionRequest): Promise<OfflineSession> {
    this.opened.push(request);
    const session = new OfflineSession();
    this.sessions.push(session);
    this.setup?.(session, request);
    session.emit({
      type: "initialized",
      claudeSessionId: `claude-${this.sessions.length}`,
      model: request.model,
      runtimeVersion: "2.1.285",
      capabilities: [],
      tools: ["mcp__host__read"],
      mcpServers: [{ name: "host", status: "connected" }],
      attribution: {},
    });
    return session;
  }
}
const request = (
  overrides: Partial<HostRoundRequest> = {},
): HostRoundRequest => ({
  roundId: "r1",
  session: { sessionId: "host", branchId: "root", historyRevision: "0" },
  cwd: "/sandbox",
  model: "model",
  systemPrompt: "Use the host",
  tools: [
    {
      name: "read",
      owner: "host",
      description: "read",
      inputSchema: { type: "object" },
    },
  ],
  transcript: [],
  input: { kind: "prompt", content: [{ type: "text", text: "go" }] },
  settings: { toolResultTimeoutMs: 1000, claudeTools: [], userMcpServers: [] },
  auth: { mode: "claude-login" },
  ...overrides,
});
const call = (id: string): HostToolCall => ({
  type: "tool_call",
  id,
  name: "read",
  arguments: { path: id },
});
const toolResult = (id: string): HostToolResult => ({
  toolCallId: id,
  toolName: "read",
  content: [{ type: "text", text: `${id} result` }],
  isError: false,
  structuredContent: { id },
  _meta: { preserved: true },
});
const user: TranscriptMessage = {
  role: "user",
  content: [{ type: "text", text: "go" }],
};
const collect = async (
  events: AsyncIterable<ClaudeRoundEvent>,
): Promise<ClaudeRoundEvent[]> => {
  const values: ClaudeRoundEvent[] = [];
  for await (const event of events) values.push(event);
  return values;
};
function outcome(
  events: readonly ClaudeRoundEvent[],
): Extract<ClaudeRoundEvent, { type: "round_end" }> {
  const ends = events.filter((event) => event.type === "round_end");
  expect(ends).toHaveLength(1);
  return ends[0];
}
function assistant(
  content: readonly AssistantContent[],
  reason: "stop" | "toolUse" = "stop",
): TranscriptMessage {
  return { role: "assistant", content, stopReason: reason };
}
function step(
  session: OfflineSession,
  id: string,
  content: AssistantContent[],
  usage?: Usage,
): void {
  session.emit({
    type: "message_start",
    messageId: id,
    model: "model",
    attribution: {},
  });
  session.emit({
    type: "assistant_snapshot",
    messageId: id,
    content,
    contentIndexes: content.map((_, index) => index),
    attribution: {},
  });
  session.emit({ type: "message_end", messageId: id, usage, attribution: {} });
}
function success(session: OfflineSession, usage?: Usage): void {
  session.emit({
    type: "turn_end",
    status: "success",
    isError: false,
    subtype: "success",
    usage,
    resultText: "done",
    attribution: {},
  });
}
async function started(
  driver: OfflineDriver,
  index = 0,
): Promise<OfflineSession> {
  await vi.waitFor(() =>
    expect(driver.sessions[index]?.prompts.length).toBeGreaterThan(0),
  );
  return driver.sessions[index];
}

describe("Claude runtime session ownership (offline)", () => {
  it("submits a current user once and keeps a resident pump after a completed turn", async () => {
    const driver = new OfflineDriver();
    driver.setup = (session) => {
      session.onPrompt = () => {
        step(session, `m${session.prompts.length}`, [
          { type: "text", text: "hello" },
        ]);
        success(session);
      };
    };
    const runtime = createClaudeRuntime({ driver });
    const first = outcome(
      await collect(runtime.streamRound(request({ transcript: [user] }))),
    );
    expect(first.content).toEqual([{ type: "text", text: "hello" }]);
    expect(driver.opened[0].identity.history.messages).toEqual([]);
    expect(driver.opened[0].resume.mode).toBe("fresh");
    const nextUser: TranscriptMessage = {
      role: "user",
      content: [{ type: "text", text: "next" }],
    };
    const second = outcome(
      await collect(
        runtime.streamRound(
          request({
            roundId: "r2",
            transcript: [user, assistant(first.content), nextUser],
            input: { kind: "prompt", content: nextUser.content },
          }),
        ),
      ),
    );
    expect(second.reason).toBe("stop");
    expect(driver.opened).toHaveLength(1);
    expect(driver.sessions[0].prompts.map((prompt) => prompt.content)).toEqual([
      user.content,
      nextUser.content,
    ]);
    expect(driver.sessions[0].closeCount).toBe(0);
    await runtime.closeAll();
    expect(driver.sessions[0].closeCount).toBe(1);
  });

  it("replays prior labelled history while excluding an identical current user input", async () => {
    const driver = new OfflineDriver();
    driver.setup = (session) => {
      session.onPrompt = () => {
        step(session, "m", [{ type: "text", text: "continued" }]);
        success(session);
      };
    };
    const runtime = createClaudeRuntime({ driver });
    const image: TranscriptMessage = {
      role: "user",
      content: [{ type: "image", data: "base64", mimeType: "image/png" }],
    };
    const failed: TranscriptMessage = {
      role: "tool_result",
      ...toolResult("prior"),
      isError: true,
    };
    await collect(
      runtime.streamRound(
        request({
          transcript: [
            image,
            assistant([call("prior")], "toolUse"),
            failed,
            user,
          ],
        }),
      ),
    );
    expect(driver.opened[0].resume).toMatchObject({
      mode: "replay",
      restoration: "user-history-replay",
      replayTranscript: [image, assistant([call("prior")], "toolUse"), failed],
    });
    expect(driver.sessions[0].prompts[0].content).toEqual(user.content);
    expect(driver.opened[0].identity.claudeSessionId).toBe("claude-1");
    await runtime.closeAll();
  });

  it("waits for message completion and every real MCP park before exposing parallel host effects", async () => {
    const driver = new OfflineDriver(),
      runtime = createClaudeRuntime({ driver });
    let complete = false;
    const pending = collect(runtime.streamRound(request())).then((events) => {
      complete = true;
      return events;
    });
    const session = await started(driver);
    session.emit({ type: "message_start", messageId: "m", attribution: {} });
    session.emit({
      type: "assistant_snapshot",
      messageId: "m",
      content: [call("a"), call("b")],
      contentIndexes: [0, 1],
      attribution: {},
    });
    session.park(call("a"));
    session.park(call("b"));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(complete).toBe(false);
    session.emit({ type: "message_end", messageId: "m", attribution: {} });
    const first = outcome(await pending);
    expect(first.reason).toBe("toolUse");
    expect(first.pendingToolCallIds).toEqual(["a", "b"]);
    expect(session.pending.size).toBe(2);
    expect(session.closeCount).toBe(0);
    session.onResults = () => {
      step(session, "m2", [{ type: "text", text: "tool answers used" }]);
      success(session);
    };
    const a = toolResult("a"),
      b = toolResult("b");
    const second = outcome(
      await collect(
        runtime.streamRound(
          request({
            roundId: "r2",
            transcript: [
              user,
              assistant(first.content, "toolUse"),
              { role: "tool_result", ...a },
              { role: "tool_result", ...b },
            ],
            input: { kind: "tool-results", results: [b, a, a] },
          }),
        ),
      ),
    );
    expect(second.reason).toBe("stop");
    expect(driver.opened).toHaveLength(1);
    expect(session.results.map((result) => result.toolCallId)).toEqual([
      "b",
      "a",
    ]);
    await runtime.closeAll();
  });

  it("waits for the second proposed MCP call even after message_end", async () => {
    const driver = new OfflineDriver(),
      runtime = createClaudeRuntime({ driver });
    let complete = false;
    const pending = collect(runtime.streamRound(request())).then((events) => {
      complete = true;
      return events;
    });
    const session = await started(driver);
    step(session, "m", [call("a"), call("b")]);
    session.park(call("a"));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(complete).toBe(false);
    session.park(call("b"));
    expect(outcome(await pending).reason).toBe("toolUse");
    await runtime.closeAll();
    expect(session.cancellations.every((result) => result.isError)).toBe(true);
  });

  it("supports snapshot-only definitive host tool boundaries without closing partial block snapshots", async () => {
    const driver = new OfflineDriver(),
      runtime = createClaudeRuntime({ driver });
    let complete = false;
    const pending = collect(runtime.streamRound(request())).then((events) => {
      complete = true;
      return events;
    });
    const session = await started(driver);
    session.raw({
      type: "assistant",
      session_id: "claude-1",
      uuid: "partial",
      parent_tool_use_id: null,
      message: {
        id: "m",
        content: [
          {
            type: "tool_use",
            id: "a",
            name: "mcp__host__read",
            input: { path: "a" },
          },
        ],
        stop_reason: null,
      },
    });
    session.park(call("a"));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(complete).toBe(false);
    session.raw({
      type: "assistant",
      session_id: "claude-1",
      uuid: "full",
      parent_tool_use_id: null,
      message: {
        id: "m",
        content: [
          {
            type: "tool_use",
            id: "a",
            name: "mcp__host__read",
            input: { path: "a" },
          },
        ],
        stop_reason: "tool_use",
      },
    });
    const end = outcome(await pending);
    expect(end.reason).toBe("toolUse");
    expect(end.content).toEqual([call("a")]);
    await runtime.closeAll();
  });

  it("accounts two host tool rounds once when terminal token and cost reports are cumulative", async () => {
    const driver = new OfflineDriver(),
      runtime = createClaudeRuntime({ driver });
    const u = (inputTokens: number, outputTokens: number): Usage => ({
      inputTokens,
      outputTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    driver.setup = (session) => {
      session.onPrompt = () => {
        step(session, "m1", [call("a")], u(10, 2));
        session.park(call("a"));
      };
      session.onResults = (results) => {
        if (results[0].toolCallId === "a") {
          step(session, "m2", [call("b")], u(12, 3));
          session.park(call("b"));
        } else {
          step(session, "m3", [{ type: "text", text: "finished" }], u(5, 4));
          success(session, {
            ...u(27, 9),
            costUsd: 0.03,
            modelUsage: {
              model: { inputTokens: 27, outputTokens: 9, costUSD: 0.03 },
            },
          });
        }
      };
    };
    const one = outcome(await collect(runtime.streamRound(request())));
    const a = { role: "tool_result" as const, ...toolResult("a") };
    const history: TranscriptMessage[] = [
      user,
      assistant(one.content, "toolUse"),
      a,
    ];
    const two = outcome(
      await collect(
        runtime.streamRound(
          request({
            roundId: "r2",
            transcript: history,
            input: { kind: "tool-results", results: [a] },
          }),
        ),
      ),
    );
    const b = { role: "tool_result" as const, ...toolResult("b") };
    history.push(assistant(two.content, "toolUse"), b);
    const events = await collect(
      runtime.streamRound(
        request({
          roundId: "r3",
          transcript: history,
          input: { kind: "tool-results", results: [b] },
        }),
      ),
    );
    const three = outcome(events);
    expect([
      one.usage?.inputTokens,
      two.usage?.inputTokens,
      three.usage?.inputTokens,
    ]).toEqual([10, 12, 5]);
    expect([
      one.usage?.outputTokens,
      two.usage?.outputTokens,
      three.usage?.outputTokens,
    ]).toEqual([2, 3, 4]);
    expect(three.usage?.costUsd).toBe(0.03);
    expect(
      events.find(
        (event) =>
          event.type === "driver_event" && event.event.type === "turn_end",
      ),
    ).toMatchObject({
      event: {
        usage: { inputTokens: 27, modelUsage: { model: { inputTokens: 27 } } },
      },
    });
    expect(driver.opened).toHaveLength(1);
    expect(driver.sessions[0].prompts).toHaveLength(1);
    await runtime.closeAll();
  });

  it.each([
    "cwd",
    "model",
    "system",
    "tools",
    "auth",
    "settings",
    "branch",
    "revision",
    "foreign-history",
  ])(
    "rebuilds after %s divergence instead of guessing resume",
    async (change) => {
      const driver = new OfflineDriver();
      driver.setup = (session) => {
        session.onPrompt = () => {
          step(session, "m", [{ type: "text", text: "done" }]);
          success(session);
        };
      };
      const runtime = createClaudeRuntime({ driver });
      const first = outcome(await collect(runtime.streamRound(request())));
      const history: TranscriptMessage[] = [user, assistant(first.content)];
      const next = request({
        roundId: "r2",
        transcript: history,
        input: { kind: "prompt", content: [{ type: "text", text: "next" }] },
      });
      if (change === "cwd") next.cwd = "/other";
      if (change === "model") next.model = "different";
      if (change === "system") next.systemPrompt = "changed";
      if (change === "tools")
        next.tools = [
          {
            ...next.tools[0],
            inputSchema: { type: "object", required: ["path"] },
          },
        ];
      if (change === "auth")
        next.auth = { mode: "api-key", apiKey: "offline-placeholder" };
      if (change === "settings")
        next.settings = { ...next.settings, effort: "high" };
      if (change === "branch")
        next.session = { ...next.session, branchId: "branch" };
      if (change === "revision")
        next.session = { ...next.session, historyRevision: "compacted" };
      if (change === "foreign-history")
        next.transcript = [
          ...history,
          { role: "assistant", content: [{ type: "text", text: "foreign" }] },
        ];
      expect(outcome(await collect(runtime.streamRound(next))).reason).toBe(
        "stop",
      );
      expect(driver.opened).toHaveLength(2);
      expect(driver.opened[1].resume.mode).toBe("replay");
      expect(driver.opened[1].identity.claudeSessionId).toBe("claude-2");
      expect(driver.sessions[0].closeCount).toBe(1);
      await runtime.closeAll();
    },
  );

  it("keeps structurally equal schemas resident regardless of object key insertion order", async () => {
    const driver = new OfflineDriver();
    driver.setup = (session) => {
      session.onPrompt = () => {
        step(session, `m${session.prompts.length}`, [
          { type: "text", text: "done" },
        ]);
        success(session);
      };
    };
    const runtime = createClaudeRuntime({ driver });
    const firstRequest = request();
    firstRequest.tools = [
      {
        ...firstRequest.tools[0],
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
        },
      },
    ];
    const first = outcome(await collect(runtime.streamRound(firstRequest)));
    const next = request({
      roundId: "r2",
      transcript: [user, assistant(first.content)],
    });
    next.tools = [
      {
        ...next.tools[0],
        inputSchema: {
          properties: { path: { type: "string" } },
          type: "object",
        },
      },
    ];
    await collect(runtime.streamRound(next));
    expect(driver.opened).toHaveLength(1);
    await runtime.closeAll();
  });

  it.each([
    "compaction",
    "tree",
    "branch",
    "fork",
    "import",
    "abort",
    "reset",
    "reload",
  ] as const)(
    "invalidates %s history and closes the owned query",
    async (reason) => {
      const driver = new OfflineDriver();
      driver.setup = (session) => {
        session.onPrompt = () => {
          step(session, "m", [{ type: "text", text: "done" }]);
          success(session);
        };
      };
      const runtime = createClaudeRuntime({ driver });
      const first = outcome(await collect(runtime.streamRound(request())));
      await runtime.invalidate(request().session, reason);
      await collect(
        runtime.streamRound(
          request({
            roundId: "r2",
            transcript: [user, assistant(first.content)],
          }),
        ),
      );
      expect(driver.opened[1].resume).toMatchObject({
        mode: "replay",
        reason: `history invalidated: ${reason}`,
      });
      expect(driver.sessions[0].closeCount).toBe(1);
      await runtime.closeAll();
    },
  );

  it.each(["abort-first", "result-first", "eof-first"])(
    "emits exactly one immutable terminal in the %s race",
    async (order) => {
      const driver = new OfflineDriver(),
        runtime = createClaudeRuntime({ driver }),
        controller = new AbortController();
      const pending = collect(
        runtime.streamRound(request({ signal: controller.signal })),
      );
      const session = await started(driver);
      step(session, "m", [{ type: "text", text: "before" }]);
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (order === "abort-first") {
        controller.abort();
        success(session);
        session.end();
      }
      if (order === "result-first") {
        success(session);
        await new Promise((resolve) => setTimeout(resolve, 0));
        controller.abort();
        session.end();
      }
      if (order === "eof-first") {
        session.end();
        await new Promise((resolve) => setTimeout(resolve, 0));
        controller.abort();
      }
      const end = outcome(await pending);
      expect(end.reason).toBe(
        order === "result-first"
          ? "stop"
          : order === "abort-first"
            ? "aborted"
            : "error",
      );
      expect(end.content).toEqual([{ type: "text", text: "before" }]);
      session.emit({
        type: "content_delta",
        messageId: "m",
        index: 0,
        delta: { kind: "text", text: "late" },
        attribution: {},
      });
      expect(end.content).toEqual([{ type: "text", text: "before" }]);
      await runtime.closeAll();
    },
  );

  it("settles parked calls as errors when shutdown races an active result round", async () => {
    const driver = new OfflineDriver(),
      runtime = createClaudeRuntime({ driver });
    const pending = collect(runtime.streamRound(request()));
    const session = await started(driver);
    step(session, "m", [call("a"), call("b")]);
    session.park(call("a"));
    session.park(call("b"));
    const first = outcome(await pending);
    const next = collect(
      runtime.streamRound(
        request({
          roundId: "r2",
          transcript: [user, assistant(first.content, "toolUse")],
          input: { kind: "tool-results", results: [] },
        }),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.all([runtime.close("host"), runtime.close("host")]);
    expect(outcome(await next).reason).toBe("aborted");
    expect(
      session.cancellations.map((result) => [
        result.toolCallId,
        result.isError,
      ]),
    ).toEqual([
      ["a", true],
      ["b", true],
    ]);
    expect(session.closeCount).toBe(1);
    await runtime.closeAll();
  });

  it("reports bounded failure for a missing parked result", async () => {
    const driver = new OfflineDriver(),
      runtime = createClaudeRuntime({ driver });
    const pending = collect(
      runtime.streamRound(
        request({
          settings: { ...request().settings, toolResultTimeoutMs: 25 },
        }),
      ),
    );
    const session = await started(driver);
    step(session, "m", [call("a")]);
    session.park(call("a"));
    const first = outcome(await pending);
    const next = collect(
      runtime.streamRound(
        request({
          roundId: "r2",
          settings: { ...request().settings, toolResultTimeoutMs: 25 },
          transcript: [user, assistant(first.content, "toolUse")],
          input: { kind: "tool-results", results: [] },
        }),
      ),
    );
    const end = outcome(await next);
    expect(end.reason).toBe("error");
    expect(end.error?.code).toBe("timeout");
    expect(session.cancellations[0].isError).toBe(true);
    await runtime.closeAll();
  });

  it("rejects unknown IDs and conflicting result duplicates without replaying effects", async () => {
    const driver = new OfflineDriver(),
      runtime = createClaudeRuntime({ driver });
    const pending = collect(runtime.streamRound(request()));
    const session = await started(driver);
    step(session, "m", [call("a")]);
    session.park(call("a"));
    const first = outcome(await pending);
    const base = request({
      roundId: "r2",
      transcript: [user, assistant(first.content, "toolUse")],
      input: { kind: "tool-results", results: [toolResult("unknown")] },
    });
    expect(outcome(await collect(runtime.streamRound(base))).error?.code).toBe(
      "tool-correlation",
    );
    base.input = {
      kind: "tool-results",
      results: [toolResult("a"), { ...toolResult("a"), isError: true }],
    };
    expect(outcome(await collect(runtime.streamRound(base))).error?.code).toBe(
      "tool-correlation",
    );
    expect(driver.opened).toHaveLength(1);
    expect(session.results).toEqual([]);
    await runtime.closeAll();
  });

  it("isolates concurrent host sessions and rejects a second subscription to the same session", async () => {
    const driver = new OfflineDriver(),
      runtime = createClaudeRuntime({ driver });
    const a = collect(runtime.streamRound(request()));
    const first = await started(driver);
    const conflicting = outcome(
      await collect(runtime.streamRound(request({ roundId: "conflict" }))),
    );
    expect(conflicting.reason).toBe("error");
    expect(driver.opened).toHaveLength(1);
    const b = collect(
      runtime.streamRound(
        request({
          roundId: "other",
          session: {
            sessionId: "other",
            branchId: "root",
            historyRevision: "0",
          },
          cwd: "/other",
        }),
      ),
    );
    const second = await started(driver, 1);
    step(first, "m", [call("a")]);
    first.park(call("a"));
    step(second, "m", [{ type: "text", text: "independent" }]);
    success(second);
    expect(outcome(await a).pendingToolCallIds).toEqual(["a"]);
    expect(outcome(await b).content).toEqual([
      { type: "text", text: "independent" },
    ]);
    await runtime.close("host");
    expect(second.closeCount).toBe(0);
    await runtime.closeAll();
  });

  it("cleans a cancelled subscriber without leaving its pump or parked handlers alive", async () => {
    const driver = new OfflineDriver(),
      runtime = createClaudeRuntime({ driver });
    const iterator = runtime.streamRound(request())[Symbol.asyncIterator]();
    const init = await iterator.next();
    expect(init.value?.type).toBe("driver_event");
    await iterator.return?.();
    await vi.waitFor(() => expect(driver.sessions[0].closeCount).toBe(1));
    expect(driver.sessions[0].interruptCount).toBeGreaterThan(0);
    await runtime.closeAll();
  });

  it("allows only effective host, explicit native and configured user MCP tools, declining unsupported interactions", async () => {
    const driver = new OfflineDriver(),
      runtime = createClaudeRuntime({ driver });
    const pending = collect(
      runtime.streamRound(
        request({
          settings: {
            ...request().settings,
            claudeTools: ["Read"],
            userMcpServers: [
              {
                name: "external",
                config: { type: "http", url: "https://example.invalid" },
              },
            ],
          },
        }),
      ),
    );
    const session = await started(driver);
    for (const toolName of [
      "mcp__host__read",
      "Read",
      "mcp__external__lookup",
      "mcp__host__inactive",
      "Bash",
    ])
      session.emit({
        type: "interaction_request",
        request: {
          kind: "permission",
          requestId: toolName,
          toolUseId: `id-${toolName}`,
          toolName,
          input: { path: "file" },
        },
        attribution: {},
      });
    session.emit({
      type: "interaction_request",
      request: {
        kind: "elicitation",
        requestId: "ask",
        serverName: "external",
        message: "question",
      },
      attribution: {},
    });
    session.emit({
      type: "interaction_request",
      request: {
        kind: "dialog",
        requestId: "dialog",
        dialogKind: "unknown",
        payload: {},
      },
      attribution: {},
    });
    await vi.waitFor(() => expect(session.responses).toHaveLength(7));
    expect(session.responses.slice(0, 3)).toMatchObject([
      { decision: { behavior: "allow", updatedInput: { path: "file" } } },
      { decision: { behavior: "allow" } },
      { decision: { behavior: "allow" } },
    ]);
    expect(session.responses.slice(3, 5)).toMatchObject([
      { decision: { behavior: "deny" } },
      { decision: { behavior: "deny" } },
    ]);
    expect(session.responses[5]).toMatchObject({
      decision: { action: "decline" },
    });
    expect(session.responses[6]).toMatchObject({ kind: "unsupported" });
    success(session);
    expect(outcome(await pending).reason).toBe("stop");
    await runtime.closeAll();
  });

  it("rejects malformed interaction IDs before approving any permission", async () => {
    const driver = new OfflineDriver(),
      runtime = createClaudeRuntime({ driver });
    const pending = collect(runtime.streamRound(request()));
    const session = await started(driver);
    session.emit({
      type: "interaction_request",
      request: {
        kind: "permission",
        requestId: "",
        toolUseId: "",
        toolName: "mcp__host__read",
        input: {},
      },
      attribution: {},
    });
    expect(outcome(await pending).error?.code).toBe("tool-correlation");
    expect(session.responses).toEqual([]);
    await runtime.closeAll();
  });

  it("never merges child content or child host calls into the parent assistant", async () => {
    const driver = new OfflineDriver(),
      runtime = createClaudeRuntime({ driver });
    const pending = collect(runtime.streamRound(request()));
    const session = await started(driver);
    session.emit({
      type: "assistant_snapshot",
      messageId: "child",
      content: [{ type: "text", text: "child" }, call("child")],
      attribution: { parentToolUseId: "task", agentId: "agent" },
    });
    session.park(call("child"), { parentToolUseId: "task", agentId: "agent" });
    session.emit({
      type: "turn_end",
      status: "success",
      subtype: "success",
      isError: false,
      attribution: { parentToolUseId: "task" },
    });
    step(session, "main", [{ type: "text", text: "parent" }]);
    success(session);
    const events = await pending;
    expect(outcome(events).content).toEqual([{ type: "text", text: "parent" }]);
    expect(session.results[0]).toMatchObject({
      toolCallId: "child",
      isError: true,
    });
    expect(
      events.some(
        (event) =>
          event.type === "driver_event" &&
          event.event.attribution.parentToolUseId,
      ),
    ).toBe(false);
    await runtime.closeAll();
  });
  it("subtracts earlier tool-round usage when the final result is the only final accounting frame", async () => {
    const driver = new OfflineDriver(),
      runtime = createClaudeRuntime({ driver });
    driver.setup = (session) => {
      session.onPrompt = () => {
        step(session, "m1", [call("a")], {
          inputTokens: 10,
          outputTokens: 2,
          cacheReadTokens: 3,
          cacheWriteTokens: 1,
        });
        session.park(call("a"));
      };
      session.onResults = () =>
        success(session, {
          inputTokens: 15,
          outputTokens: 7,
          cacheReadTokens: 5,
          cacheWriteTokens: 1,
          costUsd: 0.02,
        });
    };
    const one = outcome(await collect(runtime.streamRound(request())));
    const a = toolResult("a");
    const two = outcome(
      await collect(
        runtime.streamRound(
          request({
            roundId: "r2",
            transcript: [
              user,
              assistant(one.content, "toolUse"),
              { role: "tool_result", ...a },
            ],
            input: { kind: "tool-results", results: [a] },
          }),
        ),
      ),
    );
    expect(two.usage).toEqual({
      inputTokens: 5,
      outputTokens: 5,
      cacheReadTokens: 2,
      cacheWriteTokens: 0,
      costUsd: 0.02,
    });
    await runtime.closeAll();
  });

  it("reports only new cost on a second resident user turn", async () => {
    const driver = new OfflineDriver(),
      runtime = createClaudeRuntime({ driver });
    driver.setup = (session) => {
      session.onPrompt = () => {
        step(session, `m${session.prompts.length}`, [
          { type: "text", text: "done" },
        ]);
        success(session, {
          inputTokens: 5,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: session.prompts.length === 1 ? 0.01 : 0.03,
        });
      };
    };
    const one = outcome(await collect(runtime.streamRound(request())));
    const two = outcome(
      await collect(
        runtime.streamRound(
          request({
            roundId: "r2",
            transcript: [user, assistant(one.content)],
          }),
        ),
      ),
    );
    expect(one.usage?.costUsd).toBe(0.01);
    expect(two.usage?.costUsd).toBeCloseTo(0.02);
    expect(driver.opened).toHaveLength(1);
    await runtime.closeAll();
  });

  it("bounds a proposal that never reaches a parked MCP handler", async () => {
    const driver = new OfflineDriver(),
      runtime = createClaudeRuntime({ driver });
    const pending = collect(
      runtime.streamRound(
        request({
          settings: { ...request().settings, toolResultTimeoutMs: 20 },
        }),
      ),
    );
    const session = await started(driver);
    step(session, "m", [call("a")]);
    const end = outcome(await pending);
    expect(end.reason).toBe("error");
    expect(end.error?.code).toBe("timeout");
    expect(end.error?.message).toContain("parked MCP handlers");
    await runtime.closeAll();
  });

  it("keeps permission decisions single even when requests arrive between host rounds", async () => {
    const driver = new OfflineDriver(),
      runtime = createClaudeRuntime({ driver });
    const pending = collect(runtime.streamRound(request()));
    const session = await started(driver);
    step(session, "m", [call("a")]);
    session.park(call("a"));
    const one = outcome(await pending);
    session.emit({
      type: "interaction_request",
      request: {
        kind: "permission",
        requestId: "permission",
        toolUseId: "native",
        toolName: "mcp__host__read",
        input: { path: "file" },
      },
      attribution: {},
    });
    await vi.waitFor(() => expect(session.responses).toHaveLength(1));
    session.onResults = () => {
      step(session, "next", [{ type: "text", text: "done" }]);
      success(session);
    };
    const a = toolResult("a");
    await collect(
      runtime.streamRound(
        request({
          roundId: "r2",
          transcript: [
            user,
            assistant(one.content, "toolUse"),
            { role: "tool_result", ...a },
          ],
          input: { kind: "tool-results", results: [a] },
        }),
      ),
    );
    expect(session.responses).toHaveLength(1);
    await runtime.closeAll();
  });

  it("returns the winning terminal even when submit rejects after emitting a result", async () => {
    const driver = new OfflineDriver(),
      runtime = createClaudeRuntime({ driver });
    driver.setup = (session) => {
      session.submitPrompt = async (prompt) => {
        session.prompts.push(prompt);
        step(session, "m", [{ type: "text", text: "done" }]);
        success(session);
        await new Promise((resolve) => setTimeout(resolve, 5));
        throw new Error("late write rejection");
      };
    };
    expect(outcome(await collect(runtime.streamRound(request()))).reason).toBe(
      "stop",
    );
    await runtime.closeAll();
  });

  it("allows abort to settle the host while a transport write is still awaiting acceptance", async () => {
    const driver = new OfflineDriver(),
      runtime = createClaudeRuntime({ driver }),
      controller = new AbortController();
    driver.setup = (session) => {
      session.submitPrompt = (prompt) => {
        session.prompts.push(prompt);
        return new Promise<void>(() => {});
      };
    };
    const pending = collect(
      runtime.streamRound(request({ signal: controller.signal })),
    );
    const session = await started(driver);
    controller.abort();
    expect(outcome(await pending).reason).toBe("aborted");
    await runtime.closeAll();
    expect(session.closeCount).toBe(1);
  });

  it("rejects an authoritative initialized ID that changes within a resident query", async () => {
    const driver = new OfflineDriver(),
      runtime = createClaudeRuntime({ driver });
    const pending = collect(runtime.streamRound(request()));
    const session = await started(driver);
    session.emit({
      type: "initialized",
      claudeSessionId: "foreign",
      model: "model",
      runtimeVersion: "2.1.285",
      capabilities: [],
      tools: [],
      mcpServers: [],
      attribution: {},
    });
    expect(outcome(await pending).error?.code).toBe("history");
    await runtime.closeAll();
  });

  it("reports EOF between parked rounds without reopening and replaying already proposed effects", async () => {
    const driver = new OfflineDriver(),
      runtime = createClaudeRuntime({ driver });
    const pending = collect(runtime.streamRound(request()));
    const session = await started(driver);
    step(session, "m", [call("a")]);
    session.park(call("a"));
    const one = outcome(await pending);
    session.end();
    await vi.waitFor(() => expect(session.closeCount).toBe(1));
    const a = toolResult("a");
    const end = outcome(
      await collect(
        runtime.streamRound(
          request({
            roundId: "r2",
            transcript: [
              user,
              assistant(one.content, "toolUse"),
              { role: "tool_result", ...a },
            ],
            input: { kind: "tool-results", results: [a] },
          }),
        ),
      ),
    );
    expect(end.error?.code).toBe("transport");
    expect(driver.opened).toHaveLength(1);
    await runtime.closeAll();
  });

  it("marks successful max_tokens completion as length", async () => {
    const driver = new OfflineDriver(),
      runtime = createClaudeRuntime({ driver });
    const pending = collect(runtime.streamRound(request()));
    const session = await started(driver);
    session.emit({
      type: "assistant_snapshot",
      messageId: "m",
      content: [{ type: "text", text: "truncated" }],
      attribution: {},
    });
    session.emit({
      type: "message_end",
      messageId: "m",
      stopReason: "max_tokens",
      attribution: {},
    });
    success(session);
    expect(outcome(await pending).reason).toBe("length");
    await runtime.closeAll();
  });
  it("doesn't project delayed snapshots or deltas from a completed tool round into its continuation", async () => {
    const driver = new OfflineDriver(),
      runtime = createClaudeRuntime({ driver });
    const pending = collect(runtime.streamRound(request()));
    const session = await started(driver);
    step(session, "old", [call("a")]);
    session.park(call("a"));
    const one = outcome(await pending);
    session.emit({
      type: "assistant_snapshot",
      messageId: "old",
      snapshotId: "late",
      content: [call("a")],
      contentIndexes: [0],
      attribution: {},
    });
    session.emit({
      type: "content_delta",
      messageId: "old",
      index: 0,
      delta: { kind: "tool-input", partialJson: "{}" },
      attribution: {},
    });
    session.emit({ type: "message_end", messageId: "old", attribution: {} });
    session.onResults = () => {
      step(session, "new", [call("b")]);
      session.park(call("b"));
    };
    const a = toolResult("a");
    const second = outcome(
      await collect(
        runtime.streamRound(
          request({
            roundId: "r2",
            transcript: [
              user,
              assistant(one.content, "toolUse"),
              { role: "tool_result", ...a },
            ],
            input: { kind: "tool-results", results: [a] },
          }),
        ),
      ),
    );
    expect(second.reason).toBe("toolUse");
    expect(second.content).toEqual([call("b")]);
    expect(second.pendingToolCallIds).toEqual(["b"]);
    expect(driver.opened).toHaveLength(1);
    await runtime.closeAll();
  });

  it("preserves a cost-only final usage report after earlier tool-round accounting", async () => {
    const driver = new OfflineDriver(),
      runtime = createClaudeRuntime({ driver });
    driver.setup = (session) => {
      session.onPrompt = () => {
        step(session, "m", [call("a")], {
          inputTokens: 10,
          outputTokens: 2,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        });
        session.park(call("a"));
      };
      session.onResults = () =>
        success(session, {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: 0.01,
        });
    };
    const one = outcome(await collect(runtime.streamRound(request())));
    const a = toolResult("a");
    const two = outcome(
      await collect(
        runtime.streamRound(
          request({
            roundId: "r2",
            transcript: [
              user,
              assistant(one.content, "toolUse"),
              { role: "tool_result", ...a },
            ],
            input: { kind: "tool-results", results: [a] },
          }),
        ),
      ),
    );
    expect(two.reason).toBe("stop");
    expect(two.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.01,
    });
    await runtime.closeAll();
  });
  it("reconciles a snapshot that supersedes an earlier frame of the same assistant message", async () => {
    const driver = new OfflineDriver(),
      runtime = createClaudeRuntime({ driver });
    const pending = collect(runtime.streamRound(request()));
    const session = await started(driver);
    session.emit({
      type: "assistant_snapshot",
      messageId: "m",
      snapshotId: "old",
      content: [{ type: "text", text: "retracted" }],
      contentIndexes: [0],
      attribution: {},
    });
    session.emit({
      type: "assistant_snapshot",
      messageId: "m",
      snapshotId: "new",
      content: [{ type: "text", text: "canonical" }],
      contentIndexes: [0],
      supersedes: ["old"],
      attribution: {},
    });
    session.emit({ type: "message_end", messageId: "m", attribution: {} });
    success(session);
    expect(outcome(await pending).content).toEqual([
      { type: "text", text: "canonical" },
    ]);
    await runtime.closeAll();
  });
});
