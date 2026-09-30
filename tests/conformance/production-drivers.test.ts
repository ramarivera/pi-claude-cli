import { afterEach, describe, expect, it, vi } from "vitest";
import { createClaudeRuntime } from "../../src/core/index.js";
import type {
  ClaudeDriverEvent,
  ClaudeRoundEvent,
  DriverKind,
  HostRoundRequest,
  TranscriptMessage,
} from "../../src/contracts/index.js";
import {
  hostRequest,
  nativeTool,
  productionDriver,
  sessionRequest,
  toolArguments,
  toolResult,
} from "../support/production-drivers.js";
import { projectMainContent } from "../support/fixture-catalog.js";
import type { ScenarioCommand } from "../support/protocol-scenario.mjs";

const dispose: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of dispose.splice(0).reverse()) await close();
});
async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Offline conformance deadline")),
          5000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function collect(source: AsyncIterable<ClaudeRoundEvent>) {
  return bounded(
    (async () => {
      const events: ClaudeRoundEvent[] = [];
      for await (const event of source) events.push(event);
      return events;
    })(),
  );
}
function end(events: ClaudeRoundEvent[]) {
  const ends = events.filter((event) => event.type === "round_end");
  expect(ends).toHaveLength(1);
  return ends[0];
}
const command = (
  turn: string,
  mode: ScenarioCommand["mode"] = "text",
): ScenarioCommand => ({
  turn,
  mode,
  text: `hello-${turn}`,
  ...(mode === "tools" || mode === "slow-tool"
    ? {
        calls: ["call-a", "call-b"].map((id) => ({
          id,
          name: "edit",
          arguments: toolArguments,
        })),
      }
    : {}),
});
const userHistory = (request: HostRoundRequest): TranscriptMessage => {
  if (request.input.kind !== "prompt") throw new Error("Expected prompt");
  return { role: "user", content: request.input.content };
};

