import { describe, expect, it } from "vitest";
import {
  CONTRACT_VERSION,
  type ClaudeDriverSession,
  type ClaudeRoundEvent,
  type DriverSessionRequest,
  type HostRoundRequest,
  type HostToolCall,
  type HostToolResult,
  type SessionIdentity,
  type ToolDefinition,
} from "../../src/contracts/index.js";
import { resolveResumePlan } from "../../src/contracts/resume.js";
import {
  ContractSessionDouble,
  createCliContractDouble,
  createSdkContractDouble,
  ompHostContractDouble,
  piHostContractDouble,
} from "./doubles.js";

const tools: ToolDefinition[] = [
  {
    name: "edit",
    owner: "host",
    description: "Nested schema preservation fixture",
    inputSchema: {
      type: "object",
      properties: {
        edits: {
          type: "array",
          items: {
            type: "object",
            properties: {
              pos: { type: "string", pattern: "^[0-9]+#.+$" },
              op: { const: "replace" },
            },
            required: ["pos", "op"],
          },
        },
      },
      required: ["edits"],
      additionalProperties: false,
    },
    _meta: { "anthropic/alwaysLoad": true },
  },
];

function identity(overrides: Partial<SessionIdentity> = {}): SessionIdentity {
  return {
    sessionId: "host-session",
    branchId: "root",
    historyRevision: "0",
    driver: "cli",
    cwd: "/sandbox",
    configurationDigest: "effective-config",
    claudeSessionId: "claude-session",
    history: {
      messages: [
        { role: "user", content: [{ type: "text", text: "prior turn" }] },
      ],
      messageDigests: ["prior-hash"],
      digest: "prior-history-hash",
    },
    ...overrides,
  };
}

function round(): HostRoundRequest {
  return {
    roundId: "host-round-1",
    session: {
      sessionId: "host-session",
      branchId: "root",
      historyRevision: "0",
    },
    cwd: "/sandbox",
    model: "claude-test",
    systemPrompt: "Use host tools.",
    tools,
    transcript: [],
    input: { kind: "prompt", content: [{ type: "text", text: "go" }] },
    settings: {
      toolResultTimeoutMs: 30_000,
      claudeTools: [],
      userMcpServers: [],
    },
    auth: { mode: "claude-login" },
  };
}

function sessionRequest(): DriverSessionRequest {
  const request = round();
  return {
    identity: identity({
      history: { messages: [], messageDigests: [], digest: "empty" },
    }),
    resume: { mode: "fresh", restoration: "none", reason: "initial turn" },
    model: request.model,
    systemPrompt: request.systemPrompt,
    tools: request.tools,
    settings: request.settings,
    auth: request.auth,
  };
}

function call(id: string): HostToolCall {
  return { type: "tool_call", id, name: "edit", arguments: { edits: [] } };
}
function result(id: string): HostToolResult {
  return {
    toolCallId: id,
    toolName: "edit",
    content: [{ type: "text", text: id }],
    isError: false,
    structuredContent: { id, count: 1 },
    _meta: { preserved: true },
  };
}

describe.each([
  ["cli", createCliContractDouble],
  ["sdk", createSdkContractDouble],
] as const)("%s public driver contract (offline double)", (kind, factory) => {
  it("keeps parked calls alive across provider rounds and pairs reverse-order completions", async () => {
    const driver = factory();
    expect(driver.kind).toBe(kind);
    expect(driver.capabilities.contractVersion).toBe(CONTRACT_VERSION);
    const session: ClaudeDriverSession =
      await driver.openSession(sessionRequest());
    expect(session).toBeInstanceOf(ContractSessionDouble);
    if (!(session instanceof ContractSessionDouble))
      throw new Error("expected offline double");
    const pump = session.events[Symbol.asyncIterator]();
    await session.submitPrompt({
      turnId: "claude-turn-1",
      content: [{ type: "text", text: "go" }],
    });
    expect((await pump.next()).value?.type).toBe("initialized");
    const first = session.requestHostTool(call("toolu-a"));
    const second = session.requestHostTool(call("toolu-b"));
    expect((await pump.next()).value?.type).toBe("host_tool_request");
    expect((await pump.next()).value?.type).toBe("host_tool_request");
    // The host round ended; the same event pump and parked MCP calls survive.
    let settled = false;
    void first.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await session.deliverToolResults([result("toolu-b"), result("toolu-a")]);
    expect(await first).toEqual(result("toolu-a"));
    expect(await second).toEqual(result("toolu-b"));
    await session.deliverToolResults([result("toolu-a")]);
    expect(session.delivered.map((value) => value.toolCallId)).toEqual([
      "toolu-b",
      "toolu-a",
    ]);
    session.finishTurn();
    expect((await pump.next()).value?.type).toBe("turn_end");
    await session.submitPrompt({
      turnId: "claude-turn-2",
      content: [{ type: "text", text: "next" }],
    });
    expect((await pump.next()).value?.sequence).toBe(5);
    expect(session.prompts).toEqual(["claude-turn-1", "claude-turn-2"]);
    await session.close();
    expect((await pump.next()).value?.type).toBe("session_closed");
    expect((await pump.next()).done).toBe(true);
  });

  it("accepts results before MCP handlers and cancels all parked calls truthfully", async () => {
    const session = await factory().openSession(sessionRequest());
    if (!(session instanceof ContractSessionDouble))
      throw new Error("expected offline double");
    await session.deliverToolResults([result("toolu-early")]);
    expect(await session.requestHostTool(call("toolu-early"))).toEqual(
      result("toolu-early"),
    );
    const a = session.requestHostTool(call("toolu-a"));
    const b = session.requestHostTool(call("toolu-b"));
    await session.interrupt("host abort");
    expect((await a).isError).toBe(true);
    expect((await b).isError).toBe(true);
    expect((await a).content).toEqual([{ type: "text", text: "host abort" }]);
    await session.close();
    await session.close();
    await expect(
      session.submitPrompt({ turnId: "late", content: [] }),
    ).rejects.toThrow("closed");
  });

  it("fails missing canonical IDs rather than guessing order", async () => {
    const session = await factory().openSession(sessionRequest());
    if (!(session instanceof ContractSessionDouble))
      throw new Error("expected offline double");
    await expect(session.requestHostTool(call(""))).rejects.toThrow(
      "authoritative",
    );
    await expect(session.deliverToolResults([result("")])).rejects.toThrow(
      "uncorrelated",
    );
    await session.close();
  });
});

