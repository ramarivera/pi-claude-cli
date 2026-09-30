import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { DriverEventPayload } from "../../../src/contracts/index.js";
import { HostMcpBridge } from "../../../src/drivers/sdk/host-mcp.js";
import { AsyncQueue, withinDeadline } from "../../../src/drivers/sdk/queue.js";

/** Real official SDK and MCP endpoint; the executable is a no-inference runtime double. */
it("official SDK yields stream stop and snapshot frames while an MCP control request remains parked (offline runtime)", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pcc-sdk-offline-control-"));
  const prompts = new AsyncQueue<SDKUserMessage>();
  const events = new AsyncQueue<DriverEventPayload>();
  const bridge = new HostMcpBridge(
    [
      {
        name: "edit",
        owner: "host",
        description: "offline edit",
        inputSchema: {
          type: "object",
          properties: { input: { type: "string" }, i: { type: "string" } },
          required: ["input"],
        },
      },
    ],
    2000,
    (event) => events.push(event),
  );
  const runtime = query({
    prompt: prompts,
    options: {
      cwd,
      executable: "node",
      pathToClaudeCodeExecutable: fileURLToPath(
        new URL("./offline-query-control.mjs", import.meta.url),
      ),
      env: { PATH: process.env.PATH, HOME: cwd, CLAUDE_CONFIG_DIR: cwd },
      model: "offline-no-inference",
      tools: [],
      settingSources: [],
      strictMcpConfig: true,
      includePartialMessages: true,
      mcpServers: {
        host: {
          type: "sdk",
          name: "host",
          instance: bridge.server,
          timeout: 2000,
        },
      },
    },
  });
  const messages = runtime[Symbol.asyncIterator]();
  const parkedEvents = events[Symbol.asyncIterator]();
  const prompt = (text: string): SDKUserMessage => ({
    type: "user",
    parent_tool_use_id: null,
    message: { role: "user", content: [{ type: "text", text }] },
  });
  try {
    prompts.push(prompt("begin-offline-park"));
    const parked = (await withinDeadline(parkedEvents.next(), 2000)).value;
    expect(parked).toMatchObject({
      type: "host_tool_request",
      call: { id: "toolu_offline_park", name: "edit" },
    });
    const observation = (await parkedEvents.next()).value;
    expect(observation).toEqual({
      type: "observation",
      family: "diagnostic",
      subtype: "host-mcp-park",
      data: {
        toolUseId: "toolu_offline_park",
        toolName: "edit",
        serverName: "host",
      },
    });
    expect(JSON.stringify(observation)).not.toContain("private-offline");

    // This frame is emitted by the fake runtime only after the actual MCP handler parked.
    prompts.push(prompt("emit-after-park"));
    let sawStop = false;
    let sawSnapshot = false;
    while (!sawStop || !sawSnapshot) {
      const message = (await withinDeadline(messages.next(), 2000)).value;
      expect(message).toBeDefined();
      expect(message?.type).not.toBe("result");
      if (
        message?.type === "stream_event" &&
        message.event.type === "message_stop"
      )
        sawStop = true;
      if (message?.type === "assistant") sawSnapshot = true;
    }

    // No result was delivered to the host bridge before both frames reached the SDK iterator.
    bridge.deliver([
      {
        toolCallId: "toolu_offline_park",
        toolName: "edit",
        content: [{ type: "text", text: "offline result" }],
        isError: false,
      },
    ]);
    const result = (await withinDeadline(messages.next(), 2000)).value;
    expect(result).toMatchObject({
      type: "result",
      subtype: "success",
      result: "offline host result received",
    });
  } finally {
    bridge.cancel("offline test cleanup");
    prompts.end(true);
    runtime.close();
    await withinDeadline(
      Promise.all([messages.return?.(), bridge.forceClose()]),
      3000,
    );
    events.end();
    await rm(cwd, { recursive: true, force: true });
  }
});

it("official SDK and the owned draining MCP server park two same-endpoint requests before either result and resolve them in reverse order (offline runtime)", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pcc-sdk-offline-parallel-"));
  const prompts = new AsyncQueue<SDKUserMessage>();
  const events = new AsyncQueue<DriverEventPayload>();
  const bridge = new HostMcpBridge(
    [
      {
        name: "edit",
        owner: "host",
        description: "offline edit",
        inputSchema: {
          type: "object",
          properties: { input: { type: "string" } },
          required: ["input"],
        },
      },
      {
        name: "pcc_sentinel",
        owner: "host",
        description: "offline sentinel",
        inputSchema: { type: "object", properties: {} },
      },
    ],
    2000,
    (event) => events.push(event),
  );
  const runtime = query({
    prompt: prompts,
    options: {
      cwd,
      executable: "node",
      pathToClaudeCodeExecutable: fileURLToPath(
        new URL("./offline-query-control.mjs", import.meta.url),
      ),
      env: { PATH: process.env.PATH, HOME: cwd, CLAUDE_CONFIG_DIR: cwd },
      model: "offline-no-inference",
      tools: [],
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: {
        host: {
          type: "sdk",
          name: "host",
          instance: bridge.server,
          timeout: 2000,
        },
      },
    },
  });
  const messages = runtime[Symbol.asyncIterator]();
  const parkedEvents = events[Symbol.asyncIterator]();
  try {
    prompts.push({
      type: "user",
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [{ type: "text", text: "begin-offline-parallel" }],
      },
    });
    const parked = [];
    for (let index = 0; index < 4; index++)
      parked.push((await withinDeadline(parkedEvents.next(), 2000)).value);
    expect(parked).toMatchObject([
      {
        type: "host_tool_request",
        call: { id: "toolu_offline_edit", name: "edit" },
      },
      {
        type: "observation",
        subtype: "host-mcp-park",
        data: { toolUseId: "toolu_offline_edit" },
      },
      {
        type: "host_tool_request",
        call: { id: "toolu_offline_sentinel", name: "pcc_sentinel" },
      },
      {
        type: "observation",
        subtype: "host-mcp-park",
        data: { toolUseId: "toolu_offline_sentinel" },
      },
    ]);
    // Both actual handlers parked before either result was delivered to the bridge.
    expect((await withinDeadline(messages.next(), 2000)).value).toMatchObject({
      type: "system",
      subtype: "init",
    });
    bridge.deliver([
      {
        toolCallId: "toolu_offline_sentinel",
        toolName: "pcc_sentinel",
        content: [{ type: "text", text: "offline sentinel result" }],
        isError: false,
      },
    ]);
    expect((await withinDeadline(messages.next(), 2000)).value).toMatchObject({
      type: "system",
      subtype: "task_notification",
      task_id: "offline-complete-offline-parallel-b",
    });
    bridge.deliver([
      {
        toolCallId: "toolu_offline_edit",
        toolName: "edit",
        content: [{ type: "text", text: "offline edit result" }],
        isError: false,
      },
    ]);
    expect((await withinDeadline(messages.next(), 2000)).value).toMatchObject({
      type: "system",
      subtype: "task_notification",
      task_id: "offline-complete-offline-parallel-a",
    });
  } finally {
    bridge.cancel("offline test cleanup");
    prompts.end(true);
    runtime.close();
    await withinDeadline(
      Promise.all([messages.return?.(), bridge.forceClose()]),
      3000,
    );
    events.end();
    await rm(cwd, { recursive: true, force: true });
  }
});