for (const kind of ["cli", "sdk"] satisfies DriverKind[]) {
  describe(`${kind} production driver contract (offline external transport, real MCP)`, () => {
    async function direct() {
      const owner = await productionDriver(kind);
      dispose.push(owner.cleanup);
      const session = await owner.driver.openSession(sessionRequest(kind));
      const events: ClaudeDriverEvent[] = [];
      const pumped = (async () => {
        for await (const event of session.events) events.push(event);
      })();
      dispose.push(async () => {
        await session.close();
        await bounded(pumped);
      });
      return { ...owner, session, events, pumped };
    }
    const has = async (
      events: ClaudeDriverEvent[],
      predicate: (event: ClaudeDriverEvent) => boolean,
    ) => {
      await vi.waitFor(() => expect(events.some(predicate)).toBe(true), {
        timeout: 4000,
        interval: 5,
      });
    };

    it("normalizes full/delta text once, keeps authoritative identity and monotonic sequence across resident prompts", async () => {
      const t = await direct();
      for (const turn of ["first", "second"]) {
        await t.session.submitPrompt({
          turnId: turn,
          content: [{ type: "text", text: JSON.stringify(command(turn)) }],
        });
        await has(
          t.events,
          (event) =>
            event.type === "turn_end" && event.attribution.turnId === turn,
        );
      }
      expect(
        t.events
          .filter((event) => event.type === "turn_end")
          .map((event) => event.status),
      ).toEqual(["success", "success"]);
      expect(
        projectMainContent(t.events)
          .filter((block) => block.type === "text")
          .map((block) => block.text),
      ).toEqual(["hello-first", "hello-second"]);
      expect(
        t.events.filter((event) => event.type === "initialized"),
      ).toHaveLength(1);
      const initialized = t.events.find(
        (event) => event.type === "initialized",
      );
      expect(initialized?.claudeSessionId).toMatch(/^offline-/);
      expect(
        new Set(
          t.events
            .filter((event) => event.type === "turn_end")
            .map((event) => event.attribution.claudeSessionId),
        ),
      ).toEqual(new Set([initialized?.claudeSessionId]));
      expect(t.events.map((event) => event.sequence)).toEqual(
        t.events.map((_, i) => i + 1),
      );
      await t.session.close();
      await t.pumped;
      expect(
        t.events.filter((event) => event.type === "session_closed"),
      ).toHaveLength(1);
      await t.session.close();
      await expect(
        t.session.submitPrompt({ turnId: "late", content: [] }),
      ).rejects.toThrow(/closed/);
    });

    it("preserves native schemas, parks parallel calls once and correlates reversed results with exact structured output", async () => {
      const t = await direct();
      await t.session.submitPrompt({
        turnId: "parallel",
        content: [
          { type: "text", text: JSON.stringify(command("parallel", "tools")) },
        ],
      });
      await vi.waitFor(
        () =>
          expect(
            t.events.filter((event) => event.type === "host_tool_request"),
          ).toHaveLength(2),
        { timeout: 4000, interval: 5 },
      );
      const calls = t.events.filter(
        (event) => event.type === "host_tool_request",
      );
      expect(calls.map((event) => event.call.id).sort()).toEqual([
        "call-a",
        "call-b",
      ]);
      for (const event of calls) {
        expect(event.call.arguments).toEqual(toolArguments);
        expect(event.attribution.toolUseId).toBe(event.call.id);
      }
      const transport =
        kind === "cli" ? await t.captures[0].readReceipt() : t.captures[0];
      expect(transport.listing).toEqual({
        tools: [
          {
            name: nativeTool.name,
            description: nativeTool.description,
            title: nativeTool.title,
            inputSchema: nativeTool.inputSchema,
            outputSchema: nativeTool.outputSchema,
            annotations: nativeTool.annotations,
            _meta: nativeTool._meta,
          },
        ],
      });
      expect(t.events.some((event) => event.type === "turn_end")).toBe(false);
      if (kind === "cli") {
        const receipt = await t.captures[0].readReceipt();
        expect(() => process.kill(receipt.pid, 0)).not.toThrow();
      } else expect(t.captures[0].closes).toBe(0);
      await t.session.deliverToolResults([toolResult("call-b")]);
      await t.session.deliverToolResults([toolResult("call-b")]);
      await expect(
        t.session.deliverToolResults([
          { ...toolResult("call-b"), isError: true },
        ]),
      ).rejects.toThrow(/Conflicting duplicate/);
      expect(t.events.some((event) => event.type === "turn_end")).toBe(false);
      await t.session.deliverToolResults([toolResult("call-a", true)]);
      await has(t.events, (event) => event.type === "turn_end");
      const returned =
        kind === "cli"
          ? (await t.captures[0].readReceipt()).results
          : t.captures[0].results;
      expect(returned).toEqual([
        [
          {
            id: "call-a",
            result: {
              content: [{ type: "text", text: "sentinel:call-a" }],
              structuredContent: { nonce: "nonce-call-a" },
              isError: true,
              _meta: { resultOrigin: "host", id: "call-a" },
            },
          },
          {
            id: "call-b",
            result: {
              content: [{ type: "text", text: "sentinel:call-b" }],
              structuredContent: { nonce: "nonce-call-b" },
              isError: false,
              _meta: { resultOrigin: "host", id: "call-b" },
            },
          },
        ],
      ]);
      expect(JSON.stringify(returned)).not.toContain("hostOnly");
      expect(
        t.events.filter((event) => event.type === "turn_end"),
      ).toHaveLength(1);
    });

    it("buffers early results and rejects conflicting duplicate results before an actual tools/call", async () => {
      const t = await direct();
      await t.session.deliverToolResults([
        toolResult("call-a"),
        toolResult("call-b"),
      ]);
      await t.session.deliverToolResults([toolResult("call-a")]);
      await expect(
        t.session.deliverToolResults([
          { ...toolResult("call-a"), structuredContent: { nonce: "conflict" } },
        ]),
      ).rejects.toThrow(/Conflicting duplicate/);
      await t.session.submitPrompt({
        turnId: "early",
        content: [
          { type: "text", text: JSON.stringify(command("early", "tools")) },
        ],
      });
      await has(t.events, (event) => event.type === "turn_end");
      const returned =
        kind === "cli"
          ? (await t.captures[0].readReceipt()).results
          : t.captures[0].results;
      expect(returned).toMatchObject([
        [
          {
            id: "call-a",
            result: {
              structuredContent: { nonce: "nonce-call-a" },
              isError: false,
            },
          },
          {
            id: "call-b",
            result: {
              structuredContent: { nonce: "nonce-call-b" },
              isError: false,
            },
          },
        ],
      ]);
      const parkedIds = t.events
        .filter((event) => event.type === "host_tool_request")
        .map((event) => event.call.id);
      expect(new Set(parkedIds).size).toBe(parkedIds.length);
      expect(
        t.events.filter((event) => event.type === "turn_end"),
      ).toHaveLength(1);
    });

    it("cancels every parked MCP call as isError true before interrupt and remains closeable", async () => {
      const t = await direct();
      await t.session.submitPrompt({
        turnId: "cancel",
        content: [
          {
            type: "text",
            text: JSON.stringify(command("cancel", "slow-tool")),
          },
        ],
      });
      await vi.waitFor(
        () =>
          expect(
            t.events.filter((event) => event.type === "host_tool_request"),
          ).toHaveLength(2),
        { timeout: 4000, interval: 5 },
      );
      await t.session.interrupt("Offline host cancelled");
      await has(
        t.events,
        (event) =>
          event.type === "observation" && event.data.kind === "tool_results",
      );
      const results = t.events.find(
        (event) =>
          event.type === "observation" && event.data.kind === "tool_results",
      );
      expect(results).toMatchObject({
        data: {
          results: [
            { id: "call-a", result: { isError: true } },
            { id: "call-b", result: { isError: true } },
          ],
        },
      });
      await has(t.events, (event) => event.type === "turn_end");
      expect(
        t.events
          .filter((event) => event.type === "turn_end")
          .map((event) => event.status),
      ).toEqual(["aborted"]);
      await t.session.close();
      await t.pumped;
      expect(
        t.events.filter((event) => event.type === "session_closed"),
      ).toHaveLength(1);
    });

    it("fails invalid result IDs/names and unsupported steering without requesting inference", async () => {
      const t = await direct();
      await expect(
        t.session.deliverToolResults([{ ...toolResult("x"), toolCallId: "" }]),
      ).rejects.toThrow(/ID|id/);
      await expect(
        t.session.deliverToolResults([
          { ...toolResult("x"), toolName: "unexposed" },
        ]),
      ).rejects.toThrow(/tool/);
      await expect(
        t.session.submitPrompt({
          turnId: "steer",
          priority: "now",
          content: [{ type: "text", text: "do not infer" }],
        }),
      ).rejects.toThrow(/steering|priority/i);
      expect(t.events.some((event) => event.type === "message_start")).toBe(
        false,
      );
    });
  });

  describe(`${kind} production core + driver conformance (offline inference)`, () => {
    async function setup() {
      const owner = await productionDriver(kind);
      dispose.push(owner.cleanup);
      const runtime = createClaudeRuntime({ driver: owner.driver });
      dispose.push(() => runtime.closeAll());
      return { ...owner, runtime };
    }

    it("ends one text round, reuses acknowledged resident history and passes the distinctive system prompt intact", async () => {
      const t = await setup();
      const firstRequest = hostRequest(command("first"));
      const firstEvents = await collect(t.runtime.streamRound(firstRequest));
      const first = end(firstEvents);
      expect(first).toMatchObject({
        reason: "stop",
        content: [{ type: "text", text: "hello-first" }],
        usage: {
          inputTokens: 10,
          outputTokens: 6,
          cacheReadTokens: 2,
          cacheWriteTokens: 1,
          costUsd: 0.001,
        },
      });
      const secondRequest = hostRequest(command("second"), {
        transcript: [
          userHistory(firstRequest),
          {
            role: "assistant",
            content: first.content,
            stopReason: first.reason,
          },
        ],
      });
      const second = end(await collect(t.runtime.streamRound(secondRequest)));
      expect(second).toMatchObject({
        reason: "stop",
        content: [{ type: "text", text: "hello-second" }],
      });
      expect(t.captures).toHaveLength(1);
      expect(t.captures[0].request.systemPrompt).toBe(
        "Distinctive system marker: integration-system",
      );
      if (kind === "cli") {
        const receipt = await t.captures[0].readReceipt();
        expect(receipt.systemPrompt).toBe(firstRequest.systemPrompt);
        expect(receipt.prompts).toHaveLength(2);
        expect(receipt.args).toContain("--strict-mcp-config");
      } else {
        expect(t.captures[0].options?.systemPrompt).toBe(
          firstRequest.systemPrompt,
        );
        expect(t.captures[0].submitted).toHaveLength(2);
      }
    });

    it("ends a host tool round once without killing transport, then resumes both correlated results in reversed host order", async () => {
      const t = await setup();
      const firstRequest = hostRequest(command("tools", "tools"));
      const first = end(await collect(t.runtime.streamRound(firstRequest)));
      expect(first.reason).toBe("toolUse");
      expect([...first.pendingToolCallIds].sort()).toEqual([
        "call-a",
        "call-b",
      ]);
      expect(first.content).toHaveLength(2);
      for (const block of first.content)
        expect(block).toMatchObject({
          type: "tool_call",
          name: "edit",
          arguments: toolArguments,
        });
      if (kind === "cli") {
        const receipt = await t.captures[0].readReceipt();
        expect(() => process.kill(receipt.pid, 0)).not.toThrow();
      } else expect(t.captures[0].closes).toBe(0);
      const results = [toolResult("call-b"), toolResult("call-a")];
      const transcript: TranscriptMessage[] = [
        userHistory(firstRequest),
        { role: "assistant", content: first.content, stopReason: "toolUse" },
        ...results.map(
          (result): TranscriptMessage => ({ role: "tool_result", ...result }),
        ),
      ];
      const continuation = end(
        await collect(
          t.runtime.streamRound({
            ...firstRequest,
            roundId: "tool-result-round",
            transcript,
            input: { kind: "tool-results", results },
          }),
        ),
      );
      expect(continuation.reason).toBe("stop");
      expect(continuation.content).toEqual([
        {
          type: "text",
          text: 'call-a:{"nonce":"nonce-call-a"}:false|call-b:{"nonce":"nonce-call-b"}:false',
        },
      ]);
      expect(t.captures).toHaveLength(1);
      const summed = [first, continuation].reduce(
        (sum, item) => ({
          input: sum.input + (item.usage?.inputTokens ?? 0),
          output: sum.output + (item.usage?.outputTokens ?? 0),
        }),
        { input: 0, output: 0 },
      );
      expect(summed).toEqual({ input: 10, output: 6 });
      if (kind === "cli")
        expect((await t.captures[0].readReceipt()).prompts).toHaveLength(1);
      else expect(t.captures[0].submitted).toHaveLength(1);
    });

    it.each(["compaction", "branch", "import", "reset"] as const)(
      "rebuilds after %s and passes complete labelled history to the same selected driver",
      async (reason) => {
        const t = await setup();
        const initial = hostRequest(command("initial"));
        const first = end(await collect(t.runtime.streamRound(initial)));
        await t.runtime.invalidate(initial.session, reason);
        const history: TranscriptMessage[] = [
          userHistory(initial),
          { role: "assistant", content: first.content, stopReason: "stop" },
        ];
        const next = hostRequest(command("after-reset"), {
          transcript: history,
        });
        const result = end(await collect(t.runtime.streamRound(next)));
        expect(result).toMatchObject({
          reason: "stop",
          content: [{ type: "text", text: "hello-after-reset" }],
        });
        expect(t.captures).toHaveLength(2);
        expect(
          t.captures.map((capture) => capture.request.identity.driver),
        ).toEqual([kind, kind]);
        expect(t.captures[1].request.resume).toMatchObject({
          mode: "replay",
          restoration: "user-history-replay",
          replayTranscript: history,
        });
        const input =
          kind === "cli"
            ? (await t.captures[1].readReceipt()).prompts
            : t.captures[1].submitted;
        const text = JSON.stringify(input);
        expect(text).toContain("hello-initial");
        expect(text).toContain("assistant");
        expect(text).toContain("user");
        expect(text.match(/hello-after-reset/g)).toHaveLength(1);
      },
    );

    it("keeps same-ID host sessions in two independent runtimes isolated", async () => {
      const left = await setup();
      const right = await setup();
      const [a, b] = await Promise.all([
        collect(
          left.runtime.streamRound(
            hostRequest({ turn: "left", mode: "text", text: "left-secret" }),
          ),
        ),
        collect(
          right.runtime.streamRound(
            hostRequest({ turn: "right", mode: "text", text: "right-secret" }),
          ),
        ),
      ]);
      expect(end(a).content).toEqual([{ type: "text", text: "left-secret" }]);
      expect(end(b).content).toEqual([{ type: "text", text: "right-secret" }]);
      expect(left.captures).toHaveLength(1);
      expect(right.captures).toHaveLength(1);
      expect(left.captures[0].session).not.toBe(right.captures[0].session);
    });

    it("replays complete preexisting roles, images, thinking, native calls and structured results once through the selected transport", async () => {
      const t = await setup();
      const history: TranscriptMessage[] = [
        {
          role: "developer",
          content: [{ type: "text", text: "historical-developer-rule" }],
        },
        {
          role: "user",
          content: [
            { type: "text", text: "historical-image-question" },
            { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
          ],
        },
        {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "historical-reasoning",
              signature: "historical-signature",
            },
            {
              type: "tool_call",
              id: "historical-call",
              name: "edit",
              arguments: toolArguments,
            },
          ],
          stopReason: "toolUse",
        },
        { role: "tool_result", ...toolResult("historical-call", true) },
      ];
      const request = hostRequest(
        { turn: "replay", mode: "text", text: "current-once" },
        { transcript: history },
      );
      expect(
        end(await collect(t.runtime.streamRound(request))).content,
      ).toEqual([{ type: "text", text: "current-once" }]);
      expect(t.captures).toHaveLength(1);
      expect(t.captures[0].request.resume).toMatchObject({
        mode: "replay",
        replayTranscript: history,
      });
      const inputs =
        kind === "cli"
          ? (await t.captures[0].readReceipt()).prompts
          : t.captures[0].submitted;
      const encoded = JSON.stringify(inputs);
      for (const marker of [
        "historical-developer-rule",
        "historical-image-question",
        "historical-reasoning",
        "historical-signature",
        "historical-call",
        "nonce-historical-call",
        "aGVsbG8=",
        "image/png",
        "developer",
        "tool_result",
      ])
        expect(encoded).toContain(marker);
      expect(encoded.match(/current-once/g)).toHaveLength(1);
      expect(encoded).toContain("isError");
    });

    it("restores saved host history by labelled replay when no Claude persistence was verified", async () => {
      const t = await setup();
      const request = hostRequest(command("saved"));
      const first = end(await collect(t.runtime.streamRound(request)));
      await t.runtime.close(request.session.sessionId);
      const history: TranscriptMessage[] = [
        userHistory(request),
        { role: "assistant", content: first.content, stopReason: "stop" },
      ];
      const restored = end(
        await collect(
          t.runtime.streamRound(
            hostRequest(command("restored"), { transcript: history }),
          ),
        ),
      );
      expect(restored.content).toEqual([
        { type: "text", text: "hello-restored" },
      ]);
      expect(t.captures).toHaveLength(2);
      expect(t.captures[1].request.resume).toMatchObject({
        mode: "replay",
        restoration: "user-history-replay",
        replayTranscript: history,
      });
      const inputs =
        kind === "cli"
          ? (await t.captures[1].readReceipt()).prompts
          : t.captures[1].submitted;
      expect(JSON.stringify(inputs)).toContain("hello-saved");
      expect(t.captures[1].request.identity.driver).toBe(kind);
    });

    it.each([
      "empty-session",
      "empty-round",
      "zero-timeout",
      "negative-timeout",
    ] as const)(
      "rejects %s before opening either inference transport",
      async (invalid) => {
        const t = await setup();
        const request = hostRequest(command("invalid"));
        if (invalid === "empty-session")
          request.session = { ...request.session, sessionId: "" };
        if (invalid === "empty-round") request.roundId = "";
        if (invalid === "zero-timeout")
          request.settings = { ...request.settings, toolResultTimeoutMs: 0 };
        if (invalid === "negative-timeout")
          request.settings = { ...request.settings, toolResultTimeoutMs: -1 };
        expect(
          end(await collect(t.runtime.streamRound(request))),
        ).toMatchObject({
          reason: "error",
          error: {
            message:
              "Round requires identity and a positive tool-result timeout",
          },
        });
        expect(t.captures).toHaveLength(0);
      },
    );

    it.each(["hold", "slow-tool"] as const)(
      "aborts %s and completes owned cleanup before a new prompt",
      async (mode) => {
        const t = await setup();
        const controller = new AbortController();
        const initial = hostRequest(command("abort", mode), {
          signal: controller.signal,
        });
        const events: ClaudeRoundEvent[] = [];
        const pending = bounded(
          (async () => {
            for await (const event of t.runtime.streamRound(initial)) {
              events.push(event);
              if (
                event.type === "driver_event" &&
                event.event.type ===
                  (mode === "hold" ? "message_start" : "host_tool_request")
              )
                controller.abort();
            }
            return events;
          })(),
        );
        const result = end(await pending);
        expect(result.reason, JSON.stringify(events)).toBe("aborted");
        await t.runtime.close(initial.session.sessionId);
        expect(t.captures).toHaveLength(1);
        const restarted = end(
          await collect(
            t.runtime.streamRound(hostRequest(command("restarted"))),
          ),
        );
        expect(restarted.reason).toBe("stop");
        expect(t.captures).toHaveLength(2);
        expect(t.captures[1].request.resume.mode).toBe("fresh");
      },
    );

    it.each(["error", "malformed"] as const)(
      "reports %s through one error round and doesn't retry another driver",
      async (mode) => {
        const t = await setup();
        const result = end(
          await collect(
            t.runtime.streamRound(hostRequest(command("failed", mode))),
          ),
        );
        expect(result.reason).toBe("error");
        expect(result.error?.code).toBe(
          mode === "malformed" ? "protocol" : "runtime",
        );
        expect(t.captures).toHaveLength(1);
        expect(t.captures[0].request.identity.driver).toBe(kind);
      },
    );

    it("rejects an uncorrelated host result and emits one actionable terminal", async () => {
      const t = await setup();
      const request = hostRequest(command("tools", "tools"));
      const first = end(await collect(t.runtime.streamRound(request)));
      const bad = end(
        await collect(
          t.runtime.streamRound({
            ...request,
            roundId: "bad-result",
            transcript: [
              userHistory(request),
              {
                role: "assistant",
                content: first.content,
                stopReason: "toolUse",
              },
            ],
            input: {
              kind: "tool-results",
              results: [toolResult("never-parked")],
            },
          }),
        ),
      );
      expect(bad).toMatchObject({
        reason: "error",
        error: {
          code: "tool-correlation",
          message: "Uncorrelated host result never-parked",
        },
      });
      expect(t.captures).toHaveLength(1);
    });
  });
}