describe("host-neutral adapter contract doubles", () => {
  it("preserves the effective native schema and round boundary through both adapters", () => {
    const request = round();
    const pi = piHostContractDouble.toRequest({
      host: "pi",
      providerRound: request,
    });
    const omp = ompHostContractDouble.toRequest({
      host: "omp",
      editFormat: "hashline",
      providerRound: request,
    });
    expect(pi.tools[0].inputSchema).toEqual(tools[0].inputSchema);
    expect(omp.tools[0]._meta).toEqual({ "anthropic/alwaysLoad": true });
    const event: ClaudeRoundEvent = {
      type: "round_end",
      roundId: request.roundId,
      reason: "toolUse",
      content: [call("toolu-a")],
      pendingToolCallIds: ["toolu-a"],
    };
    expect(piHostContractDouble.fromEvent(event)).toEqual(event);
    expect(ompHostContractDouble.fromEvent(event)).toEqual(event);
  });
});

describe("authoritative resume decisions", () => {
  it("continues only a matching resident identity and unchanged content prefix", () => {
    const previous = identity();
    const next = identity({
      history: {
        messages: [
          ...previous.history.messages,
          { role: "assistant", content: [{ type: "text", text: "done" }] },
        ],
        messageDigests: ["prior-hash", "native-assistant-hash"],
        digest: "next-hash",
      },
    });
    expect(
      resolveResumePlan(previous, next, {
        residentSessionId: "claude-session",
        acknowledgedAppendDigests: ["native-assistant-hash"],
      }).mode,
    ).toBe("resident");
    expect(
      resolveResumePlan(previous, next, { residentSessionId: "claude-session" })
        .mode,
    ).toBe("replay");
    const diverged = identity({
      history: { ...previous.history, messageDigests: ["changed-same-count"] },
    });
    expect(
      resolveResumePlan(previous, diverged, {
        residentSessionId: "claude-session",
      }).mode,
    ).toBe("replay");
  });

  it.each([
    { cwd: "/other" },
    { driver: "sdk" as const },
    { configurationDigest: "new-model-tools-system-auth-settings" },
    { historyRevision: "compacted" },
    { branchId: "other-branch" },
    { sessionId: "foreign-session" },
  ])("replays after identity/configuration changes %j", (change) => {
    const plan = resolveResumePlan(identity(), identity(change), {
      residentSessionId: "claude-session",
    });
    expect(plan.mode).toBe("replay");
    expect(plan.restoration).toBe("user-history-replay");
    expect("claudeSessionId" in plan).toBe(false);
  });

  it("does not infer persistence from host history or a remembered Claude ID", () => {
    expect(resolveResumePlan(undefined, identity(), {}).mode).toBe("replay");
    expect(resolveResumePlan(identity(), identity(), {}).mode).toBe("replay");
    expect(
      resolveResumePlan(identity(), identity(), {
        persistedSessionId: "wrong-id",
      }).mode,
    ).toBe("replay");
    expect(
      resolveResumePlan(identity(), identity(), {
        persistedSessionId: "claude-session",
      }).mode,
    ).toBe("resume");
    expect(
      resolveResumePlan(identity(), identity(), {
        residentSessionId: "claude-session",
        invalidated: "abort",
      }).mode,
    ).toBe("replay");
  });

  it("retains complete error results and images in replay without claiming native import", () => {
    const messages: SessionIdentity["history"]["messages"] = [
      { role: "assistant", content: [call("toolu-image")] },
      {
        role: "tool_result",
        ...result("toolu-image"),
        isError: true,
        content: [{ type: "image", data: "base64", mimeType: "image/png" }],
      },
    ];
    const next = identity({
      history: { messages, messageDigests: ["a", "b"], digest: "all" },
    });
    const plan = resolveResumePlan(undefined, next, {});
    expect(plan.mode).toBe("replay");
    if (plan.mode !== "replay") throw new Error("expected replay");
    expect(plan.replayTranscript).toEqual(messages);
  });
});
