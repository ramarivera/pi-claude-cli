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
  PromptMessage,
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
  private streamError?: unknown;
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
      if (this.streamError) throw this.streamError;
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
  fail(cause: unknown): void {
    this.streamError = cause;
    this.notify?.();
    this.notify = undefined;
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
  it("exposes the unended message blocking a parked handoff without assistant text or arguments", async () => {
    const driver = new OfflineDriver(),
      runtime = createClaudeRuntime({ driver });
    try {
      const first = collect(runtime.streamRound(request()));
      const session = await started(driver);
      step(session, "previous", [call("a")]);
      session.park(call("a"));
      const one = outcome(await first),
        a = toolResult("a");
      const second = collect(
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
      await vi.waitFor(() => expect(session.results).toEqual([a]));
      session.emit({
        type: "assistant_snapshot",
        messageId: "current",
        content: [
          { type: "text", text: "private assistant text" },
          { ...call("b"), arguments: { path: "private path" } },
        ],
        attribution: {},
      });
      session.park({ ...call("b"), arguments: { path: "private path" } });
      const original: UnsequencedClaudeDriverEvent = {
        type: "observation",
        family: "diagnostic",
        subtype: "host-mcp-park",
        data: { toolCallId: "b" },
        attribution: {},
      };
      session.emit(original);
      session.emit({
        type: "message_end",
        messageId: "current",
        attribution: {},
      });
      const events = await second;
      const trace = events.find(
        (event) =>
          event.type === "driver_event" &&
          event.event.type === "observation" &&
          event.event.subtype === "host-mcp-park",
      );
      expect(trace).toMatchObject({
        type: "driver_event",
        event: {
          data: {
            toolCallId: "b",
            runtimeBoundary: {
              roundDone: false,
              messageCount: 1,
              messages: [
                {
                  messageId: "current",
                  ended: false,
                  blockCount: 2,
                  toolCallIds: ["b"],
                },
              ],
              unendedMessageIds: ["current"],
              proposalCount: 1,
              proposalIds: ["b"],
              unparkedProposalIds: [],
              parkedCount: 1,
              parkedIds: ["b"],
              deliveredCount: 1,
              deliveredIds: ["a"],
            },
          },
        },
      });
      expect(JSON.stringify(trace)).not.toContain("private");
      expect(original).toMatchObject({ data: { toolCallId: "b" } });
      expect(
        original.type === "observation" && original.data,
      ).not.toHaveProperty("runtimeBoundary");
      expect(outcome(events).reason).toBe("toolUse");
    } finally {
      await runtime.closeAll();
    }
  });

  it.each([false, true])(
    "rejects unsupported steering before replay when a parked session exists: %s",
    async (parked) => {
      const scripted = new OfflineDriver();
      const driver: ClaudeDriver = {
        kind: scripted.kind,
        capabilities: { ...scripted.capabilities, steering: "unsupported" },
        openSession: (r) => scripted.openSession(r),
      };
      const runtime = createClaudeRuntime({ driver });
      scripted.setup = (session) => {
        session.onPrompt = () => {
          step(session, "tools", [call("a"), call("b")]);
          session.park(call("a"));
          session.park(call("b"));
        };
      };
      if (parked) {
        expect(
          outcome(await collect(runtime.streamRound(request()))).reason,
        ).toBe("toolUse");
      }
      const steering: TranscriptMessage = {
        role: "user",
        content: [{ type: "text", text: "change direction" }],
      };
      const result = outcome(
        await collect(
          runtime.streamRound(
            request({
              roundId: "steer",
              transcript: [
                user,
                assistant([call("a"), call("b")], "toolUse"),
                { role: "tool_result", ...toolResult("b") },
                steering,
                { role: "tool_result", ...toolResult("a") },
              ],
              input: {
                kind: "tool-results",
                results: [toolResult("b"), toolResult("a")],
                steering: steering.content,
              },
            }),
          ),
        ),
      );
      expect(result).toMatchObject({
        reason: "error",
        error: {
          code: "unsupported",
          message: "Selected driver doesn't support steering",
        },
      });
      expect(scripted.opened).toHaveLength(parked ? 1 : 0);
      if (parked) {
        expect(scripted.sessions[0].prompts).toHaveLength(1);
        expect(scripted.sessions[0].results).toHaveLength(0);
        expect(scripted.sessions[0].closeCount).toBe(1);
      }
      await runtime.closeAll();
    },
  );
  it.each([false, true])(
    "submits a current user once and keeps a resident pump when the host retains empty streamed text: %s",
    async (elideEmpty) => {
      const driver = new OfflineDriver();
      driver.setup = (session) => {
        session.onPrompt = () => {
          step(session, `m${session.prompts.length}`, [
            ...(elideEmpty ? [{ type: "text" as const, text: "" }] : []),
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
              transcript: [
                user,
                assistant([
                  ...(elideEmpty ? [{ type: "text" as const, text: "" }] : []),
                  ...first.content,
                ]),
                nextUser,
              ],
              input: { kind: "prompt", content: nextUser.content },
            }),
          ),
        ),
      );
      expect(second.reason).toBe("stop");
      expect(driver.opened).toHaveLength(1);
      expect(
        driver.sessions[0].prompts.map((prompt) => prompt.content),
      ).toEqual([user.content, nextUser.content]);
      expect(driver.sessions[0].closeCount).toBe(0);
      await runtime.closeAll();
      expect(driver.sessions[0].closeCount).toBe(1);
    },
  );

  it.each([false, true])(
    "keeps a developer background wake and its image split resident: %s",
    async (withImage) => {
      const driver = new OfflineDriver();
      driver.setup = (session) => {
        session.onPrompt = () => {
          step(session, `reply-${session.prompts.length}`, [
            { type: "text", text: `reply ${session.prompts.length}` },
          ]);
          success(session);
        };
      };
      const runtime = createClaudeRuntime({ driver });
      try {
        const first = outcome(
          await collect(runtime.streamRound(request({ transcript: [user] }))),
        );
        const wake: PromptMessage[] = [
          {
            role: "developer" as const,
            content: [{ type: "text" as const, text: "Research completed" }],
          },
          ...(withImage
            ? [
                {
                  role: "user" as const,
                  content: [
                    {
                      type: "text" as const,
                      text: "Images attached to async-result.",
                    },
                    {
                      type: "image" as const,
                      data: "aW1hZ2U=",
                      mimeType: "image/png",
                    },
                  ],
                },
              ]
            : []),
        ];
        const history = [user, assistant(first.content), ...wake];
        const second = outcome(
          await collect(
            runtime.streamRound(
              request({
                roundId: "background",
                transcript: history,
                input: {
                  kind: "prompt",
                  content: wake.flatMap((message) => message.content),
                  messages: wake,
                },
              }),
            ),
          ),
        );
        const followup = {
          role: "user" as const,
          content: [
            { type: "text" as const, text: "What did the research find?" },
          ],
        };
        const third = outcome(
          await collect(
            runtime.streamRound(
              request({
                roundId: "followup",
                transcript: [...history, assistant(second.content), followup],
                input: { kind: "prompt", content: followup.content },
              }),
            ),
          ),
        );
        expect(third.reason).toBe("stop");
        expect(driver.opened).toHaveLength(1);
        expect(
          driver.sessions[0].prompts.map((prompt) => prompt.content),
        ).toEqual([
          user.content,
          wake.flatMap((message) => message.content),
          followup.content,
        ]);
        expect(driver.sessions[0].closeCount).toBe(0);
      } finally {
        await runtime.closeAll();
      }
    },
  );

  it.each([false, true])(
    "preserves a background notification beside a real parked tool result, notification first: %s",
    async (noticeFirst) => {
      const driver = new OfflineDriver();
      const runtime = createClaudeRuntime({ driver });
      try {
        const first = collect(
          runtime.streamRound(request({ transcript: [user] })),
        );
        const session = await started(driver);
        step(session, "tool", [call("read-id")]);
        session.park(call("read-id"));
        const one = outcome(await first);
        const result = toolResult("read-id");
        const notice = {
          role: "developer" as const,
          content: [
            { type: "text" as const, text: "NuBreakingResearch completed" },
          ],
        };
        const resultMessage: TranscriptMessage = {
          role: "tool_result",
          ...result,
        };
        const history: TranscriptMessage[] = [
          user,
          assistant(one.content, "toolUse"),
          ...(noticeFirst ? [notice, resultMessage] : [resultMessage, notice]),
        ];
        session.onResults = () => {
          step(session, "after-tools", [
            { type: "text", text: "Research and read complete" },
          ]);
          success(session);
        };
        const two = outcome(
          await collect(
            runtime.streamRound(
              request({
                roundId: "result-and-notice",
                transcript: history,
                input: {
                  kind: "tool-results",
                  results: [result],
                  steering: notice.content,
                  steeringMessages: [notice],
                },
              }),
            ),
          ),
        );
        session.onPrompt = () => {
          step(session, "followup", [{ type: "text", text: "Remembered" }]);
          success(session);
        };
        const next = {
          role: "user" as const,
          content: [{ type: "text" as const, text: "Remember it" }],
        };
        const three = outcome(
          await collect(
            runtime.streamRound(
              request({
                roundId: "followup",
                transcript: [...history, assistant(two.content), next],
                input: { kind: "prompt", content: next.content },
              }),
            ),
          ),
        );
        expect(three.reason).toBe("stop");
        expect(driver.opened).toHaveLength(1);
        expect(session.results).toEqual([result]);
        expect(session.prompts.map((prompt) => prompt.content)).toEqual([
          user.content,
          notice.content,
          next.content,
        ]);
        expect(session.prompts[1]).toMatchObject({
          priority: "next",
          steering: "tool-boundary",
        });
      } finally {
        await runtime.closeAll();
      }
    },
  );

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

  it("waits for message completion before exposing already parked parallel host effects", async () => {
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

  it("releases a completed native batch after its first matched MCP call parks", async () => {
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
    expect(complete).toBe(true);
    expect(outcome(await pending).pendingToolCallIds).toEqual(["a", "b"]);
    session.park(call("b"));
    expect(outcome(await pending).reason).toBe("toolUse");
    await runtime.closeAll();
    expect(session.cancellations.every((result) => result.isError)).toBe(true);
  });

  it("buffers reverse ordered native results until serialized MCP dispatch matches each complete call", async () => {
    const driver = new OfflineDriver(),
      runtime = createClaudeRuntime({ driver });
    try {
      const pending = collect(runtime.streamRound(request()));
      const session = await started(driver);
      const content: AssistantContent[] = [
        { type: "thinking", thinking: "plan" },
        call("a"),
        call("b"),
      ];
      step(session, "batch", content, {
        inputTokens: 10,
        outputTokens: 2,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      });
      session.park(call("a"));
      const one = outcome(await pending),
        a = toolResult("a"),
        b = toolResult("b");
      expect(one.content).toEqual(content);
      expect(one.pendingToolCallIds).toEqual(["a", "b"]);
      session.onResults = (results) => {
        if (results[0].toolCallId === "a") session.park(call("b"));
        else {
          step(session, "final", [{ type: "text", text: "done" }]);
          success(session, {
            inputTokens: 20,
            outputTokens: 5,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          });
        }
      };
      const history: TranscriptMessage[] = [
        user,
        assistant(one.content, "toolUse"),
        { role: "tool_result", ...b },
        { role: "tool_result", ...a },
      ];
      const events = await collect(
        runtime.streamRound(
          request({
            roundId: "r2",
            transcript: history,
            input: { kind: "tool-results", results: [b, a, b] },
          }),
        ),
      );
      const two = outcome(events);
      expect(two).toMatchObject({
        reason: "stop",
        content: [{ type: "text", text: "done" }],
        usage: { inputTokens: 10, outputTokens: 3 },
      });
      expect(session.results.map((result) => result.toolCallId)).toEqual([
        "a",
        "b",
      ]);
      expect(
        events.filter(
          (event) =>
            event.type === "driver_event" &&
            event.event.type === "host_tool_request",
        ),
      ).toEqual([]);
      const nextUser: TranscriptMessage = {
        role: "user",
        content: [{ type: "text", text: "next" }],
      };
      session.onPrompt = () => {
        step(session, "new-turn", [{ type: "text", text: "next done" }]);
        success(session);
      };
      const three = outcome(
        await collect(
          runtime.streamRound(
            request({
              roundId: "r3",
              transcript: [...history, assistant(two.content), nextUser],
              input: { kind: "prompt", content: nextUser.content },
            }),
          ),
        ),
      );
      expect(three.reason).toBe("stop");
      expect(driver.opened).toHaveLength(1);
      expect(session.prompts).toHaveLength(2);
    } finally {
      await runtime.closeAll();
    }
  });

  it("attests a released call arriving before result subscription without projecting it again", async () => {
    vi.useFakeTimers();
    const driver = new OfflineDriver(),
      runtime = createClaudeRuntime({ driver });
    try {
      const first = collect(runtime.streamRound(request()));
      await vi.advanceTimersByTimeAsync(0);
      const session = driver.sessions[0];
      step(session, "batch", [call("a"), call("b")]);
      session.park(call("a"));
      await vi.advanceTimersByTimeAsync(0);
      const one = outcome(await first);
      session.park(call("b"));
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(2);
      const a = toolResult("a"),
        b = toolResult("b");
      session.onResults = () => {
        step(session, "final", [{ type: "text", text: "done" }]);
        success(session);
      };
      const next = collect(
        runtime.streamRound(
          request({
            roundId: "r2",
            transcript: [
              user,
              assistant(one.content, "toolUse"),
              { role: "tool_result", ...a },
              { role: "tool_result", ...b },
            ],
            input: { kind: "tool-results", results: [b, a] },
          }),
        ),
      );
      await vi.advanceTimersByTimeAsync(0);
      const events = await next;
      expect(outcome(events).content).toEqual([{ type: "text", text: "done" }]);
      expect(
        events.filter(
          (event) =>
            event.type === "driver_event" &&
            event.event.type === "host_tool_request",
        ),
      ).toEqual([]);
      expect(session.results.map((result) => result.toolCallId)).toEqual([
        "b",
        "a",
      ]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await runtime.closeAll();
      vi.useRealTimers();
    }
  });

  it("accepts a new actual MCP request before its stream header after an earlier batch settles", async () => {
    const driver = new OfflineDriver(),
      runtime = createClaudeRuntime({ driver });
    try {
      const first = collect(runtime.streamRound(request()));
      const session = await started(driver);
      step(session, "first", [call("a")]);
      session.park(call("a"));
      const one = outcome(await first),
        a = toolResult("a"),
        b = toolResult("b");
      session.onResults = () => {
        session.park(call("b"));
        step(session, "second", [call("b")]);
      };
      const history: TranscriptMessage[] = [
        user,
        assistant(one.content, "toolUse"),
        { role: "tool_result", ...a },
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
      expect(two).toMatchObject({
        reason: "toolUse",
        content: [call("b")],
        pendingToolCallIds: ["b"],
      });
      expect(session.results.map((result) => result.toolCallId)).toEqual(["a"]);
      session.onResults = () => {
        step(session, "final", [{ type: "text", text: "done" }]);
        success(session);
      };
      const three = outcome(
        await collect(
          runtime.streamRound(
            request({
              roundId: "r3",
              transcript: [
                ...history,
                assistant(two.content, "toolUse"),
                { role: "tool_result", ...b },
              ],
              input: { kind: "tool-results", results: [b] },
            }),
          ),
        ),
      );
      expect(three).toMatchObject({
        reason: "stop",
        content: [{ type: "text", text: "done" }],
      });
      expect(session.results.map((result) => result.toolCallId)).toEqual([
        "a",
        "b",
      ]);
      expect(driver.opened).toHaveLength(1);
    } finally {
      await runtime.closeAll();
    }
  });

  it("forwards a buffered result once when its MCP dispatch arrives during asynchronous steering", async () => {
    const driver = new OfflineDriver(),
      runtime = createClaudeRuntime({ driver });
    try {
      const first = collect(runtime.streamRound(request()));
      const session = await started(driver);
      step(session, "batch", [call("a"), call("b")]);
      session.park(call("a"));
      const one = outcome(await first),
        a = toolResult("a"),
        b = toolResult("b");
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const submit = session.submitPrompt.bind(session);
      session.submitPrompt = async (prompt) => {
        await submit(prompt);
        session.park(call("b"));
        await gate;
      };
      session.onResults = (results) => {
        if (results.some((result) => result.toolCallId === "b")) release();
        if (results.some((result) => result.toolCallId === "a")) {
          step(session, "final", [{ type: "text", text: "done" }]);
          success(session);
        }
      };
      const two = outcome(
        await collect(
          runtime.streamRound(
            request({
              roundId: "r2",
              transcript: [
                user,
                assistant(one.content, "toolUse"),
                { role: "tool_result", ...a },
                { role: "tool_result", ...b },
              ],
              input: {
                kind: "tool-results",
                results: [a, b],
                steering: [{ type: "text", text: "continue" }],
              },
            }),
          ),
        ),
      );
      expect(two).toMatchObject({
        reason: "stop",
        content: [{ type: "text", text: "done" }],
      });
      expect(session.results.map((result) => result.toolCallId)).toEqual([
        "b",
        "a",
      ]);
      expect(session.prompts[1]).toMatchObject({
        priority: "next",
        steering: "tool-boundary",
        content: [{ type: "text", text: "continue" }],
      });
    } finally {
      await runtime.closeAll();
    }
  });

  it.each(["id", "name", "arguments"] as const)(
    "rejects conflicting late MCP %s before forwarding a buffered native result",
    async (conflict) => {
      vi.useFakeTimers();
      const driver = new OfflineDriver(),
        runtime = createClaudeRuntime({ driver });
      const configured = request({
        settings: { ...request().settings, toolResultTimeoutMs: 20 },
      });
      try {
        const first = collect(runtime.streamRound(configured));
        await vi.advanceTimersByTimeAsync(0);
        const session = driver.sessions[0],
          proposed = call("b");
        step(session, "batch", [call("a"), proposed]);
        session.park(call("a"));
        const one = outcome(await first),
          a = toolResult("a"),
          b = toolResult("b");
        proposed.arguments.path = "mutated caller value";
        const actual = call("b");
        if (conflict === "id") actual.id = "unknown";
        else if (conflict === "name") actual.name = "different";
        else actual.arguments.path = "mutated caller value";
        session.onResults = () => session.park(actual);
        const next = collect(
          runtime.streamRound({
            ...configured,
            roundId: "r2",
            transcript: [
              user,
              assistant(one.content, "toolUse"),
              { role: "tool_result", ...a },
              { role: "tool_result", ...b },
            ],
            input: { kind: "tool-results", results: [b, a] },
          }),
        );
        await vi.advanceTimersByTimeAsync(21);
        const two = outcome(await next);
        expect(two).toMatchObject({
          reason: "error",
          error: { code: conflict === "id" ? "timeout" : "tool-correlation" },
        });
        expect(session.results.map((result) => result.toolCallId)).toEqual([
          "a",
        ]);
        expect(session.closeCount).toBe(1);
        expect(session.cancellations).toMatchObject([
          { toolCallId: actual.id, isError: true },
        ]);
      } finally {
        await runtime.closeAll();
        vi.useRealTimers();
      }
    },
  );

  it("rejects mismatched first actual MCP arguments at the completed message boundary", async () => {
    const driver = new OfflineDriver(),
      runtime = createClaudeRuntime({ driver });
    try {
      const pending = collect(runtime.streamRound(request()));
      const session = await started(driver);
      session.emit({
        type: "assistant_snapshot",
        messageId: "m",
        content: [call("a"), call("b")],
        attribution: {},
      });
      session.park({ ...call("a"), arguments: { path: "wrong" } });
      session.emit({ type: "message_end", messageId: "m", attribution: {} });
      expect(outcome(await pending)).toMatchObject({
        reason: "error",
        error: { code: "tool-correlation" },
      });
      expect(session.results).toEqual([]);
      expect(session.closeCount).toBe(1);
    } finally {
      await runtime.closeAll();
    }
  });

  it("keeps partial native delivery bounded without projecting the remaining call twice", async () => {
    vi.useFakeTimers();
    const driver = new OfflineDriver(),
      runtime = createClaudeRuntime({ driver });
    const configured = request({
      settings: { ...request().settings, toolResultTimeoutMs: 20 },
    });
    try {
      const first = collect(runtime.streamRound(configured));
      await vi.advanceTimersByTimeAsync(0);
      const session = driver.sessions[0];
      step(session, "batch", [call("a"), call("b")]);
      session.park(call("a"));
      await vi.advanceTimersByTimeAsync(0);
      const one = outcome(await first),
        a = toolResult("a");
      session.onResults = () => session.park(call("b"));
      const next = collect(
        runtime.streamRound({
          ...configured,
          roundId: "r2",
          transcript: [
            user,
            assistant(one.content, "toolUse"),
            { role: "tool_result", ...a },
          ],
          input: { kind: "tool-results", results: [a] },
        }),
      );
      await vi.advanceTimersByTimeAsync(21);
      const events = await next;
      expect(outcome(events)).toMatchObject({
        reason: "error",
        error: { code: "timeout" },
      });
      expect(session.results.map((result) => result.toolCallId)).toEqual(["a"]);
      expect(
        events.filter(
          (event) => event.type === "round_end" && event.reason === "toolUse",
        ),
      ).toEqual([]);
      expect(session.cancellations).toMatchObject([
        { toolCallId: "b", isError: true },
      ]);
    } finally {
      await runtime.closeAll();
      vi.useRealTimers();
    }
  });

  it("aborts buffered native results and clears unresolved dispatch deadlines", async () => {
    vi.useFakeTimers();
    const driver = new OfflineDriver(),
      runtime = createClaudeRuntime({ driver });
    try {
      const first = collect(runtime.streamRound(request()));
      await vi.advanceTimersByTimeAsync(0);
      const session = driver.sessions[0];
      step(session, "batch", [call("a"), call("b")]);
      session.park(call("a"));
      const one = outcome(await first),
        a = toolResult("a"),
        b = toolResult("b"),
        controller = new AbortController();
      const next = collect(
        runtime.streamRound(
          request({
            roundId: "r2",
            signal: controller.signal,
            transcript: [
              user,
              assistant(one.content, "toolUse"),
              { role: "tool_result", ...a },
              { role: "tool_result", ...b },
            ],
            input: { kind: "tool-results", results: [a, b] },
          }),
        ),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(session.results.map((result) => result.toolCallId)).toEqual(["a"]);
      expect(vi.getTimerCount()).toBe(1);
      controller.abort();
      expect(outcome(await next).reason).toBe("aborted");
      session.park(call("b"));
      await Promise.resolve();
      expect(session.results.map((result) => result.toolCallId)).toEqual(["a"]);
      expect(session.closeCount).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await runtime.closeAll();
      vi.useRealTimers();
    }
  });

  it("doesn't start a new user prompt while a complete batch is still awaiting native results or dispatch", async () => {
    const driver = new OfflineDriver(),
      runtime = createClaudeRuntime({ driver });
    try {
      const first = collect(runtime.streamRound(request()));
      const session = await started(driver);
      step(session, "batch", [call("a"), call("b")]);
      session.park(call("a"));
      const one = outcome(await first),
        nextUser: TranscriptMessage = {
          role: "user",
          content: [{ type: "text", text: "next" }],
        };
      const two = outcome(
        await collect(
          runtime.streamRound(
            request({
              roundId: "r2",
              transcript: [user, assistant(one.content, "toolUse"), nextUser],
              input: { kind: "prompt", content: nextUser.content },
            }),
          ),
        ),
      );
      expect(two.reason).toBe("error");
      expect(session.prompts).toHaveLength(1);
      expect(driver.opened).toHaveLength(1);
      expect(session.closeCount).toBe(1);
    } finally {
      await runtime.closeAll();
    }
  });

  it("rejects terminal success before a buffered proposal actually dispatches", async () => {
    const driver = new OfflineDriver(),
      runtime = createClaudeRuntime({ driver });
    try {
      const first = collect(runtime.streamRound(request()));
      const session = await started(driver);
      step(session, "batch", [call("a"), call("b")]);
      session.park(call("a"));
      const one = outcome(await first),
        a = toolResult("a"),
        b = toolResult("b");
      session.onResults = () => success(session);
      const two = outcome(
        await collect(
          runtime.streamRound(
            request({
              roundId: "r2",
              transcript: [
                user,
                assistant(one.content, "toolUse"),
                { role: "tool_result", ...a },
                { role: "tool_result", ...b },
              ],
              input: { kind: "tool-results", results: [a, b] },
            }),
          ),
        ),
      );
      expect(two).toMatchObject({
        reason: "error",
        error: { code: "tool-correlation" },
      });
      expect(session.results.map((result) => result.toolCallId)).toEqual(["a"]);
      expect(session.closeCount).toBe(1);
    } finally {
      await runtime.closeAll();
    }
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

  it("releases a resident host round when an older raw snapshot arrives during its current tool stream", async () => {
    vi.useFakeTimers();
    const driver = new OfflineDriver(),
      runtime = createClaudeRuntime({ driver });
    try {
      const first = collect(runtime.streamRound(request()));
      await vi.advanceTimersByTimeAsync(0);
      const session = driver.sessions[0];
      const raw = (event: unknown) =>
        session.raw({
          type: "stream_event",
          session_id: "claude-1",
          parent_tool_use_id: null,
          event,
        });
      const header = (messageId: string, toolCallId: string) => {
        raw({ type: "message_start", message: { id: messageId } });
        raw({
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: toolCallId,
            name: "mcp__host__read",
            input: { path: toolCallId },
          },
        });
      };
      const end = () => {
        raw({ type: "content_block_stop", index: 0 });
        raw({ type: "message_delta", delta: { stop_reason: "tool_use" } });
        raw({ type: "message_stop" });
      };
      header("previous", "a");
      end();
      session.park(call("a"));
      await vi.advanceTimersByTimeAsync(0);
      const one = outcome(await first),
        a = toolResult("a");
      const second = collect(
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
      await vi.advanceTimersByTimeAsync(0);
      expect(session.results.map((result) => result.toolCallId)).toEqual(["a"]);
      header("current", "b");
      session.raw({
        type: "assistant",
        session_id: "claude-1",
        parent_tool_use_id: null,
        uuid: "late-previous",
        message: {
          id: "previous",
          stop_reason: "tool_use",
          content: [
            {
              type: "tool_use",
              id: "a",
              name: "mcp__host__read",
              input: { path: "a" },
            },
          ],
        },
      });
      end();
      session.park(call("b"));
      let completed: ClaudeRoundEvent[] | undefined;
      void second.then((events) => {
        completed = events;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(completed && outcome(completed)).toMatchObject({
        reason: "toolUse",
        content: [call("b")],
        pendingToolCallIds: ["b"],
      });
      expect(session.closeCount).toBe(0);
      expect(driver.opened).toHaveLength(1);
    } finally {
      await runtime.closeAll();
      vi.useRealTimers();
    }
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
  it("builds streamed text, signed thinking and tool arguments without snapshot dependence", async () => {
    const driver = new OfflineDriver(),
      runtime = createClaudeRuntime({ driver });
    const pending = collect(runtime.streamRound(request()));
    const session = await started(driver);
    session.emit({ type: "message_start", messageId: "m", attribution: {} });
    session.emit({
      type: "content_start",
      messageId: "m",
      index: 0,
      content: { type: "text", text: "prefix" },
      attribution: {},
    });
    session.emit({
      type: "content_delta",
      messageId: "m",
      index: 0,
      delta: { kind: "text", text: " suffix" },
      attribution: {},
    });
    session.emit({
      type: "content_start",
      messageId: "m",
      index: 1,
      content: { type: "thinking", thinking: "" },
      attribution: {},
    });
    session.emit({
      type: "content_delta",
      messageId: "m",
      index: 1,
      delta: { kind: "thinking", thinking: "reason" },
      attribution: {},
    });
    session.emit({
      type: "content_delta",
      messageId: "m",
      index: 1,
      delta: { kind: "signature", signature: "sig" },
      attribution: {},
    });
    session.emit({
      type: "content_start",
      messageId: "m",
      index: 2,
      content: { ...call("a"), arguments: {} },
      attribution: {},
    });
    session.emit({
      type: "content_delta",
      messageId: "m",
      index: 2,
      delta: { kind: "tool-input", partialJson: '{"path":' },
      attribution: {},
    });
    session.emit({
      type: "content_delta",
      messageId: "m",
      index: 2,
      delta: { kind: "tool-input", partialJson: '"a"}' },
      attribution: {},
    });
    session.emit({
      type: "content_end",
      messageId: "m",
      index: 2,
      attribution: {},
    });
    session.emit({
      type: "message_end",
      messageId: "m",
      usage: {
        inputTokens: 1,
        outputTokens: 2,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 1,
      },
      attribution: {},
    });
    session.park(call("a"));
    const end = outcome(await pending);
    expect(end.content).toEqual([
      { type: "text", text: "prefix suffix" },
      { type: "thinking", thinking: "reason", signature: "sig" },
      call("a"),
    ]);
    expect(end.usage?.reasoningTokens).toBe(1);
    await runtime.closeAll();
  });

  it.each(['{"path":', "[]", "null"])(
    "rejects malformed streamed tool input %s before host execution",
    async (partialJson) => {
      const driver = new OfflineDriver(),
        runtime = createClaudeRuntime({ driver });
      const pending = collect(runtime.streamRound(request()));
      const session = await started(driver);
      session.emit({
        type: "content_start",
        messageId: "m",
        index: 0,
        content: { ...call("a"), arguments: {} },
        attribution: {},
      });
      session.emit({
        type: "content_delta",
        messageId: "m",
        index: 0,
        delta: { kind: "tool-input", partialJson },
        attribution: {},
      });
      session.emit({
        type: "content_end",
        messageId: "m",
        index: 0,
        attribution: {},
      });
      expect(outcome(await pending).error?.code).toBe("protocol");
      expect(session.results).toEqual([]);
      await runtime.closeAll();
    },
  );

  it("rejects a delta without an established block instead of inventing content", async () => {
    const driver = new OfflineDriver(),
      runtime = createClaudeRuntime({ driver });
    const pending = collect(runtime.streamRound(request()));
    const session = await started(driver);
    session.emit({
      type: "content_delta",
      messageId: "m",
      index: 0,
      delta: { kind: "text", text: "orphan" },
      attribution: {},
    });
    expect(outcome(await pending).error?.code).toBe("protocol");
    await runtime.closeAll();
  });

  it.each(["inactive", "missing-id", "conflicting-name", "conflicting-park"])(
    "fails a %s host proposal with no repeated execution",
    async (variant) => {
      const driver = new OfflineDriver(),
        runtime = createClaudeRuntime({ driver });
      const configured = request();
      configured.tools = [
        ...configured.tools,
        { ...configured.tools[0], name: "edit" },
      ];
      const pending = collect(runtime.streamRound(configured));
      const session = await started(driver);
      session.emit({ type: "message_start", messageId: "m", attribution: {} });
      if (variant === "inactive" || variant === "missing-id")
        session.park(
          variant === "inactive"
            ? { ...call("a"), name: "inactive" }
            : call(""),
        );
      else {
        session.emit({
          type: "content_start",
          messageId: "m",
          index: 0,
          content: call("a"),
          attribution: {},
        });
        if (variant === "conflicting-name")
          session.emit({
            type: "assistant_snapshot",
            messageId: "m",
            content: [{ ...call("a"), name: "edit" }],
            attribution: {},
          });
        else {
          session.park(call("a"));
          session.park({ ...call("a"), arguments: { path: "changed" } });
        }
      }
      expect(outcome(await pending).error?.code).toBe("tool-correlation");
      expect(session.results).toEqual([]);
      await runtime.closeAll();
    },
  );

  it("treats a repeated identical park as one host call", async () => {
    const driver = new OfflineDriver(),
      runtime = createClaudeRuntime({ driver });
    const pending = collect(runtime.streamRound(request()));
    const session = await started(driver);
    session.emit({
      type: "assistant_snapshot",
      messageId: "m",
      content: [call("a")],
      attribution: {},
    });
    session.park(call("a"));
    session.park(call("a"));
    session.emit({ type: "message_end", messageId: "m", attribution: {} });
    const events = await pending;
    expect(outcome(events).pendingToolCallIds).toEqual(["a"]);
    expect(
      events.filter(
        (event) =>
          event.type === "driver_event" &&
          event.event.type === "host_tool_request",
      ),
    ).toHaveLength(1);
    await runtime.closeAll();
  });

  it.each(["active", "detached"])(
    "rejects turn completion with unresolved host calls while %s",
    async (variant) => {
      const driver = new OfflineDriver(),
        runtime = createClaudeRuntime({ driver });
      const pending = collect(runtime.streamRound(request()));
      const session = await started(driver);
      session.emit({
        type: "assistant_snapshot",
        messageId: "m",
        content: [call("a")],
        attribution: {},
      });
      if (variant === "active") {
        success(session);
        expect(outcome(await pending).error?.code).toBe("tool-correlation");
      } else {
        session.emit({ type: "message_end", messageId: "m", attribution: {} });
        session.park(call("a"));
        const one = outcome(await pending);
        success(session);
        await vi.waitFor(() => expect(session.closeCount).toBe(1));
        const a = toolResult("a");
        const next = outcome(
          await collect(
            runtime.streamRound(
              request({
                roundId: "r2",
                transcript: [user, assistant(one.content, "toolUse")],
                input: { kind: "tool-results", results: [a] },
              }),
            ),
          ),
        );
        expect(next.error?.code).toBe("tool-correlation");
        expect(driver.opened).toHaveLength(1);
      }
      await runtime.closeAll();
    },
  );

  it("fails callback rejection explicitly and sanitizes transport diagnostics", async () => {
    const driver = new OfflineDriver(),
      runtime = createClaudeRuntime({ driver });
    driver.setup = (session) => {
      session.answerInteraction = async () => {
        throw new Error("token=private-token callback failed");
      };
    };
    const pending = collect(runtime.streamRound(request()));
    const session = await started(driver);
    session.emit({
      type: "interaction_request",
      request: {
        kind: "permission",
        requestId: "permission",
        toolUseId: "a",
        toolName: "mcp__host__read",
        input: {},
      },
      attribution: {},
    });
    const end = outcome(await pending);
    expect(end.error).toMatchObject({
      code: "runtime",
      message: "token=[redacted] callback failed",
    });
    await runtime.closeAll();
  });

  it("surfaces event iterator rejection as a transport error", async () => {
    const driver = new OfflineDriver(),
      runtime = createClaudeRuntime({ driver });
    const pending = collect(runtime.streamRound(request()));
    const session = await started(driver);
    session.fail(new Error("stream failure"));
    expect(outcome(await pending).error).toMatchObject({
      code: "transport",
      message: "stream failure",
    });
    await runtime.closeAll();
  });

  it.each(["error", "aborted"] as const)(
    "honors an explicit %s turn terminal",
    async (status) => {
      const driver = new OfflineDriver(),
        runtime = createClaudeRuntime({ driver });
      const pending = collect(runtime.streamRound(request()));
      const session = await started(driver);
      session.emit({
        type: "turn_end",
        status,
        subtype: status,
        isError: true,
        error: {
          code: status === "aborted" ? "aborted" : "runtime",
          message: "failed",
        },
        attribution: {},
      });
      expect(outcome(await pending).reason).toBe(status);
      await runtime.closeAll();
      expect(session.closeCount).toBe(1);
    },
  );

  it.each(["session_error", "session_closed", "reset"])(
    "settles a round when %s arrives",
    async (type) => {
      const driver = new OfflineDriver(),
        runtime = createClaudeRuntime({ driver });
      const pending = collect(runtime.streamRound(request()));
      const session = await started(driver);
      if (type === "session_error")
        session.emit({
          type,
          error: { code: "auth", message: "Login required" },
          attribution: {},
        });
      else if (type === "session_closed")
        session.emit({ type, reason: "aborted", attribution: {} });
      else
        session.emit({
          type: "observation",
          family: "reset",
          subtype: "conversation_reset",
          data: {},
          attribution: {},
        });
      const end = outcome(await pending);
      expect(end.error?.code).toBe(
        type === "session_error"
          ? "auth"
          : type === "session_closed"
            ? "aborted"
            : "history",
      );
      await runtime.closeAll();
    },
  );

  it("forwards attributed child observations and optionally text without changing parent content", async () => {
    const driver = new OfflineDriver(),
      runtime = createClaudeRuntime({ driver });
    const pending = collect(
      runtime.streamRound(
        request({
          settings: { ...request().settings, forwardSubagentText: true },
        }),
      ),
    );
    const session = await started(driver);
    session.emit({
      type: "assistant_snapshot",
      messageId: "child",
      content: [{ type: "text", text: "child" }],
      attribution: { agentId: "agent" },
    });
    session.emit({
      type: "observation",
      family: "task",
      subtype: "task_progress",
      data: { status: "running" },
      attribution: { parentToolUseId: "parent" },
    });
    step(session, "main", [{ type: "text", text: "parent" }]);
    success(session);
    const events = await pending;
    expect(outcome(events).content).toEqual([{ type: "text", text: "parent" }]);
    expect(
      events.filter(
        (event) =>
          event.type === "driver_event" &&
          (event.event.attribution.agentId ||
            event.event.attribution.parentToolUseId),
      ),
    ).toHaveLength(2);
    await runtime.closeAll();
  });

  it("rejects a retraction of a real parked call before the host has executed it", async () => {
    const driver = new OfflineDriver(),
      runtime = createClaudeRuntime({ driver });
    const pending = collect(runtime.streamRound(request()));
    const session = await started(driver);
    session.emit({
      type: "assistant_snapshot",
      messageId: "m",
      snapshotId: "old",
      content: [call("a")],
      contentIndexes: [0],
      attribution: {},
    });
    session.park(call("a"));
    session.emit({
      type: "assistant_snapshot",
      messageId: "replacement",
      snapshotId: "new",
      content: [{ type: "text", text: "replacement" }],
      supersedes: ["old"],
      attribution: {},
    });
    expect(outcome(await pending).error?.code).toBe("tool-correlation");
    expect(session.cancellations[0]?.isError).toBe(true);
    await runtime.closeAll();
  });

  it("removes a superseded unparked proposal and keeps the replacement content", async () => {
    const driver = new OfflineDriver(),
      runtime = createClaudeRuntime({ driver });
    const pending = collect(runtime.streamRound(request()));
    const session = await started(driver);
    session.emit({
      type: "assistant_snapshot",
      messageId: "old",
      snapshotId: "old-frame",
      content: [call("a")],
      contentIndexes: [0],
      attribution: {},
    });
    session.emit({
      type: "assistant_snapshot",
      messageId: "new",
      snapshotId: "new-frame",
      content: [{ type: "text", text: "replacement" }],
      supersedes: ["old-frame"],
      attribution: {},
    });
    session.emit({ type: "message_end", messageId: "new", attribution: {} });
    success(session);
    const end = outcome(await pending);
    expect(end.reason).toBe("stop");
    expect(end.content).toEqual([{ type: "text", text: "replacement" }]);
    await runtime.closeAll();
  });

  it("waits for opening ownership during close without allowing a prompt after shutdown", async () => {
    const driver = new OfflineDriver(),
      runtime = createClaudeRuntime({ driver });
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = driver.openSession.bind(driver);
    driver.openSession = async (req) => {
      await gate;
      return original(req);
    };
    const pending = collect(runtime.streamRound(request()));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const closing = runtime.closeAll();
    release();
    const end = outcome(await pending);
    await closing;
    expect(driver.sessions[0].closeCount).toBe(1);
    expect(driver.sessions[0].prompts).toHaveLength(0);
    expect(end.error?.code).toBe("closed");
  });

  it("exposes close failures while still settling the host subscription once", async () => {
    const driver = new OfflineDriver(),
      runtime = createClaudeRuntime({ driver });
    driver.setup = (session) => {
      session.close = async () => {
        session.closeCount++;
        session.end();
        throw new Error("cleanup failed");
      };
    };
    const pending = collect(runtime.streamRound(request()));
    const session = await started(driver);
    await expect(runtime.close("host")).rejects.toThrow("cleanup failed");
    expect(outcome(await pending).reason).toBe("aborted");
    expect(session.closeCount).toBe(1);
    await expect(runtime.closeAll()).rejects.toThrow("cleanup failed");
  });

  it("serializes replacement acquisition while the previous resident query is closing", async () => {
    const driver = new OfflineDriver(),
      runtime = createClaudeRuntime({ driver });
    driver.setup = (session) => {
      session.onPrompt = () => {
        step(session, "m", [{ type: "text", text: "done" }]);
        success(session);
      };
    };
    const one = outcome(await collect(runtime.streamRound(request())));
    const old = driver.sessions[0];
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const close = old.close.bind(old);
    old.close = async () => {
      await gate;
      return close();
    };
    const next = request({
      roundId: "r2",
      cwd: "/changed",
      transcript: [user, assistant(one.content)],
    });
    const a = collect(runtime.streamRound(next));
    const b = collect(runtime.streamRound({ ...next, roundId: "r3" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    const ends = (await Promise.all([a, b])).map(outcome);
    expect(driver.opened).toHaveLength(2);
    expect(ends.filter((end) => end.reason === "stop")).toHaveLength(1);
    expect(ends.filter((end) => end.reason === "error")).toHaveLength(1);
    await runtime.closeAll();
  });
  it("accepts steering before releasing a parked call even when result completion is immediate", async () => {
    const driver = new OfflineDriver(),
      runtime = createClaudeRuntime({ driver });
    const pending = collect(runtime.streamRound(request()));
    const session = await started(driver);
    step(session, "m", [call("a")]);
    session.park(call("a"));
    const one = outcome(await pending);
    const accepted: string[] = [];
    session.onPrompt = () => accepted.push("steering");
    session.deliverToolResults = async (results) => {
      session.results.push(...results);
      for (const result of results) session.pending.delete(result.toolCallId);
      accepted.push("results");
      success(session);
      await new Promise((resolve) => setTimeout(resolve, 0));
    };
    const steering = [
      { type: "text" as const, text: "Use the alternate path" },
    ];
    const a = toolResult("a");
    const next = outcome(
      await collect(
        runtime.streamRound(
          request({
            roundId: "r2",
            transcript: [
              user,
              assistant(one.content, "toolUse"),
              { role: "tool_result", ...a },
              { role: "user", content: steering },
            ],
            input: { kind: "tool-results", results: [a], steering },
          }),
        ),
      ),
    );
    expect(next.reason).toBe("stop");
    expect(accepted).toEqual(["steering", "results"]);
    expect(session.prompts[1]).toMatchObject({
      priority: "next",
      steering: "tool-boundary",
      content: steering,
    });
    await runtime.closeAll();
  });

  it.each(["close", "invalidate"])(
    "waits for an in-flight initial acquisition before %s",
    async (operation) => {
      const driver = new OfflineDriver(),
        runtime = createClaudeRuntime({ driver });
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const original = driver.openSession.bind(driver);
      driver.openSession = async (req) => {
        await gate;
        return original(req);
      };
      const pending = collect(runtime.streamRound(request()));
      await new Promise((resolve) => setTimeout(resolve, 0));
      const closing =
        operation === "close"
          ? runtime.close("host")
          : runtime.invalidate(request().session, "compaction");
      release();
      await closing;
      expect(outcome(await pending).reason).toBe("aborted");
      expect(driver.sessions[0].closeCount).toBe(1);
      await runtime.closeAll();
    },
  );

  it("declines unsupported subagent forwarding and incompatible drivers before acquiring resources", async () => {
    const scripted = new OfflineDriver();
    const driver: ClaudeDriver = {
      kind: scripted.kind,
      capabilities: { ...scripted.capabilities, forwardSubagentText: false },
      openSession: scripted.openSession.bind(scripted),
    };
    const runtime = createClaudeRuntime({ driver });
    expect(
      outcome(
        await collect(
          runtime.streamRound(
            request({
              settings: { ...request().settings, forwardSubagentText: true },
            }),
          ),
        ),
      ).error?.code,
    ).toBe("unsupported");
    expect(scripted.opened).toEqual([]);
    Reflect.set(driver.capabilities, "contractVersion", 2);
    expect(
      outcome(await collect(runtime.streamRound(request()))).error?.code,
    ).toBe("unsupported");
    await runtime.closeAll();
    expect(
      outcome(await collect(runtime.streamRound(request()))).error?.code,
    ).toBe("closed");
  });

  it("rejects an invalid round timeout and a missing canonical result ID before spawning", async () => {
    const driver = new OfflineDriver(),
      runtime = createClaudeRuntime({ driver });
    expect(
      outcome(
        await collect(
          runtime.streamRound(
            request({
              settings: { ...request().settings, toolResultTimeoutMs: 0 },
            }),
          ),
        ),
      ).error?.code,
    ).toBe("protocol");
    expect(
      outcome(
        await collect(
          runtime.streamRound(
            request({
              input: { kind: "tool-results", results: [toolResult("")] },
            }),
          ),
        ),
      ).error?.code,
    ).toBe("tool-correlation");
    expect(driver.opened).toEqual([]);
    await runtime.closeAll();
  });

  it("replays supplied historical tool results under a fresh identity when no parked native state exists", async () => {
    const driver = new OfflineDriver(),
      runtime = createClaudeRuntime({ driver });
    driver.setup = (session) => {
      session.onPrompt = () => success(session);
    };
    const a = toolResult("a");
    const history = [user, assistant([call("a")], "toolUse")];
    expect(
      outcome(
        await collect(
          runtime.streamRound(
            request({
              transcript: history,
              input: { kind: "tool-results", results: [a] },
            }),
          ),
        ),
      ).reason,
    ).toBe("stop");
    expect(driver.opened[0].resume).toMatchObject({
      mode: "replay",
      replayTranscript: [...history, { role: "tool_result", ...a }],
    });
    expect(driver.sessions[0].prompts[0].content).toEqual([
      {
        type: "text",
        text: "Continue the conversation using the supplied host tool results.",
      },
    ]);
    expect(driver.sessions[0].results).toEqual([]);
    await runtime.closeAll();
  });

  it("fails a rejected prompt write through the host terminal instead of hanging", async () => {
    const driver = new OfflineDriver(),
      runtime = createClaudeRuntime({ driver });
    driver.setup = (session) => {
      session.submitPrompt = async () => {
        throw new Error("write failed");
      };
    };
    expect(
      outcome(await collect(runtime.streamRound(request()))).error?.message,
    ).toBe("write failed");
    await runtime.closeAll();
  });
  it("rejects a concurrent request with different configuration during initial acquisition", async () => {
    const driver = new OfflineDriver(),
      runtime = createClaudeRuntime({ driver });
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = driver.openSession.bind(driver);
    driver.openSession = async (req) => {
      await gate;
      return original(req);
    };
    const first = collect(runtime.streamRound(request()));
    const competing = outcome(
      await collect(
        runtime.streamRound(
          request({
            roundId: "conflict",
            cwd: "/foreign",
            model: "foreign",
            auth: { mode: "api-key", apiKey: "offline-other" },
          }),
        ),
      ),
    );
    expect(competing.error?.code).toBe("protocol");
    release();
    const session = await started(driver);
    success(session);
    expect(outcome(await first).reason).toBe("stop");
    expect(driver.opened).toHaveLength(1);
    expect(driver.opened[0]).toMatchObject({
      model: "model",
      identity: { cwd: "/sandbox" },
      auth: { mode: "claude-login" },
    });
    await runtime.closeAll();
  });
  it("doesn't spend the MCP parking deadline while tool JSON is still streaming", async () => {
    vi.useFakeTimers();
    const driver = new OfflineDriver(),
      runtime = createClaudeRuntime({ driver });
    try {
      const pending = collect(
        runtime.streamRound(
          request({
            settings: { ...request().settings, toolResultTimeoutMs: 20 },
          }),
        ),
      );
      await vi.advanceTimersByTimeAsync(0);
      const session = driver.sessions[0];
      session.emit({
        type: "message_start",
        messageId: "streamed",
        attribution: {},
      });
      session.emit({
        type: "content_start",
        messageId: "streamed",
        index: 0,
        content: { ...call("a"), arguments: {} },
        attribution: {},
      });
      session.emit({
        type: "content_delta",
        messageId: "streamed",
        index: 0,
        delta: { kind: "tool-input", partialJson: '{"path":' },
        attribution: {},
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(session.closeCount).toBe(0);
      expect(session.interruptCount).toBe(0);
      session.emit({
        type: "content_delta",
        messageId: "streamed",
        index: 0,
        delta: { kind: "tool-input", partialJson: '"a"}' },
        attribution: {},
      });
      session.emit({
        type: "content_end",
        messageId: "streamed",
        index: 0,
        attribution: {},
      });
      session.emit({
        type: "message_end",
        messageId: "streamed",
        attribution: {},
      });
      session.park(call("a"));
      await vi.advanceTimersByTimeAsync(0);
      expect(outcome(await pending)).toMatchObject({
        reason: "toolUse",
        content: [call("a")],
        pendingToolCallIds: ["a"],
      });
    } finally {
      await runtime.closeAll();
      vi.useRealTimers();
    }
  });
  it.each(["content_end", "assistant_snapshot", "message_end"] as const)(
    "bounds a %s proposal once the message ends and it never reaches MCP",
    async (completion) => {
      vi.useFakeTimers();
      const driver = new OfflineDriver(),
        runtime = createClaudeRuntime({ driver });
      try {
        const pending = collect(
          runtime.streamRound(
            request({
              settings: { ...request().settings, toolResultTimeoutMs: 20 },
            }),
          ),
        );
        await vi.advanceTimersByTimeAsync(0);
        const session = driver.sessions[0];
        session.emit({
          type: "content_start",
          messageId: "m",
          index: 0,
          content: call("a"),
          attribution: {},
        });
        if (completion === "assistant_snapshot")
          session.emit({
            type: completion,
            messageId: "m",
            content: [call("a")],
            contentIndexes: [0],
            attribution: {},
          });
        else if (completion === "content_end")
          session.emit({
            type: completion,
            messageId: "m",
            index: 0,
            attribution: {},
          });
        else
          session.emit({ type: completion, messageId: "m", attribution: {} });
        if (completion !== "message_end") {
          await vi.advanceTimersByTimeAsync(100);
          expect(session.closeCount).toBe(0);
          session.emit({
            type: "message_end",
            messageId: "m",
            attribution: {},
          });
        }
        await vi.advanceTimersByTimeAsync(21);
        expect(outcome(await pending)).toMatchObject({
          reason: "error",
          error: {
            code: "timeout",
            details: { toolCallId: "a", toolName: "read", phase: "mcp-park" },
          },
        });
      } finally {
        await runtime.closeAll();
        vi.useRealTimers();
      }
    },
  );

  it("waits for the entire message while a later parallel tool block is still streaming", async () => {
    vi.useFakeTimers();
    const driver = new OfflineDriver(),
      runtime = createClaudeRuntime({ driver });
    try {
      const pending = collect(
        runtime.streamRound(
          request({
            settings: { ...request().settings, toolResultTimeoutMs: 20 },
          }),
        ),
      );
      await vi.advanceTimersByTimeAsync(0);
      const session = driver.sessions[0];
      session.emit({
        type: "content_start",
        messageId: "m",
        index: 0,
        content: call("a"),
        attribution: {},
      });
      session.emit({
        type: "content_end",
        messageId: "m",
        index: 0,
        attribution: {},
      });
      session.emit({
        type: "content_start",
        messageId: "m",
        index: 1,
        content: call("b"),
        attribution: {},
      });
      session.emit({
        type: "content_delta",
        messageId: "m",
        index: 1,
        delta: { kind: "tool-input", partialJson: '{"path":' },
        attribution: {},
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(session.closeCount).toBe(0);
      expect(session.interruptCount).toBe(0);
      session.emit({
        type: "content_delta",
        messageId: "m",
        index: 1,
        delta: { kind: "tool-input", partialJson: '"b"}' },
        attribution: {},
      });
      session.emit({
        type: "content_end",
        messageId: "m",
        index: 1,
        attribution: {},
      });
      session.emit({ type: "message_end", messageId: "m", attribution: {} });
      session.park(call("a"));
      await vi.advanceTimersByTimeAsync(10);
      expect(session.closeCount).toBe(0);
      session.park(call("b"));
      await vi.advanceTimersByTimeAsync(0);
      expect(outcome(await pending)).toMatchObject({
        reason: "toolUse",
        pendingToolCallIds: ["a", "b"],
      });
    } finally {
      await runtime.closeAll();
      vi.useRealTimers();
    }
  });

  it("bounds a missing second dispatch even after both native results are buffered", async () => {
    vi.useFakeTimers();
    const driver = new OfflineDriver(),
      runtime = createClaudeRuntime({ driver });
    try {
      const pending = collect(
        runtime.streamRound(
          request({
            settings: { ...request().settings, toolResultTimeoutMs: 20 },
          }),
        ),
      );
      await vi.advanceTimersByTimeAsync(0);
      const session = driver.sessions[0];
      step(session, "parallel", [call("a"), call("b")]);
      await vi.advanceTimersByTimeAsync(5);
      session.park(call("a"));
      await vi.advanceTimersByTimeAsync(0);
      const one = outcome(await pending),
        a = toolResult("a"),
        b = toolResult("b");
      expect(one).toMatchObject({
        reason: "toolUse",
        pendingToolCallIds: ["a", "b"],
      });
      const continuation = collect(
        runtime.streamRound(
          request({
            roundId: "r2",
            settings: { ...request().settings, toolResultTimeoutMs: 20 },
            transcript: [
              user,
              assistant(one.content, "toolUse"),
              { role: "tool_result", ...b },
              { role: "tool_result", ...a },
            ],
            input: { kind: "tool-results", results: [b, a] },
          }),
        ),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(session.results.map((result) => result.toolCallId)).toEqual(["a"]);
      await vi.advanceTimersByTimeAsync(16);
      expect(outcome(await continuation)).toMatchObject({
        reason: "error",
        error: {
          code: "timeout",
          details: { toolCallId: "b", toolName: "read", phase: "mcp-park" },
        },
      });
      expect(session.cancellations).toEqual([]);
    } finally {
      await runtime.closeAll();
      vi.useRealTimers();
    }
  });

  it("bounds the MCP handoff from a definitive full assistant snapshot without stream frames", async () => {
    vi.useFakeTimers();
    const driver = new OfflineDriver(),
      runtime = createClaudeRuntime({ driver });
    try {
      const pending = collect(
        runtime.streamRound(
          request({
            settings: { ...request().settings, toolResultTimeoutMs: 20 },
          }),
        ),
      );
      await vi.advanceTimersByTimeAsync(0);
      const session = driver.sessions[0];
      session.raw({
        type: "assistant",
        message: {
          id: "snapshot-only",
          stop_reason: "tool_use",
          content: [
            {
              type: "tool_use",
              id: "a",
              name: "mcp__host__read",
              input: { path: "a" },
            },
          ],
        },
      });
      await vi.advanceTimersByTimeAsync(21);
      expect(outcome(await pending)).toMatchObject({
        reason: "error",
        error: {
          code: "timeout",
          details: { toolCallId: "a", toolName: "read", phase: "mcp-park" },
        },
      });
    } finally {
      await runtime.closeAll();
      vi.useRealTimers();
    }
  });

  it("keeps a resident read/edit/final flow alive while native edit arguments with intent stream slowly", async () => {
    vi.useFakeTimers();
    const driver = new OfflineDriver(),
      runtime = createClaudeRuntime({ driver });
    const configured = request({
      settings: { ...request().settings, toolResultTimeoutMs: 20 },
    });
    configured.tools = [
      ...configured.tools,
      {
        name: "edit",
        owner: "host",
        description: "Native edit",
        inputSchema: {
          type: "object",
          properties: { input: { type: "string" }, i: { type: "string" } },
          required: ["input", "i"],
          additionalProperties: false,
        },
      },
    ];
    try {
      const first = collect(runtime.streamRound(configured));
      await vi.advanceTimersByTimeAsync(0);
      const session = driver.sessions[0];
      step(session, "read", [call("read-id")]);
      session.park(call("read-id"));
      await vi.advanceTimersByTimeAsync(0);
      const one = outcome(await first);
      const read = toolResult("read-id"),
        history: TranscriptMessage[] = [
          user,
          assistant(one.content, "toolUse"),
          { role: "tool_result", ...read },
        ];
      const second = collect(
        runtime.streamRound({
          ...configured,
          roundId: "edit-round",
          transcript: history,
          input: { kind: "tool-results", results: [read] },
        }),
      );
      await vi.advanceTimersByTimeAsync(0);
      const normalizer = createClaudeEventNormalizer({
        tools: configured.tools,
        hostMcpServerName: "host",
        requestedModel: "model",
      });
      const emitRaw = (event: unknown) => {
        for (const normalized of normalizer.normalize({
          type: "stream_event",
          session_id: "claude-1",
          parent_tool_use_id: null,
          event,
        }))
          session.emit(normalized);
      };
      emitRaw({
        type: "message_start",
        message: { id: "edit-message", model: "model" },
      });
      emitRaw({
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "edit-id",
          name: "mcp__host__edit",
          input: {},
        },
      });
      emitRaw({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"input":' },
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(session.closeCount).toBe(0);
      const args = {
        input: "[fixture.txt#F27C]\nPUT 1.=1:\n+replacement",
        i: "replace line 1 with replacement",
      };
      const remainder = JSON.stringify(args).slice('{"input":'.length);
      emitRaw({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: remainder },
      });
      emitRaw({ type: "content_block_stop", index: 0 });
      emitRaw({ type: "message_delta", delta: { stop_reason: "tool_use" } });
      emitRaw({ type: "message_stop" });
      const editCall: HostToolCall = {
        type: "tool_call",
        id: "edit-id",
        name: "edit",
        arguments: args,
      };
      session.park(editCall);
      await vi.advanceTimersByTimeAsync(0);
      const two = outcome(await second);
      expect(two.content).toEqual([editCall]);
      expect(two.reason).toBe("toolUse");
      const edit = { ...toolResult("edit-id"), toolName: "edit" };
      history.push(assistant(two.content, "toolUse"), {
        role: "tool_result",
        ...edit,
      });
      session.onResults = () => {
        step(session, "final", [{ type: "text", text: "done" }]);
        success(session);
      };
      const third = collect(
        runtime.streamRound({
          ...configured,
          roundId: "final-round",
          transcript: history,
          input: { kind: "tool-results", results: [edit] },
        }),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(outcome(await third).reason).toBe("stop");
      expect(driver.opened).toHaveLength(1);
      expect(session.results.map((result) => result.toolCallId)).toEqual([
        "read-id",
        "edit-id",
      ]);
    } finally {
      await runtime.closeAll();
      vi.useRealTimers();
    }
  });
});

// Active queue tests exercise native admission/consumption timing with a labelled driver double.
describe("active native queue ownership (offline)", () => {
  function setup() {
    const driver = new OfflineDriver();
    const runtime = createClaudeRuntime({
      driver: {
        kind: driver.kind,
        capabilities: { ...driver.capabilities, steering: "active-queue" },
        openSession: driver.openSession.bind(driver),
      },
    });
    return { driver, runtime };
  }
  function receipts(
    session: OfflineSession,
    prompt: DriverPrompt,
    state: "queued" | "started",
  ) {
    session.emit({
      type: "observation",
      family: "diagnostic",
      subtype: "steering-admission",
      data: { commandId: prompt.commandId!, state },
      attribution: {},
    });
  }
  function claim(contents = [[{ type: "text" as const, text: "correct" }]]) {
    return { contents, accept: vi.fn(), reject: vi.fn() };
  }

  it("keeps multiple accepted inputs ordered across a native result and buffered continuation without resubmission", async () => {
    const { driver, runtime } = setup();
    const taken = claim([
      [{ type: "text", text: "first" }],
      [{ type: "text", text: "second" }],
    ]);
    const first = collect(
      runtime.streamRound(
        request({
          activeSteering: { wait: async () => {}, claim: async () => taken },
        }),
      ),
    );
    const session = await started(driver);
    await vi.waitFor(() => expect(session.prompts).toHaveLength(2));
    const queued = session.prompts[1];
    expect(queued).toMatchObject({
      turnId: "r1",
      priority: "next",
      steering: "active-queue",
      content: taken.contents.flat(),
    });
    expect(taken.accept).toHaveBeenCalledOnce();
    step(session, "original", [{ type: "text", text: "original answer" }]);
    const one = outcome(await first);
    success(session); // Original native result precedes command consumption.
    receipts(session, queued, "started");
    step(session, "corrected", [{ type: "text", text: "corrected answer" }]);
    success(session);
    const accepted = taken.contents.map(
      (content): TranscriptMessage => ({ role: "user", content }),
    );
    const history = [user, assistant(one.content), ...accepted];
    const two = outcome(
      await collect(
        runtime.streamRound(
          request({
            roundId: "r2",
            transcript: history,
            input: {
              kind: "prompt",
              content: accepted[1]
                .content as readonly import("../../src/contracts/index.js").UserContent[],
            },
          }),
        ),
      ),
    );
    expect(two.content).toEqual([{ type: "text", text: "corrected answer" }]);
    expect(driver.opened).toHaveLength(1);
    expect(session.prompts).toHaveLength(2);
    expect(taken.reject).not.toHaveBeenCalled();
    session.onPrompt = () => {
      step(session, "followup", [{ type: "text", text: "still resident" }]);
      success(session);
    };
    await collect(
      runtime.streamRound(
        request({
          roundId: "r3",
          transcript: [
            ...history,
            assistant(two.content),
            { role: "user", content: [{ type: "text", text: "continue" }] },
          ],
          input: {
            kind: "prompt",
            content: [{ type: "text", text: "continue" }],
          },
        }),
      ),
    );
    expect(driver.opened).toHaveLength(1);
    expect(session.prompts).toHaveLength(3);
    await runtime.closeAll();
  });

  it("waits for admission when the original terminal arrives during the transport write", async () => {
    const { driver, runtime } = setup();
    let admitted!: () => void;
    driver.setup = (session) => {
      session.submitPrompt = async (prompt) => {
        session.prompts.push(prompt);
        if (prompt.steering)
          await new Promise<void>((resolve) => {
            admitted = resolve;
          });
      };
    };
    const taken = claim();
    const first = collect(
      runtime.streamRound(
        request({
          activeSteering: { wait: async () => {}, claim: async () => taken },
        }),
      ),
    );
    const session = await started(driver);
    await vi.waitFor(() => expect(session.prompts).toHaveLength(2));
    step(session, "original", [{ type: "text", text: "before correction" }]);
    success(session);
    expect(taken.accept).not.toHaveBeenCalled();
    admitted();
    expect(outcome(await first).content).toEqual([
      { type: "text", text: "before correction" },
    ]);
    expect(taken.accept).toHaveBeenCalledOnce();
    await runtime.closeAll();
  });

  it("rejects a late claim once after the host response already ended", async () => {
    const { driver, runtime } = setup();
    let resolveClaim!: (value: ReturnType<typeof claim>) => void;
    const waiting = vi.fn(
      () =>
        new Promise<ReturnType<typeof claim>>((resolve) => {
          resolveClaim = resolve;
        }),
    );
    const first = collect(
      runtime.streamRound(
        request({ activeSteering: { wait: async () => {}, claim: waiting } }),
      ),
    );
    const session = await started(driver);
    await vi.waitFor(() => expect(waiting).toHaveBeenCalledOnce());
    step(session, "done", [{ type: "text", text: "done" }]);
    success(session);
    expect(outcome(await first).reason).toBe("stop");
    const late = claim();
    resolveClaim(late);
    await vi.waitFor(() => expect(late.reject).toHaveBeenCalledOnce());
    expect(late.accept).not.toHaveBeenCalled();
    expect(session.prompts).toHaveLength(1);
    await runtime.closeAll();
  });

  it("rechecks a spurious empty wake before claiming later input", async () => {
    const { driver, runtime } = setup();
    const taken = claim();
    const take = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(taken);
    const first = collect(
      runtime.streamRound(
        request({ activeSteering: { wait: async () => {}, claim: take } }),
      ),
    );
    const session = await started(driver);
    await vi.waitFor(() => expect(taken.accept).toHaveBeenCalledOnce());
    step(session, "done", [{ type: "text", text: "done" }]);
    expect(outcome(await first).reason).toBe("stop");
    expect(take).toHaveBeenCalledTimes(2);
    await runtime.closeAll();
  });

  it("aborts unknown admission and settles the claimed input on external cancellation", async () => {
    const { driver, runtime } = setup();
    driver.setup = (session) => {
      session.submitPrompt = async (prompt) => {
        session.prompts.push(prompt);
        if (prompt.steering) await new Promise<void>(() => {});
      };
    };
    const controller = new AbortController(),
      taken = claim();
    const first = collect(
      runtime.streamRound(
        request({
          signal: controller.signal,
          activeSteering: { wait: async () => {}, claim: async () => taken },
        }),
      ),
    );
    const session = await started(driver);
    await vi.waitFor(() => expect(session.prompts).toHaveLength(2));
    controller.abort();
    expect(outcome(await first).reason).toBe("aborted");
    expect(taken.reject).toHaveBeenCalledOnce();
    expect(taken.accept).not.toHaveBeenCalled();
    await runtime.closeAll();
  });

  it("refuses to replay an accepted correction when the next host transcript changes it", async () => {
    const { driver, runtime } = setup();
    const taken = claim();
    const first = collect(
      runtime.streamRound(
        request({
          activeSteering: { wait: async () => {}, claim: async () => taken },
        }),
      ),
    );
    const session = await started(driver);
    await vi.waitFor(() => expect(taken.accept).toHaveBeenCalledOnce());
    step(session, "done", [{ type: "text", text: "done" }]);
    const one = outcome(await first);
    const changed = [{ type: "text" as const, text: "different" }];
    const next = outcome(
      await collect(
        runtime.streamRound(
          request({
            roundId: "r2",
            transcript: [
              user,
              assistant(one.content),
              { role: "user", content: changed },
            ],
            input: { kind: "prompt", content: changed },
          }),
        ),
      ),
    );
    expect(next.error?.code).toBe("history");
    expect(driver.opened).toHaveLength(1);
    expect(session.prompts).toHaveLength(2);
    expect(session.closeCount).toBe(1);
    await runtime.closeAll();
  });
});

it("retains real parked host calls while active admission is pending and forwards results once", async () => {
  const driver = new OfflineDriver();
  const runtime = createClaudeRuntime({
    driver: {
      kind: driver.kind,
      capabilities: { ...driver.capabilities, steering: "active-queue" },
      openSession: driver.openSession.bind(driver),
    },
  });
  let admit!: () => void;
  driver.setup = (session) => {
    session.submitPrompt = async (prompt) => {
      session.prompts.push(prompt);
      if (prompt.steering)
        await new Promise<void>((resolve) => {
          admit = resolve;
        });
    };
  };
  const accepted = vi.fn(),
    rejected = vi.fn(),
    content = [{ type: "text" as const, text: "correct" }];
  const first = collect(
    runtime.streamRound(
      request({
        activeSteering: {
          wait: async () => {},
          claim: async () => ({
            contents: [content],
            accept: accepted,
            reject: rejected,
          }),
        },
      }),
    ),
  );
  const session = await started(driver);
  await vi.waitFor(() => expect(session.prompts).toHaveLength(2));
  step(session, "tool", [call("a")]);
  session.park(call("a"));
  expect(accepted).not.toHaveBeenCalled();
  expect(session.results).toHaveLength(0);
  admit();
  const one = outcome(await first);
  expect(one.reason).toBe("toolUse");
  expect(accepted).toHaveBeenCalledOnce();
  expect(rejected).not.toHaveBeenCalled();
  expect(session.closeCount).toBe(0);
  session.onResults = () => {
    session.emit({
      type: "observation",
      family: "diagnostic",
      subtype: "steering-admission",
      data: { commandId: session.prompts[1].commandId!, state: "started" },
      attribution: {},
    });
    step(session, "after", [{ type: "text", text: "corrected" }]);
    success(session);
  };
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
            { role: "user", content },
          ],
          input: { kind: "tool-results", results: [a], steering: content },
        }),
      ),
    ),
  );
  expect(two.reason).toBe("stop");
  expect(session.results).toEqual([a]);
  expect(session.prompts).toHaveLength(2);
  expect(driver.opened).toHaveLength(1);
  await runtime.closeAll();
});

it("fails explicitly when a buffered active continuation exceeds the event limit", async () => {
  const driver = new OfflineDriver();
  const runtime = createClaudeRuntime({
    driver: {
      kind: driver.kind,
      capabilities: { ...driver.capabilities, steering: "active-queue" },
      openSession: driver.openSession.bind(driver),
    },
  });
  const accepted = vi.fn();
  const first = collect(
    runtime.streamRound(
      request({
        activeSteering: {
          wait: async () => {},
          claim: async () => ({
            contents: [[{ type: "text", text: "correct" }]],
            accept: accepted,
            reject: vi.fn(),
          }),
        },
      }),
    ),
  );
  const session = await started(driver);
  await vi.waitFor(() => expect(accepted).toHaveBeenCalledOnce());
  step(session, "original", [{ type: "text", text: "original" }]);
  await first;
  session.emit({
    type: "observation",
    family: "diagnostic",
    subtype: "steering-admission",
    data: { commandId: session.prompts[1].commandId!, state: "started" },
    attribution: {},
  });
  for (let i = 0; i < 260; i++)
    session.emit({
      type: "content_delta",
      messageId: "next",
      index: 0,
      delta: { kind: "text", text: "x" },
      attribution: {},
    });
  await vi.waitFor(() => expect(session.closeCount).toBe(1));
  expect(session.prompts).toHaveLength(2);
  await runtime.closeAll();
});

it("rejects unacknowledged active admission on its deadline and invalidates the resident session", async () => {
  const driver = new OfflineDriver();
  const runtime = createClaudeRuntime({
    driver: {
      kind: driver.kind,
      capabilities: { ...driver.capabilities, steering: "active-queue" },
      openSession: driver.openSession.bind(driver),
    },
  });
  driver.setup = (session) => {
    session.submitPrompt = async (prompt) => {
      session.prompts.push(prompt);
      if (prompt.steering) await new Promise<void>(() => {});
    };
  };
  const accept = vi.fn(),
    reject = vi.fn();
  const pending = collect(
    runtime.streamRound(
      request({
        settings: {
          toolResultTimeoutMs: 25,
          claudeTools: [],
          userMcpServers: [],
        },
        activeSteering: {
          wait: async () => {},
          claim: async () => ({
            contents: [[{ type: "text", text: "correct" }]],
            accept,
            reject,
          }),
        },
      }),
    ),
  );
  const terminal = outcome(await pending);
  expect(terminal.reason).toBe("error");
  expect(terminal.error?.code).toBe("timeout");
  expect(accept).not.toHaveBeenCalled();
  expect(reject).toHaveBeenCalledOnce();
  expect(driver.sessions[0].closeCount).toBe(1);
  await runtime.closeAll();
});

it("rejects an empty claimed batch without submitting a native prompt", async () => {
  const driver = new OfflineDriver();
  const runtime = createClaudeRuntime({
    driver: {
      kind: driver.kind,
      capabilities: { ...driver.capabilities, steering: "active-queue" },
      openSession: driver.openSession.bind(driver),
    },
  });
  const accept = vi.fn(),
    reject = vi.fn();
  const pending = collect(
    runtime.streamRound(
      request({
        activeSteering: {
          wait: async () => {},
          claim: async () => ({ contents: [], accept, reject }),
        },
      }),
    ),
  );
  const session = await started(driver);
  await vi.waitFor(() => expect(reject).toHaveBeenCalledOnce());
  step(session, "ordinary", [{ type: "text", text: "ordinary" }]);
  success(session);
  expect(outcome(await pending).reason).toBe("stop");
  expect(accept).not.toHaveBeenCalled();
  expect(session.prompts).toHaveLength(1);
  await runtime.closeAll();
});
