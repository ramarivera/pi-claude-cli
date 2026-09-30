import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  createSdkDriver,
  type SdkQueryFactory,
} from "../../../src/drivers/sdk/index.js";
import { AsyncQueue } from "../../../src/drivers/sdk/queue.js";
import type {
  ClaudeDriverEvent,
  ClaudeDriverSession,
  DriverSessionRequest,
  HostToolResult,
  ToolDefinition,
  UnsequencedClaudeDriverEvent,
} from "../../../src/contracts/index.js";

const owned: { session: ClaudeDriverSession; client: Client }[] = [];
afterEach(async () => {
  for (const { session, client } of owned.splice(0)) {
    await session.close();
    await client.close();
  }
  vi.restoreAllMocks();
});

function tool(name = "edit"): ToolDefinition {
  return {
    name,
    owner: "host",
    description: "Host native edit",
    title: "Native edit",
    annotations: { destructiveHint: true, customHint: "native" },
    _meta: { origin: "offline-host" },
    inputSchema: {
      type: "object",
      properties: {
        edits: {
          type: "array",
          items: {
            anyOf: [
              {
                type: "object",
                properties: {
                  op: { const: "replace" },
                  anchor: { type: "string", pattern: "^[0-9]+#[A-Z]+$" },
                },
                required: ["op", "anchor"],
                additionalProperties: false,
              },
              {
                type: "object",
                properties: { op: { const: "delete" } },
                required: ["op"],
              },
            ],
          },
        },
      },
      required: ["edits"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { count: { type: "integer" } },
      required: ["count"],
    },
  };
}

function request(tools = [tool()], timeoutMs = 1000): DriverSessionRequest {
  return {
    identity: {
      sessionId: "host",
      branchId: "main",
      historyRevision: "r1",
      driver: "sdk",
      cwd: "/tmp/offline-host",
      configurationDigest: "offline",
      history: { messages: [], messageDigests: [], digest: "empty" },
    },
    resume: { mode: "fresh", restoration: "none", reason: "offline" },
    model: "offline-model",
    systemPrompt: "offline",
    tools,
    settings: {
      toolResultTimeoutMs: timeoutMs,
      claudeTools: [],
      userMcpServers: [],
    },
    auth: { mode: "claude-login" },
  };
}

const env = {
  ANTHROPIC_API_KEY: undefined,
  ANTHROPIC_AUTH_TOKEN: undefined,
  ANTHROPIC_BASE_URL: undefined,
  CLAUDE_CODE_OAUTH_TOKEN: undefined,
  CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: undefined,
  CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR: undefined,
  CLAUDE_CODE_API_KEY_HELPER: undefined,
  CLAUDE_CODE_USE_BEDROCK: undefined,
  CLAUDE_CODE_USE_VERTEX: undefined,
  CLAUDE_CODE_USE_FOUNDRY: undefined,
};

/** Official MCP client/server protocol; only the inference query is an offline double. */
async function open(r = request()) {
  const output = new AsyncQueue<unknown>();
  let options!: Options;
  let input!: AsyncIterator<SDKUserMessage>;
  const interrupt = vi.fn(async () => undefined);
  const close = vi.fn(() => output.end());
  const query: SdkQueryFactory = (params) => {
    options = params.options;
    input = params.prompt[Symbol.asyncIterator]();
    return {
      [Symbol.asyncIterator]: () => output[Symbol.asyncIterator](),
      interrupt,
      close,
    };
  };
  const session = await createSdkDriver({
    environment: env,
    query,
    normalizerFactory: () => ({
      normalize: (message) => [message as UnsequencedClaudeDriverEvent],
    }),
    shutdownTimeoutMs: 100,
  }).openSession(r);
  const client = new Client(
    { name: "offline-sdk-client", version: "1.0.0" },
    { capabilities: {} },
  );
  owned.push({ session, client });
  const host = options.mcpServers?.host;
  if (!host || host.type !== "sdk")
    throw new Error("Host MCP endpoint missing");
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const wire = vi.spyOn(serverTransport, "send");
  await host.instance.connect(serverTransport);
  await client.connect(clientTransport);
  const events = session.events[Symbol.asyncIterator]();
  const call = (
    id: string | undefined,
    name = r.tools[0]?.name ?? "edit",
    args = { edits: [{ op: "replace", anchor: "1#AB" }] },
  ) =>
    client.request(
      {
        method: "tools/call",
        params: {
          name,
          arguments: args,
          _meta: id === undefined ? undefined : { "claudecode/toolUseId": id },
        },
      },
      CallToolResultSchema,
      { timeout: 2000 },
    );
  return {
    session,
    client,
    options,
    events,
    output,
    input,
    interrupt,
    close,
    call,
    host,
    wire,
  };
}

function result(id: string, name = "edit"): HostToolResult {
  return {
    toolCallId: id,
    toolName: name,
    isError: false,
    content: [{ type: "text", text: `result:${id}` }],
    structuredContent: { count: 1 },
    _meta: { presentation: { id } },
    details: { privateHostDetail: true },
  };
}
async function nextEvent(
  events: AsyncIterator<ClaudeDriverEvent>,
  type: ClaudeDriverEvent["type"],
) {
  const event = (await events.next()).value;
  expect(event?.type).toBe(type);
  if (event?.type === "host_tool_request") {
    const observation = (await events.next()).value;
    expect(observation).toEqual({
      type: "observation",
      family: "diagnostic",
      subtype: "host-mcp-park",
      sequence: event.sequence + 1,
      attribution: event.attribution,
      data: {
        toolUseId: event.call.id,
        toolName: event.call.name,
        serverName: "host",
      },
    });
  }
  return event;
}

describe("SDK host tool handoff (offline query, real MCP protocol)", () => {
  it("preserves full native schema and tool metadata without a schema-library round trip", async () => {
    const t = await open();
    const listing = await t.client.listTools();
    // The MCP client's schema strips unknown annotation keys; verify the exact wire result too.
    const nativeListing = [
      {
        name: tool().name,
        description: tool().description,
        title: tool().title,
        inputSchema: tool().inputSchema,
        outputSchema: tool().outputSchema,
        annotations: tool().annotations,
        _meta: tool()._meta,
      },
    ];
    expect(
      t.wire.mock.calls.some(
        ([frame]) =>
          "result" in frame &&
          JSON.stringify(frame.result) ===
            JSON.stringify({ tools: nativeListing }),
      ),
    ).toBe(true);
    expect(listing.tools).toEqual([
      { ...nativeListing[0], annotations: { destructiveHint: true } },
    ]);
    expect(t.options.tools).toEqual([]);
    expect(t.options.allowedTools).toEqual(["mcp__host__edit"]);
    expect(t.options.env?.MCP_TOOL_TIMEOUT).toBe("1000");
    expect(t.host.timeout).toBe(1000);
  });

  it("parks once, ignores proposal-only requests and matches parallel results in reverse order", async () => {
    const t = await open();
    t.output.push({
      type: "host_tool_request",
      call: {
        type: "tool_call",
        id: "proposal-only",
        name: "edit",
        arguments: {},
      },
      attribution: {},
    });
    const first = t.call("claude-a");
    const second = t.call("claude-b");
    const firstEvent = await nextEvent(t.events, "host_tool_request");
    const secondEvent = await nextEvent(t.events, "host_tool_request");
    expect(firstEvent).toMatchObject({
      call: { id: "claude-a" },
      sequence: 1,
      attribution: { toolUseId: "claude-a" },
    });
    expect(secondEvent).toMatchObject({
      call: { id: "claude-b" },
      sequence: 3,
    });
    const settledA = vi.fn();
    const settledB = vi.fn();
    first.then(settledA);
    second.then(settledB);
    await t.session.deliverToolResults([result("claude-b")]);
    expect(await second).toMatchObject({
      content: [{ text: "result:claude-b" }],
      structuredContent: { count: 1 },
      _meta: { presentation: { id: "claude-b" } },
      isError: false,
    });
    expect(settledA).not.toHaveBeenCalled();
    await t.session.deliverToolResults([result("claude-a")]);
    expect(await first).toMatchObject({
      content: [{ text: "result:claude-a" }],
    });
    expect(settledB).toHaveBeenCalledOnce();
    const duplicate = t.call("claude-a");
    expect(await duplicate).toMatchObject({
      content: [{ text: "result:claude-a" }],
    });
    await t.session.close();
    expect((await t.events.next()).value?.type).toBe("session_closed");
  });

  it("accepts early results and identical duplicates, including object-key reordering", async () => {
    const t = await open();
    const early = result("early");
    await t.session.deliverToolResults([
      early,
      { ...early, _meta: { presentation: { id: "early" } } },
    ]);
    const pending = t.call("early");
    expect(await nextEvent(t.events, "host_tool_request")).toMatchObject({
      call: { id: "early" },
    });
    expect(await pending).toMatchObject({
      isError: false,
      content: early.content,
      structuredContent: early.structuredContent,
      _meta: early._meta,
    });
    await t.session.deliverToolResults([
      {
        _meta: early._meta,
        structuredContent: early.structuredContent,
        content: early.content,
        isError: false,
        toolName: early.toolName,
        toolCallId: early.toolCallId,
        details: early.details,
      },
    ]);
    await expect(
      t.session.deliverToolResults([
        { ...early, content: [{ type: "text", text: "conflicting" }] },
      ]),
    ).rejects.toThrow("Conflicting duplicate");
  });

  it("rejects an entire conflicting result batch before resolving any parked call", async () => {
    const t = await open();
    const pending = t.call("pending");
    await nextEvent(t.events, "host_tool_request");
    await t.session.deliverToolResults([result("earlier")]);
    const resolved = vi.fn();
    pending.then(resolved);
    await expect(
      t.session.deliverToolResults([
        result("pending"),
        { ...result("earlier"), isError: true },
      ]),
    ).rejects.toThrow("Conflicting duplicate");
    await Promise.resolve();
    expect(resolved).not.toHaveBeenCalled();
    await t.session.deliverToolResults([result("pending")]);
    await pending;
  });

  it.each([undefined, "", "   "])(
    "fails a call with missing or empty metadata ID %s instead of using JSON-RPC IDs",
    async (id) => {
      const t = await open();
      expect(await t.call(id)).toMatchObject({
        isError: true,
        content: [{ text: expect.stringContaining("claudecode/toolUseId") }],
      });
      expect(await nextEvent(t.events, "session_error")).toMatchObject({
        error: { code: "tool-correlation" },
      });
      await t.session.close();
      expect((await t.events.next()).value?.type).toBe("session_closed");
    },
  );

  it("shares duplicate parked calls but rejects reuse with different arguments", async () => {
    const t = await open();
    const one = t.call("same");
    const identical = t.call("same");
    const proposal = await nextEvent(t.events, "host_tool_request");
    if (proposal?.type === "host_tool_request")
      proposal.call.arguments = { modifiedByHost: true };
    expect(
      await t.call("same", "edit", {
        edits: [{ op: "replace", anchor: "2#CD" }],
      }),
    ).toMatchObject({ isError: true });
    expect(await nextEvent(t.events, "session_error")).toMatchObject({
      error: { code: "tool-correlation" },
    });
    await t.session.deliverToolResults([result("same")]);
    expect(await one).toEqual(await identical);
    await t.session.close();
    expect((await t.events.next()).value?.type).toBe("session_closed");
  });

  it("settles parked calls as errors on interrupt and keeps followup inference usable", async () => {
    const t = await open();
    const pending = t.call("cancelled");
    await nextEvent(t.events, "host_tool_request");
    await t.session.interrupt();
    expect(await pending).toMatchObject({
      isError: true,
      content: [{ text: expect.stringContaining("cancelled") }],
    });
    expect(t.interrupt).toHaveBeenCalledOnce();
    const ack = t.session.submitPrompt({
      turnId: "following",
      content: [{ type: "text", text: "continue" }],
    });
    expect((await t.input.next()).value?.message.content).toEqual([
      { type: "text", text: "continue" },
    ]);
    const nextInput = t.input.next();
    await ack;
    t.output.push({
      type: "turn_end",
      status: "success",
      subtype: "success",
      isError: false,
      attribution: {},
    });
    expect(await nextEvent(t.events, "turn_end")).toMatchObject({
      attribution: { turnId: "following" },
    });
    await t.session.close();
    await nextInput;
  });

  it("bounds parked calls independently of the MCP runtime timeout", async () => {
    const t = await open(request([tool()], 20));
    expect(t.host.timeout).toBe(1000);
    expect(t.options.env?.MCP_TOOL_TIMEOUT).toBe("20");
    const pending = t.call("timeout");
    await nextEvent(t.events, "host_tool_request");
    expect(await pending).toMatchObject({
      isError: true,
      content: [{ text: "Host tool result deadline expired" }],
    });
    expect(await nextEvent(t.events, "session_error")).toMatchObject({
      error: { code: "timeout" },
    });
  });

  it("settles a query-close race and drains host handler timers", async () => {
    const t = await open();
    const pending = t.call("closing");
    const receipt = pending.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await nextEvent(t.events, "host_tool_request");
    await Promise.all([t.session.close(), t.session.close()]);
    const response = await receipt;
    expect(response).toHaveProperty("value.isError", true);
    expect(t.close).toHaveBeenCalledOnce();
    expect((await t.events.next()).value).toMatchObject({
      type: "session_closed",
      reason: "closed",
    });
    expect(await t.events.next()).toMatchObject({ done: true });
  });

  it("cancels a handler when its MCP request is aborted and retains the cancelled ID", async () => {
    const t = await open();
    const controller = new AbortController();
    const pending = t.client.request(
      {
        method: "tools/call",
        params: {
          name: "edit",
          arguments: { edits: [{ op: "replace", anchor: "1#AB" }] },
          _meta: { "claudecode/toolUseId": "mcp-aborted" },
        },
      },
      CallToolResultSchema,
      { signal: controller.signal, timeout: 2000 },
    );
    const rejected = expect(pending).rejects.toThrow("offline cancelled");
    await nextEvent(t.events, "host_tool_request");
    controller.abort(new Error("offline cancelled"));
    await rejected;
    expect(await t.call("mcp-aborted")).toMatchObject({
      isError: true,
      content: [{ text: "Host tool call cancelled" }],
    });
    await expect(
      t.session.deliverToolResults([result("mcp-aborted")]),
    ).rejects.toThrow("Conflicting duplicate");
    await t.session.close();
    expect((await t.events.next()).value?.type).toBe("session_closed");
  });

  it("isolates sessions and takes a fresh schema snapshot when the inventory changes", async () => {
    const original = tool("one");
    const t1 = await open(request([original]));
    original.inputSchema.properties = { nextVersion: { type: "boolean" } };
    const t2 = await open(request([original, tool("two")]));
    expect((await t1.client.listTools()).tools[0].inputSchema).toEqual(
      tool().inputSchema,
    );
    expect((await t2.client.listTools()).tools[0].inputSchema).toEqual(
      original.inputSchema,
    );
    const p1 = t1.call("same-id", "one");
    const p2 = t2.call("same-id", "two");
    await nextEvent(t1.events, "host_tool_request");
    await nextEvent(t2.events, "host_tool_request");
    await t1.session.deliverToolResults([result("same-id", "one")]);
    expect(await p1).toMatchObject({ isError: false });
    const resolved = vi.fn();
    p2.then(resolved);
    await Promise.resolve();
    expect(resolved).not.toHaveBeenCalled();
    await t2.session.deliverToolResults([result("same-id", "two")]);
    await p2;
  });

  it("keeps explicit native and user MCP owners outside host tool execution", async () => {
    const r = request();
    r.settings.claudeTools = ["Read"];
    r.settings.userMcpServers = [
      {
        name: "external",
        config: {
          type: "http",
          url: "https://example.invalid/mcp",
          headers: { "X-Offline": "true" },
        },
      },
    ];
    const t = await open(r);
    expect(t.options.tools).toEqual(["Read"]);
    expect(t.options.mcpServers?.external).toEqual({
      type: "http",
      url: "https://example.invalid/mcp",
      headers: { "X-Offline": "true" },
    });
    expect(
      await t.options.canUseTool!(
        "mcp__host__edit",
        { edits: [] },
        {
          signal: new AbortController().signal,
          requestId: "owned",
          toolUseID: "native-id",
          mcpServer: { name: "host", source: "sdk" },
        },
      ),
    ).toEqual({ behavior: "allow", updatedInput: { edits: [] } });
    const permission = t.options.canUseTool!(
      "mcp__host__edit",
      { edits: [] },
      {
        signal: new AbortController().signal,
        requestId: "untrusted",
        toolUseID: "external-id",
        mcpServer: { name: "host", source: "user" },
      },
    );
    const event = await nextEvent(t.events, "interaction_request");
    expect(event).toMatchObject({
      request: {
        kind: "permission",
        toolUseId: "external-id",
        mcpServer: { source: "user" },
      },
    });
    await t.session.answerInteraction({
      kind: "permission",
      requestId: "untrusted",
      decision: { behavior: "deny", message: "denied" },
    });
    await expect(permission).resolves.toMatchObject({ behavior: "deny" });
    await expect(
      t.session.deliverToolResults([result("external-id", "external_tool")]),
    ).rejects.toThrow("exposed tool name");
  });

  it("preserves every supported result content type and reports resource schema mistakes", async () => {
    const t = await open();
    const r = result("content");
    r.content = [
      { type: "text", text: "text" },
      { type: "image", mimeType: "image/png", data: "AA==" },
      { type: "audio", mimeType: "audio/wav", data: "AA==" },
      {
        type: "resource",
        resource: {
          uri: "test://resource",
          text: "document",
          _meta: { foo: "bar" },
        },
      },
      {
        type: "resource_link",
        uri: "test://link",
        name: "link",
        title: "File",
        size: 2,
      },
    ];
    await t.session.deliverToolResults([r]);
    const pending = t.call("content");
    await nextEvent(t.events, "host_tool_request");
    expect(await pending).toMatchObject({
      content: r.content,
      structuredContent: r.structuredContent,
      _meta: r._meta,
    });
    await expect(
      t.session.deliverToolResults([
        {
          ...result("invalid"),
          content: [
            { type: "resource", resource: { uri: "test://missing-content" } },
          ],
        },
      ]),
    ).rejects.toThrow();
  });
});
