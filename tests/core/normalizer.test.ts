import { describe, expect, it } from "vitest";
import { createClaudeEventNormalizer } from "../../src/core/index.js";
import type {
  ClaudeEventNormalizer,
  UnsequencedClaudeDriverEvent,
} from "../../src/contracts/index.js";

// Offline synthetic protocol fixtures, pinned to the researched 2.1.285 envelopes.
const make = (): ClaudeEventNormalizer =>
  createClaudeEventNormalizer({
    hostMcpServerName: "host",
    requestedModel: "requested-model",
    tools: [
      {
        name: "read",
        owner: "host",
        description: "Read",
        inputSchema: { type: "object" },
      },
    ],
  });
const stream = (event: unknown, extra: object = {}) => ({
  type: "stream_event",
  session_id: "session",
  parent_tool_use_id: null,
  event,
  ...extra,
});
const snapshot = (
  id: string,
  uuid: string,
  content: unknown[],
  extra: object = {},
) => ({
  type: "assistant",
  session_id: "session",
  parent_tool_use_id: null,
  uuid,
  message: { id, model: "model", content, stop_reason: null },
  ...extra,
});
const result = (extra: object = {}) => ({
  type: "result",
  session_id: "session",
  uuid: "result",
  subtype: "success",
  is_error: false,
  result: "done",
  ...extra,
});
function collectContent(
  events: readonly UnsequencedClaudeDriverEvent[],
): string {
  const blocks = new Map<number, string>();
  for (const event of events) {
    if (event.type === "content_start" && event.content.type === "text")
      blocks.set(event.index, event.content.text);
    if (event.type === "content_delta" && event.delta.kind === "text")
      blocks.set(
        event.index,
        (blocks.get(event.index) ?? "") + event.delta.text,
      );
    if (event.type === "assistant_snapshot")
      event.content.forEach((content, i) => {
        if (content.type === "text")
          blocks.set(event.contentIndexes?.[i] ?? i, content.text);
      });
  }
  return [...blocks]
    .sort(([a], [b]) => a - b)
    .map(([, text]) => text)
    .join("");
}

