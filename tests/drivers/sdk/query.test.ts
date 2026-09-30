import { afterEach, describe, expect, it, vi } from "vitest";
import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
  ClaudeDriverSession,
  ClaudeEventNormalizerFactory,
  DriverSessionRequest,
  UnsequencedClaudeDriverEvent,
} from "../../../src/contracts/index.js";
import {
  createSdkDriver,
  type SdkQueryFactory,
} from "../../../src/drivers/sdk/index.js";
import { AsyncQueue } from "../../../src/drivers/sdk/queue.js";

const sessions: ClaudeDriverSession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()));
  vi.restoreAllMocks();
});

function request(): DriverSessionRequest {
  return {
    identity: {
      sessionId: "host-1",
      branchId: "branch",
      historyRevision: "r1",
      driver: "sdk",
      cwd: "/tmp/sandbox",
      configurationDigest: "config",
      history: { messages: [], messageDigests: [], digest: "empty" },
    },
    resume: { mode: "fresh", restoration: "none", reason: "offline test" },
    model: "claude-haiku-4-5",
    systemPrompt: "offline system",
    tools: [],
    settings: {
      toolResultTimeoutMs: 1000,
      claudeTools: [],
      userMcpServers: [],
      effort: "high",
      maxTurns: 3,
      maxBudgetUsd: 0.1,
    },
    auth: { mode: "claude-login" },
  };
}

/** Labelled offline DTO normalizer; production composition injects the shared normalizer. */
const normalizerFactory: ClaudeEventNormalizerFactory = () => ({
  normalize: (message) => [message as UnsequencedClaudeDriverEvent],
});
const cleanEnvironment = {
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
  CLAUDE_CONFIG_DIR: "/tmp/offline-login-selection",
};

function transport() {
  const output = new AsyncQueue<unknown>();
  let input: AsyncIterator<SDKUserMessage>;
  let options: Options;
  const interrupt = vi.fn(async () => undefined);
  const close = vi.fn(() => output.end());
  const query: SdkQueryFactory = (params) => {
    input = params.prompt[Symbol.asyncIterator]();
    options = params.options;
    return {
      [Symbol.asyncIterator]: () => output[Symbol.asyncIterator](),
      interrupt,
      close,
    };
  };
  return {
    output,
    query,
    interrupt,
    close,
    get input() {
      return input;
    },
    get options() {
      return options;
    },
  };
}

async function open(t = transport(), r = request()) {
  const session = await createSdkDriver({
    query: t.query,
    environment: cleanEnvironment,
    executable: "/tmp/official-claude",
    normalizerFactory,
    shutdownTimeoutMs: 30,
  }).openSession(r);
  sessions.push(session);
  return { session, t };
}