describe("shared Claude normalizer (offline)", () => {
  it("traces message boundaries using only IDs, block metadata and completion flags", () => {
    const n = make();
    const start = n.normalize(
      stream({
        type: "message_start",
        message: { id: "m", content: "private prompt" },
      }),
    );
    expect(start.map((event) => event.type)).toEqual([
      "message_start",
      "observation",
    ]);
    expect(start[1]).toMatchObject({
      family: "diagnostic",
      subtype: "core-message-start",
      data: {
        messageId: "m",
        previousActiveMessageId: null,
        activeMessageId: "m",
        ended: false,
        blocks: [],
      },
    });
    const raw = snapshot("m", "s", [
      { type: "text", text: "private assistant text" },
      {
        type: "tool_use",
        id: "a",
        name: "mcp__host__read",
        input: { path: "private path", token: "private credential" },
      },
    ]);
    const full = n.normalize(raw);
    const trace = full.find(
      (event) =>
        event.type === "observation" &&
        event.subtype === "core-assistant-snapshot",
    );
    expect(trace).toMatchObject({
      data: {
        messageId: "m",
        previousActiveMessageId: "m",
        activeMessageId: "m",
        ended: false,
        stopReasonPresent: false,
        blockCount: 2,
        blocks: [
          { index: 0, type: "text", ended: true },
          { index: 1, type: "tool_call", ended: true, toolCallId: "a" },
        ],
        snapshotId: "s",
        snapshotKnownMessage: true,
        snapshotFull: true,
        snapshotStopReasonPresent: false,
      },
    });
    expect(JSON.stringify(trace)).not.toContain("private");
    expect(n.normalize(stream({ type: "message_stop" }))).toMatchObject([
      { type: "message_end", messageId: "m" },
      {
        type: "observation",
        family: "diagnostic",
        subtype: "core-message-stop",
        data: { messageId: "m", ended: true, blockCount: 2 },
      },
    ]);
    n.normalize(stream({ type: "message_start", message: { id: "new" } }));
    const late = n.normalize({ ...raw, uuid: "late" });
    expect(late.at(-1)).toMatchObject({
      data: {
        messageId: "m",
        previousActiveMessageId: "new",
        activeMessageId: "new",
        ended: true,
        snapshotKnownMessage: true,
      },
    });
  });

  it.each([true, false])(
    "keeps a newer streamed message active when an earlier message receives a late snapshot (ended=%s)",
    (ended) => {
      const n = make();
      n.normalize(
        stream({ type: "message_start", message: { id: "previous" } }),
      );
      if (ended) n.normalize(stream({ type: "message_stop" }));
      n.normalize(
        stream({ type: "message_start", message: { id: "current" } }),
      );
      n.normalize(
        stream({
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        }),
      );
      n.normalize(
        snapshot("previous", "late", [{ type: "text", text: "old" }]),
      );
      expect(
        n.normalize(
          stream({
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "current text" },
          }),
        ),
      ).toContainEqual(
        expect.objectContaining({
          type: "content_delta",
          messageId: "current",
          delta: { kind: "text", text: "current text" },
        }),
      );
      expect(n.normalize(stream({ type: "message_stop" }))).toContainEqual(
        expect.objectContaining({ type: "message_end", messageId: "current" }),
      );
    },
  );

  it("projects authoritative initialization and failed MCP status before results", () => {
    const n = make();
    const events = n.normalize({
      type: "system",
      subtype: "init",
      session_id: "real-id",
      model: "actual",
      claude_code_version: "2.1.285",
      tools: ["mcp__host__read"],
      capabilities: ["future"],
      apiKeySource: "none",
      mcp_servers: [{ name: "host", status: "failed", source: "sdk" }],
    });
    expect(events[0]).toMatchObject({
      type: "initialized",
      claudeSessionId: "real-id",
      runtimeVersion: "2.1.285",
      authSource: "none",
    });
    expect(events[1]).toMatchObject({
      type: "session_error",
      error: {
        code: "runtime",
        message: "MCP server host initialization failed",
      },
    });
    expect(
      n.normalize({ type: "system", subtype: "init", session_id: "" })[0],
    ).toMatchObject({ type: "session_error", error: { code: "protocol" } });
  });

  it("reconciles streamed text and canonical snapshots without duplicate text", () => {
    const n = make(),
      events: UnsequencedClaudeDriverEvent[] = [];
    for (const payload of [
      stream({
        type: "message_start",
        message: { id: "m", model: "actual", usage: { input_tokens: 7 } },
      }),
      stream({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
      stream({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hello" },
      }),
      stream({ type: "content_block_stop", index: 0 }),
      snapshot("m", "block-1", [{ type: "text", text: "Hello" }]),
      stream({
        type: "content_block_start",
        index: 1,
        content_block: { type: "text", text: "" },
      }),
      stream({
        type: "content_block_delta",
        index: 1,
        delta: { type: "text_delta", text: " world" },
      }),
      stream({ type: "content_block_stop", index: 1 }),
      snapshot("m", "block-2", [{ type: "text", text: " world" }]),
      snapshot("m", "full", [
        { type: "text", text: "Hello" },
        { type: "text", text: " world" },
      ]),
    ])
      events.push(...n.normalize(payload));
    expect(collectContent(events)).toBe("Hello world");
    expect(
      n.normalize(
        snapshot("m", "full", [
          { type: "text", text: "Hello" },
          { type: "text", text: " world" },
        ]),
      ),
    ).toEqual([]);
    expect(
      events
        .filter((event) => event.type === "assistant_snapshot")
        .map((event) => event.contentIndexes),
    ).toEqual([[0], [1], [0, 1]]);
  });

  it("never mutates already emitted start events while later deltas arrive", () => {
    const n = make();
    n.normalize(
      stream({ type: "message_start", message: { id: "m", model: "actual" } }),
    );
    const started = n.normalize(
      stream({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "prefix" },
      }),
    );
    const deltas = n.normalize(
      stream({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: " suffix" },
      }),
    );
    expect(started[0]).toMatchObject({ content: { text: "prefix" } });
    expect(collectContent([...started, ...deltas])).toBe("prefix suffix");
    expect(n.normalize(result())[0]).toMatchObject({ model: "actual" });
  });

  it("retains snapshot-only repeated text blocks and signatures at their original positions", () => {
    const n = make();
    const first = n.normalize(
      snapshot("m", "a", [{ type: "text", text: "same" }]),
    );
    const second = n.normalize(
      snapshot("m", "b", [{ type: "text", text: "same" }]),
    );
    expect(collectContent([...first, ...second])).toBe("samesame");
    const thinking = n.normalize(
      snapshot("m2", "c", [
        { type: "thinking", thinking: "reason", signature: "signature" },
        { type: "redacted_thinking", data: "opaque" },
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "image" },
        },
      ]),
    );
    expect(thinking[0]).toMatchObject({
      type: "assistant_snapshot",
      contentIndexes: [0, 1, 2],
      content: [
        { type: "thinking", thinking: "reason", signature: "signature" },
        { type: "thinking", thinking: "opaque", redacted: true },
        { type: "image", data: "image", mimeType: "image/png" },
      ],
    });
  });

  it("preserves thinking/signature deltas, stop reason and incremental usage", () => {
    const n = make();
    n.normalize(
      stream({
        type: "message_start",
        message: {
          id: "m",
          usage: { input_tokens: 12, cache_read_input_tokens: 3 },
        },
      }),
    );
    n.normalize(
      stream({
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "", signature: "" },
      }),
    );
    expect(
      n.normalize(
        stream({
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "reason" },
        }),
      )[0],
    ).toMatchObject({ delta: { kind: "thinking", thinking: "reason" } });
    expect(
      n.normalize(
        stream({
          type: "content_block_delta",
          index: 0,
          delta: { type: "signature_delta", signature: "sig" },
        }),
      )[0],
    ).toMatchObject({ delta: { kind: "signature", signature: "sig" } });
    n.normalize(
      stream({
        type: "message_delta",
        delta: { stop_reason: "max_tokens" },
        usage: { output_tokens: 5 },
      }),
    );
    expect(n.normalize(stream({ type: "message_stop" }))[0]).toMatchObject({
      type: "message_end",
      stopReason: "max_tokens",
      usage: { inputTokens: 12, outputTokens: 5, cacheReadTokens: 3 },
    });
    expect(n.normalize(stream({ type: "message_stop" }))).toEqual([]);
  });

  it("emits one definitive full-snapshot boundary and doesn't repeat partial message_stop", () => {
    const n = make();
    const full = snapshot("m", "a", [{ type: "text", text: "done" }]);
    const definitive = {
      ...full,
      message: { ...full.message, stop_reason: "end_turn" },
    };
    expect(n.normalize(definitive).map((event) => event.type)).toEqual([
      "assistant_snapshot",
      "message_end",
      "observation",
    ]);
    expect(n.normalize(definitive)).toEqual([]);
    const streamed = make();
    streamed.normalize(stream({ type: "message_start", message: { id: "m" } }));
    expect(
      streamed.normalize(stream({ type: "message_stop" }))[0],
    ).toMatchObject({ type: "message_end" });
    expect(
      streamed
        .normalize(definitive)
        .filter((event) => event.type === "message_end"),
    ).toEqual([]);
  });

  it("projects only owned namespace calls and never fabricates an MCP park", () => {
    const n = make();
    const events = n.normalize(
      snapshot("m", "a", [
        {
          type: "tool_use",
          id: "host-id",
          name: "mcp__host__read",
          input: { path: "file" },
        },
        { type: "tool_use", id: "native", name: "Read", input: {} },
        { type: "tool_use", id: "user", name: "mcp__other__read", input: {} },
        {
          type: "tool_use",
          id: "inactive",
          name: "mcp__host__inactive",
          input: {},
        },
      ]),
    );
    expect(
      events.find((event) => event.type === "assistant_snapshot"),
    ).toMatchObject({
      content: [
        {
          type: "tool_call",
          id: "host-id",
          name: "read",
          arguments: { path: "file" },
        },
      ],
      contentIndexes: [0],
    });
    expect(
      events.filter(
        (event) =>
          event.type === "observation" &&
          event.subtype === "claude-tool-proposal",
      ),
    ).toHaveLength(3);
    expect(events.some((event) => event.type === "host_tool_request")).toBe(
      false,
    );
    expect(
      n
        .normalize(
          snapshot(
            "child",
            "c",
            [
              {
                type: "tool_use",
                id: "child-id",
                name: "mcp__host__read",
                input: {},
              },
            ],
            { parent_tool_use_id: "task-parent" },
          ),
        )
        .filter(
          (event) =>
            event.type === "observation" &&
            event.subtype === "claude-tool-proposal",
        ),
    ).toMatchObject([
      {
        type: "observation",
        data: { owner: "subagent" },
        attribution: { parentToolUseId: "task-parent", toolUseId: "child-id" },
      },
    ]);
  });

  it.each([
    "error_during_execution",
    "error_max_turns",
    "error_max_budget_usd",
    "error_max_structured_output_retries",
    "new_error_variant",
  ])("maps %s to one error terminal with usage", (subtype) => {
    const n = make();
    const events = n.normalize(
      result({
        subtype,
        is_error: false,
        errors: ["actionable error"],
        usage: {
          input_tokens: 10,
          output_tokens: 20,
          cache_creation_input_tokens: 2,
        },
        total_cost_usd: 0.01,
        modelUsage: { actual: { inputTokens: 10 } },
      }),
    );
    expect(events).toMatchObject([
      {
        type: "turn_end",
        status: "error",
        isError: true,
        subtype,
        model: "requested-model",
        usage: {
          inputTokens: 10,
          outputTokens: 20,
          cacheWriteTokens: 2,
          costUsd: 0.01,
          modelUsage: { actual: { inputTokens: 10 } },
        },
        error: { message: "actionable error", subtype },
      },
    ]);
    expect(n.normalize(result({ subtype, uuid: "different" }))).toEqual([]);
  });

  it("honors is_error on success and abort markers, allowing subsequent resident turns", () => {
    const n = make();
    expect(
      n.normalize(result({ is_error: true, result: "bad" }))[0],
    ).toMatchObject({ status: "error", error: { message: "bad" } });
    n.normalize(stream({ type: "message_start", message: { id: "new" } }));
    expect(
      n.normalize(result({ uuid: "r2", terminal_reason: "user_abort" }))[0],
    ).toMatchObject({ status: "aborted", isError: true });
    expect(
      n.normalize(
        stream({
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "late" },
        }),
      ),
    ).toEqual([]);
    n.normalize(stream({ type: "message_start", message: { id: "next" } }));
    expect(n.normalize(result({ uuid: "r3" }))[0]).toMatchObject({
      status: "success",
    });
  });

  it("keeps interleaved child stream state and child terminal separate", () => {
    const n = make();
    n.normalize(stream({ type: "message_start", message: { id: "main" } }));
    n.normalize(
      stream(
        { type: "message_start", message: { id: "child" } },
        { parent_tool_use_id: "parent" },
      ),
    );
    n.normalize(result({ parent_tool_use_id: "parent" }));
    expect(
      n.normalize(
        stream({
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "main output" },
        }),
      )[0],
    ).toMatchObject({
      messageId: "main",
      attribution: { parentToolUseId: null },
    });
    expect(n.normalize(result({ uuid: "main-result" }))[0]).toMatchObject({
      status: "success",
    });
  });

  it.each([
    ["system", "api_retry", "retry"],
    ["system", "task_started", "task"],
    ["system", "task_updated", "task"],
    ["system", "task_notification", "task"],
    ["system", "hook_response", "hook"],
    ["system", "compact_boundary", "compaction"],
    ["system", "status", "status"],
    ["system", "conversation_reset", "reset"],
    ["user", undefined, "user-input"],
    ["tool_progress", undefined, "tool-progress"],
    ["rate_limit_event", undefined, "rate-limit"],
  ])("preserves %s/%s progress and attribution", (type, subtype, family) => {
    const n = make();
    expect(
      n.normalize({
        type,
        subtype,
        session_id: "session",
        task_id: "task",
        parent_tool_use_id: "parent",
        agent_id: "agent",
        tool_use_id: "tool",
        attempt: 2,
      })[0],
    ).toMatchObject({
      type: "observation",
      family,
      attribution: {
        claudeSessionId: "session",
        taskId: "task",
        parentToolUseId: "parent",
        agentId: "agent",
        toolUseId: "tool",
      },
    });
    expect(n.normalize(result())[0]).toMatchObject({ status: "success" });
  });

  it("bounds and sanitizes unknown diagnostics without leaking optional payload values", () => {
    const n = make();
    const unknown = n.normalize({
      type: "future",
      subtype: "new",
      api_key: "secret",
      payload: "private",
      many: "x".repeat(10000),
    });
    expect(JSON.stringify(unknown)).not.toContain("private");
    expect(JSON.stringify(unknown)).not.toContain("secret");
    expect(JSON.stringify(unknown).length).toBeLessThan(1000);
    const known = n.normalize({
      type: "system",
      subtype: "task_progress",
      task_id: "task",
      env: { SECRET: "private" },
      description: "Bearer credential",
      content: "x".repeat(10000),
    });
    expect(JSON.stringify(known)).not.toContain("private");
    expect(JSON.stringify(known)).not.toContain("credential");
    expect(JSON.stringify(known).length).toBeLessThan(5000);
  });

  it("fails malformed required IDs and typed values without approving an uncorrelated action", () => {
    const n = make();
    for (const payload of [
      null,
      {},
      { type: "assistant", message: { content: [] } },
      stream({ type: "message_start", message: {} }),
      result({ is_error: "false" }),
    ])
      expect(n.normalize(payload)[0]).toMatchObject({
        type: "session_error",
        error: { code: "protocol" },
      });
    expect(
      n.normalize(
        snapshot("m", "a", [
          { type: "tool_use", name: "mcp__host__read", input: {} },
        ]),
      )[0],
    ).toMatchObject({
      type: "session_error",
      error: { code: "tool-correlation" },
    });
    n.normalize(stream({ type: "message_start", message: { id: "m" } }));
    expect(
      n.normalize(
        stream({
          type: "content_block_start",
          index: -1,
          content_block: { type: "text", text: "" },
        }),
      )[0],
    ).toMatchObject({ type: "session_error" });
    expect(
      n.normalize(
        stream({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "bad" },
        }),
      )[0],
    ).toMatchObject({ type: "session_error" });
  });
  it.each([
    null,
    { type: "text", text: 42 },
    { type: "thinking", thinking: 42 },
    { type: "redacted_thinking", data: 42 },
    { type: "image", source: { type: "url", url: "https://example.invalid" } },
  ])(
    "rejects a malformed assistant block %j without forwarding raw data",
    (block) => {
      expect(
        make().normalize(snapshot("m", "frame", [block]))[0],
      ).toMatchObject({ type: "session_error", error: { code: "protocol" } });
    },
  );

  it("keeps unknown optional content as a bounded diagnostic while valid blocks survive", () => {
    const events = make().normalize(
      snapshot("m", "frame", [
        { type: "future_block", private_payload: "secret" },
        { type: "text", text: "valid" },
      ]),
    );
    expect(events[0]).toMatchObject({
      type: "observation",
      subtype: "unknown-content",
      data: { type: "future_block" },
    });
    expect(events[1]).toMatchObject({
      type: "assistant_snapshot",
      content: [{ type: "text", text: "valid" }],
      contentIndexes: [1],
    });
    expect(JSON.stringify(events)).not.toContain("private_payload");
  });

  it("rejects invalid and cyclic JSON arguments while preserving nested valid schemas", () => {
    const invalid: Record<string, unknown> = {};
    invalid.self = invalid;
    for (const input of [
      { invalid: undefined },
      { invalid: Number.NaN },
      invalid,
    ])
      expect(
        make().normalize(
          snapshot("m", "a", [
            { type: "tool_use", id: "a", name: "mcp__host__read", input },
          ]),
        )[0],
      ).toMatchObject({ error: { code: "tool-correlation" } });
    const events = make().normalize(
      snapshot("m", "b", [
        {
          type: "tool_use",
          id: "a",
          name: "mcp__host__read",
          input: { nested: [true, null, 1, { path: "file" }] },
        },
      ]),
    );
    expect(events[0]).toMatchObject({
      content: [{ arguments: { nested: [true, null, 1, { path: "file" }] } }],
    });
  });

  it("reports malformed MCP server rows alongside valid initialization metadata", () => {
    const events = make().normalize({
      type: "system",
      subtype: "init",
      session_id: "session",
      model: "model",
      claude_code_version: "2.1.285",
      tools: [],
      mcp_servers: [
        null,
        { name: "missing-status" },
        { name: "host", status: "connected" },
      ],
    });
    expect(events[0]).toMatchObject({
      type: "initialized",
      mcpServers: [{ name: "host", status: "connected" }],
    });
    expect(
      events.filter((event) => event.type === "session_error"),
    ).toHaveLength(2);
  });

  it("rejects malformed stream envelopes and allows pings without an active message", () => {
    const n = make();
    expect(n.normalize(stream(null))[0]).toMatchObject({
      error: { code: "protocol" },
    });
    expect(n.normalize(stream({ type: "ping" }))).toEqual([]);
    expect(
      n.normalize(stream({ type: "content_block_stop", index: 0 }))[0],
    ).toMatchObject({ error: { code: "protocol" } });
    n.normalize(stream({ type: "message_start", message: { id: "m" } }));
    expect(
      n.normalize(stream({ type: "message_start", message: { id: "m" } })),
    ).toEqual([]);
    expect(
      n.normalize(stream({ type: "content_block_stop", index: 0 }))[0],
    ).toMatchObject({ error: { code: "protocol" } });
    expect(
      n.normalize(stream({ type: "future_stream", private: "secret" }))[0],
    ).toMatchObject({ type: "observation", subtype: "unknown-event" });
  });

  it("keeps tool JSON deltas and doesn't convert native or child tool blocks into host content", () => {
    const n = make();
    n.normalize(stream({ type: "message_start", message: { id: "m" } }));
    const start = stream({
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "tool_use",
        id: "a",
        name: "mcp__host__read",
        input: {},
      },
    });
    n.normalize(start);
    expect(n.normalize(start)).toEqual([]);
    expect(
      n.normalize(
        stream({
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"path":"file"}' },
        }),
      )[0],
    ).toMatchObject({
      type: "content_delta",
      delta: { kind: "tool-input", partialJson: '{"path":"file"}' },
    });
    expect(
      n.normalize(
        snapshot("m", "completed", [
          {
            type: "tool_use",
            id: "a",
            name: "mcp__host__read",
            input: { path: "file" },
          },
        ]),
      )[0],
    ).toMatchObject({ type: "assistant_snapshot", contentIndexes: [0] });
    n.normalize(
      stream({
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "tool_use",
          id: "native",
          name: "Read",
          input: {},
        },
      }),
    );
    expect(
      n.normalize(
        stream({
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: "{}" },
        }),
      ),
    ).toEqual([]);
    expect(
      n.normalize(stream({ type: "content_block_stop", index: 1 })),
    ).toEqual([]);
    expect(
      n.normalize(stream({ type: "content_block_stop", index: 1 })),
    ).toEqual([]);
  });

  it("records unknown delta kinds without losing later valid text", () => {
    const n = make();
    n.normalize(stream({ type: "message_start", message: { id: "m" } }));
    n.normalize(
      stream({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
    );
    expect(
      n.normalize(
        stream({
          type: "content_block_delta",
          index: 0,
          delta: { type: "future_delta", secret: "private" },
        }),
      )[0],
    ).toMatchObject({
      subtype: "unknown-delta",
      data: { type: "future_delta" },
    });
    expect(
      n.normalize(
        stream({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "valid" },
        }),
      )[0],
    ).toMatchObject({ delta: { text: "valid" } });
  });

  it.each(["authentication_failed", "max_output_tokens"])(
    "maps assistant error %s with sanitized actionable text",
    (subtype) => {
      const events = make().normalize(
        snapshot(
          "m",
          "frame",
          [{ type: "text", text: "token=private failure" }],
          { error: subtype },
        ),
      );
      expect(events[1]).toMatchObject({
        type: "session_error",
        error: {
          code: subtype === "authentication_failed" ? "auth" : "runtime",
          subtype,
          message: "token=[redacted] failure",
        },
      });
      expect(
        make().normalize(snapshot("m", "empty", [], { error: subtype }))[0],
      ).toMatchObject({
        type: "session_error",
        error: { subtype, message: subtype },
      });
    },
  );

  it("dedupes full snapshots without a frame UUID and preserves supersession references", () => {
    const n = make(),
      raw = {
        type: "assistant",
        session_id: "session",
        message: {
          id: "m",
          content: [{ type: "text", text: "same" }],
          stop_reason: "end_turn",
        },
      };
    expect(n.normalize(raw).map((event) => event.type)).toEqual([
      "assistant_snapshot",
      "message_end",
      "observation",
    ]);
    expect(n.normalize(raw)).toMatchObject([
      {
        type: "observation",
        subtype: "core-assistant-snapshot",
        data: { ended: true, snapshotKnownMessage: true },
      },
    ]);
    expect(
      n.normalize({
        ...raw,
        message: { ...raw.message, id: "replacement" },
        uuid: "new",
        supersedes: ["old"],
      })[0],
    ).toMatchObject({ supersedes: ["old"] });
  });

  it("retains agent-only child attribution and isolates its message and result state", () => {
    const n = make();
    const events = n.normalize(
      snapshot(
        "child",
        "frame",
        [{ type: "tool_use", id: "a", name: "mcp__host__read", input: {} }],
        { agent_id: "child-agent", turn_id: "child-turn" },
      ),
    );
    expect(
      events.filter(
        (event) =>
          event.type === "observation" &&
          event.subtype === "claude-tool-proposal",
      ),
    ).toMatchObject([
      {
        type: "observation",
        data: { owner: "subagent" },
        attribution: { agentId: "child-agent", turnId: "child-turn" },
      },
    ]);
    expect(
      n.normalize(
        result({
          agent_id: "child-agent",
          uuid: undefined,
          user_message_uuid: "child-turn",
        }),
      )[0],
    ).toMatchObject({ status: "success" });
    expect(
      n.normalize(result({ uuid: undefined, result_index: 0 }))[0],
    ).toMatchObject({ status: "success" });
  });

  it("requires canonical progress IDs and records authentication status", () => {
    for (const raw of [
      { type: "tool_progress" },
      { type: "system", subtype: "task_started" },
      { type: "system" },
    ])
      expect(make().normalize(raw)[0]).toMatchObject({ type: "session_error" });
    expect(
      make().normalize({ type: "auth_status", isAuthenticating: true })[0],
    ).toMatchObject({ type: "observation", subtype: "auth_status" });
  });

  it("bounds deep progress diagnostics and normalizes invalid usage scalars", () => {
    const n = make();
    let deep: Record<string, unknown> = { text: "private" };
    for (let i = 0; i < 8; i++) deep = { child: deep };
    const events = n.normalize({
      type: "system",
      subtype: "task_progress",
      task_id: "task",
      deep,
      values: [true, null, Number.NaN],
      big: Object.fromEntries(
        Array.from({ length: 32 }, (_, i) => [
          String(i).padEnd(80, "x"),
          "x".repeat(512),
        ]),
      ),
    });
    expect(JSON.stringify(events).length).toBeLessThan(6000);
    expect(JSON.stringify(events)).not.toContain("private");
    const report = n.normalize(
      result({
        usage: {
          input_tokens: Number.NaN,
          output_tokens: -1,
          cache_read_input_tokens: 3,
          cache_creation_input_tokens: 2,
          reasoning_tokens: 4,
        },
        total_cost_usd: 0.1,
      }),
    );
    expect(report[0]).toMatchObject({
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 3,
        cacheWriteTokens: 2,
        reasoningTokens: 4,
        costUsd: 0.1,
      },
    });
  });
});