describe("official SDK query (offline doubles)", () => {
  it("doesn't load SDK until an authenticated session is opened", async () => {
    const t = transport();
    const loadSdk = vi.fn(async () => ({ query: t.query }));
    const driver = createSdkDriver({
      loadSdk,
      normalizerFactory,
      environment: cleanEnvironment,
    });
    expect(loadSdk).not.toHaveBeenCalled();
    const conflict = request();
    await expect(
      createSdkDriver({
        loadSdk,
        normalizerFactory,
        environment: {
          ...cleanEnvironment,
          ANTHROPIC_AUTH_TOKEN: "offline-secret",
        },
      }).openSession(conflict),
    ).rejects.toThrow("ANTHROPIC_AUTH_TOKEN");
    expect(loadSdk).not.toHaveBeenCalled();
    sessions.push(await driver.openSession(request()));
    expect(loadSdk).toHaveBeenCalledOnce();
  });

  it("selects executable, cwd, model, limits and official login without reading credentials", async () => {
    const { t } = await open();
    expect(t.options).toMatchObject({
      pathToClaudeCodeExecutable: "/tmp/official-claude",
      cwd: "/tmp/sandbox",
      model: "claude-haiku-4-5",
      systemPrompt: "offline system",
      effort: "high",
      maxTurns: 3,
      maxBudgetUsd: 0.1,
      tools: [],
      settingSources: [],
      strictMcpConfig: true,
      includePartialMessages: true,
    });
    expect(t.options.env?.CLAUDE_CONFIG_DIR).toBe(
      "/tmp/offline-login-selection",
    );
    expect(t.options.env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(t.options.onUserDialog).toBeUndefined();
  });

  it.each([
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
    "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
    "CLAUDE_CODE_API_KEY_HELPER",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
  ])("rejects inherited %s for login", async (name) => {
    await expect(
      createSdkDriver({
        normalizerFactory,
        query: transport().query,
        environment: { ...cleanEnvironment, [name]: "offline-override" },
      }).openSession(request()),
    ).rejects.toThrow(name);
  });

  it("explicit API key discards inherited identity and provider overrides", async () => {
    const t = transport();
    const r = request();
    r.auth = {
      mode: "api-key",
      apiKey: "selected-offline-key",
      baseUrl: "https://api.example.invalid",
    };
    const session = await createSdkDriver({
      query: t.query,
      normalizerFactory,
      environment: {
        ...cleanEnvironment,
        ANTHROPIC_API_KEY: "host-key",
        ANTHROPIC_AUTH_TOKEN: "host-token",
        CLAUDE_CODE_OAUTH_TOKEN: "host-oauth",
        CLAUDE_CODE_USE_VERTEX: "1",
      },
    }).openSession(r);
    sessions.push(session);
    expect(t.options.env).toMatchObject({
      ANTHROPIC_API_KEY: "selected-offline-key",
      ANTHROPIC_BASE_URL: "https://api.example.invalid",
      CLAUDE_CONFIG_DIR: "/tmp/offline-login-selection",
    });
    expect(t.options.env).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
    expect(t.options.env).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
    expect(t.options.env).not.toHaveProperty("CLAUDE_CODE_USE_VERTEX");
  });

  it("acks transport consumption, pumps while detached and accepts followup after result", async () => {
    const { session, t } = await open();
    const events = session.events[Symbol.asyncIterator]();
    const accepted = vi.fn();
    const firstAck = session
      .submitPrompt({
        turnId: "turn-1",
        content: [{ type: "text", text: "first" }],
      })
      .then(accepted);
    const first = await t.input.next();
    expect(first.value?.message.content).toEqual([
      { type: "text", text: "first" },
    ]);
    expect(accepted).not.toHaveBeenCalled();
    const inputPending = t.input.next();
    await firstAck;
    t.output.push({
      type: "initialized",
      claudeSessionId: "real-runtime-id",
      model: "claude-haiku-4-5",
      runtimeVersion: "offline",
      capabilities: [],
      tools: [],
      mcpServers: [],
      attribution: {},
    });
    t.output.push({
      type: "turn_end",
      status: "success",
      subtype: "success",
      isError: false,
      attribution: {},
    });
    expect((await events.next()).value).toMatchObject({
      type: "initialized",
      sequence: 1,
      attribution: { turnId: "turn-1", claudeSessionId: "real-runtime-id" },
    });
    expect((await events.next()).value).toMatchObject({
      type: "turn_end",
      sequence: 2,
    });
    const secondAck = session.submitPrompt({
      turnId: "turn-2",
      content: [{ type: "text", text: "followup" }],
    });
    expect((await inputPending).value).toMatchObject({
      session_id: "real-runtime-id",
      message: { content: [{ type: "text", text: "followup" }] },
    });
    const nextInput = t.input.next();
    await secondAck;
    t.output.push({
      type: "observation",
      family: "task",
      subtype: "finished",
      data: {},
      attribution: { taskId: "task-a" },
    });
    expect((await events.next()).value).toMatchObject({
      sequence: 3,
      attribution: { turnId: "turn-2", taskId: "task-a" },
    });
    await session.close();
    expect(await nextInput).toMatchObject({ done: true });
    expect((await events.next()).value?.type).toBe("session_closed");
    expect(await events.next()).toMatchObject({ done: true });
  });

  it("drains queued and yielded prompt acknowledgments on idempotent close", async () => {
    const { session, t } = await open();
    const first = session.submitPrompt({ turnId: "t1", content: [] });
    const second = session.submitPrompt({ turnId: "t2", content: [] });
    const rejected = Promise.all([
      expect(first).rejects.toThrow("cancelled"),
      expect(second).rejects.toThrow("cancelled"),
    ]);
    await t.input.next();
    await Promise.all([session.close(), session.close()]);
    await rejected;
    expect(t.close).toHaveBeenCalledOnce();
    expect(t.options.abortController?.signal.aborted).toBe(true);
    await expect(
      session.submitPrompt({ turnId: "t3", content: [] }),
    ).rejects.toThrow("closed");
  });

  it("times out a stalled interrupt and closes the owned query", async () => {
    const t = transport();
    t.interrupt.mockImplementation(() => new Promise(() => {}));
    const { session } = await open(t);
    await session.interrupt();
    expect(t.interrupt).toHaveBeenCalledOnce();
    expect(t.close).toHaveBeenCalledOnce();
  });

  it("keeps the input channel usable after a settled interrupt", async () => {
    const { session, t } = await open();
    const pendingInput = t.input.next();
    const cancelled = session.submitPrompt({
      turnId: "cancelled",
      content: [],
    });
    const rejection = expect(cancelled).rejects.toThrow("cancelled");
    await pendingInput;
    await session.interrupt();
    await rejection;
    const nextInput = t.input.next();
    const ack = session.submitPrompt({
      turnId: "following",
      content: [{ type: "text", text: "after interrupt" }],
    });
    expect((await nextInput).value?.message.content).toEqual([
      { type: "text", text: "after interrupt" },
    ]);
    const lastInput = t.input.next();
    await ack;
    await session.close();
    await lastInput;
  });

  it("reports transport failure and closes without exposing the SDK error string", async () => {
    const close = vi.fn();
    const query: SdkQueryFactory = () => ({
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          throw Object.assign(
            new Error(
              "Could not spawn executable: token=offline-secret-in-error",
            ),
            { code: "ENOENT" },
          );
        },
      }),
      interrupt: async () => undefined,
      close,
    });
    const session = await createSdkDriver({
      query,
      normalizerFactory,
      environment: cleanEnvironment,
    }).openSession(request());
    sessions.push(session);
    const events = [];
    for await (const event of session.events) events.push(event);
    expect(events).toMatchObject([
      { type: "session_error", error: { code: "transport" } },
      { type: "session_closed", reason: "error" },
    ]);
    expect(JSON.stringify(events)).not.toContain("offline-secret-in-error");
    expect(events[0]).toMatchObject({
      type: "session_error",
      error: {
        message: expect.stringContaining("Could not spawn executable"),
        subtype: "ENOENT",
      },
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it("rejects a nonsettling query close within the deadline and terminates the driver event channel", async () => {
    const query: SdkQueryFactory = () => ({
      [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
      interrupt: async () => undefined,
      close: () => {},
    });
    const session = await createSdkDriver({
      query,
      normalizerFactory,
      environment: cleanEnvironment,
      shutdownTimeoutMs: 20,
    }).openSession(request());
    await expect(session.close()).rejects.toThrow("timed out");
    const events = [];
    for await (const event of session.events) events.push(event);
    expect(events).toMatchObject([
      { type: "session_closed", reason: "closed" },
    ]);
  });

  it("reports and rejects a failed official query close without leaving the event channel open", async () => {
    const t = transport();
    t.close.mockImplementation(() => {
      t.output.end();
      throw new Error("official subprocess termination failed");
    });
    const session = await createSdkDriver({
      query: t.query,
      normalizerFactory,
      environment: cleanEnvironment,
      shutdownTimeoutMs: 30,
    }).openSession(request());
    await expect(session.close()).rejects.toThrow(
      "subprocess termination failed",
    );
    const events = [];
    for await (const event of session.events) events.push(event);
    expect(events).toMatchObject([
      {
        type: "session_error",
        error: { message: "official subprocess termination failed" },
      },
      { type: "session_closed", reason: "closed" },
    ]);
  });

  it("closes the owned MCP endpoint and ends its event channel on clean query EOF", async () => {
    const { session, t } = await open();
    t.output.end();
    const events = [];
    for await (const event of session.events) events.push(event);
    expect(events).toMatchObject([{ type: "session_closed", reason: "eof" }]);
    expect(t.close).toHaveBeenCalledOnce();
  });

  it("rejects an authoritative runtime ID differing from a verified persisted resume", async () => {
    const r = request();
    r.resume = {
      mode: "resume",
      restoration: "native-persisted",
      reason: "offline verified persistence",
      claudeSessionId: "expected-id",
    };
    const { session, t } = await open(transport(), r);
    expect(t.options.resume).toBe("expected-id");
    t.output.push({
      type: "initialized",
      claudeSessionId: "different-id",
      model: "offline",
      runtimeVersion: "offline",
      capabilities: [],
      tools: [],
      mcpServers: [],
      attribution: {},
    });
    const events = [];
    for await (const event of session.events) events.push(event);
    expect(events).toMatchObject([
      { type: "session_error", error: { code: "history" } },
      { type: "session_closed", reason: "error" },
    ]);
    expect(t.close).toHaveBeenCalledOnce();
  });

  it("routes permission by its own request ID and cancels pending elicitation on close", async () => {
    const { session, t } = await open();
    const events = session.events[Symbol.asyncIterator]();
    const signal = new AbortController().signal;
    const permission = t.options.canUseTool!(
      "Bash",
      { command: "offline" },
      { signal, toolUseID: "tool-a", requestId: "permission-a" },
    );
    const event = (await events.next()).value;
    if (event?.type !== "interaction_request")
      throw new Error("Missing permission request");
    expect(event.request).toMatchObject({
      kind: "permission",
      toolUseId: "tool-a",
    });
    await session.answerInteraction({
      kind: "permission",
      requestId: event.request.requestId,
      decision: { behavior: "deny", message: "host declined" },
    });
    await expect(permission).resolves.toEqual({
      behavior: "deny",
      message: "host declined",
    });
    const elicitation = t.options.onElicitation!(
      {
        serverName: "user-owned",
        message: "offline form",
        mode: "form",
        requestedSchema: { type: "object", properties: {} },
      },
      { signal, requestId: "elicitation-a" },
    );
    await events.next();
    await session.close();
    await expect(elicitation).resolves.toMatchObject({ action: "cancel" });
  });

  it("reports steering as unsupported and replays labelled history under a fresh identity", async () => {
    const r = request();
    r.resume = {
      mode: "replay",
      restoration: "user-history-replay",
      reason: "diverged",
      replayTranscript: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_call",
              id: "old-id",
              name: "read",
              arguments: { path: "past.txt" },
            },
          ],
        },
        {
          role: "tool_result",
          toolCallId: "old-id",
          toolName: "read",
          isError: false,
          content: [
            { type: "image", data: "offline-image", mimeType: "image/png" },
          ],
          structuredContent: { previous: true },
        },
      ],
    };
    const { session, t } = await open(transport(), r);
    expect(t.options.resume).toBeUndefined();
    await expect(
      session.submitPrompt({ turnId: "t", content: [], priority: "now" }),
    ).rejects.toThrow("unsupported");
    const ack = session.submitPrompt({
      turnId: "t",
      content: [{ type: "text", text: "current" }],
    });
    const input = await t.input.next();
    const text = JSON.stringify(input.value);
    expect(text).toContain("history role=assistant");
    expect(text).toContain("old-id");
    expect(text).toContain("offline-image");
    expect(text).toContain("previous");
    expect(input.value).not.toHaveProperty("uuid");
    expect(
      (
        input.value?.message.content as { type: string; text?: string }[]
      ).filter((part) => part.text === "current"),
    ).toHaveLength(1);
    const next = t.input.next();
    await ack;
    await session.close();
    await next;
  });

  it("rejects duplicate or empty interaction IDs without overwriting the parked callback", async () => {
    const { session, t } = await open();
    const events = session.events[Symbol.asyncIterator]();
    const context = {
      signal: new AbortController().signal,
      requestId: "same-request",
      toolUseID: "tool-a",
    };
    const first = t.options.canUseTool!("Read", { path: "file" }, context);
    await events.next();
    await expect(
      t.options.canUseTool!("Read", { path: "different" }, context),
    ).rejects.toThrow("unique nonempty");
    await expect(
      t.options.canUseTool!("Read", {}, { ...context, requestId: "" }),
    ).rejects.toThrow("unique nonempty");
    await expect(
      t.options.onElicitation!(
        {
          serverName: "external",
          message: "offline",
          mode: "form",
          requestedSchema: { type: "object", properties: {} },
        },
        { signal: context.signal, requestId: " " },
      ),
    ).rejects.toThrow("unique nonempty");
    await session.answerInteraction({
      kind: "permission",
      requestId: "same-request",
      decision: { behavior: "deny", message: "original callback remains" },
    });
    await expect(first).resolves.toMatchObject({
      behavior: "deny",
      message: "original callback remains",
    });
    await expect(t.options.canUseTool!("Read", {}, context)).rejects.toThrow(
      "unique nonempty",
    );
  });
});
