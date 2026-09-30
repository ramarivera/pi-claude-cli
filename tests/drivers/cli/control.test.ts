import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ClaudeDriverEvent,
  ClaudeDriverSession,
  DriverFactoryOptions,
  DriverSessionRequest,
  JsonObject,
  UnsequencedClaudeDriverEvent,
} from "../../../src/contracts/index.js";
import { createCliDriver } from "../../../src/drivers/cli/index.js";
import { ControlChannel } from "../../../src/drivers/cli/controls.js";

const fixture = fileURLToPath(new URL("./offline-claude.mjs", import.meta.url));
const environment: Record<string, string | undefined> = Object.fromEntries(
  [
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
  ].map((name) => [name, undefined]),
);
const input = (): DriverSessionRequest => ({
  identity: {
    sessionId: "host-control",
    branchId: "main",
    historyRevision: "1",
    driver: "cli",
    cwd: process.cwd(),
    configurationDigest: "control",
    history: { messages: [], messageDigests: [], digest: "empty" },
  },
  resume: { mode: "fresh", restoration: "none", reason: "offline test" },
  model: "offline-model",
  systemPrompt: "Offline system",
  tools: [
    {
      name: "edit",
      description: "Host edit",
      owner: "host",
      inputSchema: { type: "object", properties: {} },
    },
  ],
  settings: {
    toolResultTimeoutMs: 1000,
    claudeTools: ["Bash"],
    userMcpServers: [
      {
        name: "external",
        config: { type: "http", url: "https://example.invalid/mcp" },
      },
    ],
  },
  auth: { mode: "claude-login" },
});
const disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose();
});
/** Labelled offline packet spy. Production normalizer is injected by the parent composition. */
const normalizer: DriverFactoryOptions["normalizerFactory"] = () => ({
  normalize(value) {
    const packet = value as Record<string, unknown>;
    const events: UnsequencedClaudeDriverEvent[] =
      packet.type === "result"
        ? [
            {
              type: "turn_end",
              status: packet.is_error ? "error" : "success",
              subtype: String(packet.subtype),
              isError: packet.is_error === true,
              attribution: {},
            },
          ]
        : [
            {
              type: "observation",
              family: "diagnostic",
              subtype: String(packet.subtype ?? packet.type),
              data: packet as JsonObject,
              attribution: {},
            },
          ];
    return events;
  },
});
async function setup(
  request = input(),
  extraEnv: Record<string, string | undefined> = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "pcc-control-test-"));
  disposers.push(() => rm(directory, { recursive: true, force: true }));
  const receipt = join(directory, "receipt.json");
  const driver = createCliDriver({
    executable: fixture,
    normalizerFactory: normalizer,
    environment: { ...environment, PCC_RECEIPT: receipt, ...extraEnv },
    shutdownTimeoutMs: 60,
  });
  const session = await driver.openSession(request);
  disposers.push(() => session.close());
  return {
    session,
    iterator: session.events[Symbol.asyncIterator](),
    receipt,
    driver,
  };
}
async function next(
  iterator: AsyncIterator<ClaudeDriverEvent>,
  type: string,
  subtype?: string,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        for (;;) {
          const event = await iterator.next();
          if (event.done) throw new Error("Offline event stream ended");
          if (
            event.value.type === type &&
            (subtype === undefined ||
              ("subtype" in event.value && event.value.subtype === subtype))
          )
            return event.value;
        }
      })(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Offline event deadline")),
          3000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const prompt = (session: ClaudeDriverSession, text: string) =>
  session.submitPrompt({ turnId: text, content: [{ type: "text", text }] });

describe("current CLI controls (offline bidirectional child double)", () => {
  it("initializes before prompts and declares no supported dialogs", async () => {
    const { iterator, driver } = await setup();
    expect(
      await next(iterator, "observation", "initialize-request"),
    ).toMatchObject({
      data: { request: { subtype: "initialize", supportedDialogKinds: [] } },
    });
    expect(driver.capabilities).toMatchObject({
      steering: "unsupported",
      interactions: ["permission", "elicitation"],
      supportedDialogKinds: [],
    });
  });
  it.each(["error", "bad-nesting", "exit", "missing"])(
    "fails %s initialization before inference and cleans private resources",
    async (mode) => {
      const directory = await mkdtemp(join(tmpdir(), "pcc-init-test-"));
      disposers.push(() => rm(directory, { recursive: true, force: true }));
      const receipt = join(directory, "receipt.json");
      const driver = createCliDriver({
        executable: fixture,
        normalizerFactory: normalizer,
        environment: { ...environment, PCC_RECEIPT: receipt, PCC_INIT: mode },
        shutdownTimeoutMs: 60,
      });
      await expect(driver.openSession(input())).rejects.toThrow(
        /control|Control/,
      );
      const capture = JSON.parse(await readFile(receipt, "utf8"));
      await expect(
        stat(
          dirname(
            capture.args[capture.args.indexOf("--system-prompt-file") + 1],
          ),
        ),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(() => process.kill(capture.pid, 0)).toThrow();
    },
  );
  it("dispatches declared native permission, preserves updatedInput and nested request_id", async () => {
    const { session, iterator } = await setup();
    await prompt(session, "permission-native");
    expect(await next(iterator, "interaction_request")).toMatchObject({
      request: {
        kind: "permission",
        requestId: "permission-1",
        toolUseId: "native-call-1",
        toolName: "Bash",
        input: { command: "original" },
      },
    });
    await session.answerInteraction({
      kind: "permission",
      requestId: "permission-1",
      decision: {
        behavior: "allow",
        updatedInput: { command: "approved replacement", timeout: 3 },
      },
    });
    expect(await next(iterator, "observation", "control-reply")).toMatchObject({
      data: {
        id: "permission-1",
        response: {
          subtype: "success",
          request_id: "permission-1",
          response: {
            behavior: "allow",
            updatedInput: { command: "approved replacement", timeout: 3 },
          },
        },
      },
    });
    await next(iterator, "turn_end");
    await expect(
      session.answerInteraction({
        kind: "permission",
        requestId: "permission-1",
        decision: { behavior: "deny", message: "late" },
      }),
    ).rejects.toThrow("Unknown");
  });
  it("preserves explicit permission denial and interrupt flag", async () => {
    const { session, iterator } = await setup();
    await prompt(session, "permission-native");
    await next(iterator, "interaction_request");
    await session.answerInteraction({
      kind: "permission",
      requestId: "permission-1",
      decision: { behavior: "deny", message: "User declined", interrupt: true },
    });
    expect(await next(iterator, "observation", "control-reply")).toMatchObject({
      data: {
        response: {
          response: {
            behavior: "deny",
            message: "User declined",
            interrupt: true,
          },
        },
      },
    });
  });
  it("dispatches only declared user MCP permissions and denies unknown host names", async () => {
    const user = await setup();
    await prompt(user.session, "permission-user");
    expect(await next(user.iterator, "interaction_request")).toMatchObject({
      request: {
        kind: "permission",
        toolName: "mcp__external__query",
        mcpServer: { name: "external", source: "explicit-user-config" },
      },
    });
    await user.session.answerInteraction({
      kind: "permission",
      requestId: "permission-1",
      decision: { behavior: "deny", message: "No" },
    });
    await next(user.iterator, "turn_end");
    const unknown = await setup();
    await prompt(unknown.session, "permission-unknown");
    expect(
      await next(unknown.iterator, "observation", "control-reply"),
    ).toMatchObject({ data: { response: { response: { behavior: "deny" } } } });
    await next(unknown.iterator, "turn_end");
  });
  it.each(["form", "url"])(
    "dispatches declared MCP %s elicitation separately",
    async (mode) => {
      const { session, iterator } = await setup();
      await prompt(session, `elicitation-${mode}`);
      expect(await next(iterator, "interaction_request")).toMatchObject({
        request: {
          kind: "elicitation",
          requestId: "elicitation-1",
          serverName: "external",
          mode,
          ...(mode === "url"
            ? { url: "https://example.invalid/auth" }
            : { requestedSchema: { type: "object" } }),
        },
      });
      await expect(
        session.answerInteraction({
          kind: "permission",
          requestId: "elicitation-1",
          decision: { behavior: "allow", updatedInput: {} },
        }),
      ).rejects.toThrow("kind");
      await session.answerInteraction({
        kind: "elicitation",
        requestId: "elicitation-1",
        decision: { action: "accept", content: { choice: "two" } },
      });
      expect(
        await next(iterator, "observation", "control-reply"),
      ).toMatchObject({
        data: {
          response: {
            response: { action: "accept", content: { choice: "two" } },
          },
        },
      });
    },
  );
  it.each(["dialog", "control-unsupported", "elicitation-unknown"])(
    "returns explicit error for %s without approving or fabricating a user answer",
    async (action) => {
      const { session, iterator } = await setup();
      await prompt(session, action);
      expect(
        await next(iterator, "observation", "control-reply"),
      ).toMatchObject({
        data: { response: { subtype: "error", error: expect.any(String) } },
      });
      await next(iterator, "turn_end");
    },
  );
  it("cancels a withdrawn permission and rejects a late host answer", async () => {
    const { session, iterator } = await setup();
    await prompt(session, "cancel-permission");
    await next(iterator, "interaction_request");
    expect(await next(iterator, "interaction_cancel")).toMatchObject({
      requestId: "permission-1",
    });
    await expect(
      session.answerInteraction({
        kind: "permission",
        requestId: "permission-1",
        decision: { behavior: "allow", updatedInput: {} },
      }),
    ).rejects.toThrow("canceled");
  });
  it("bounds unanswered interaction waits and explicitly errors on timeout", async () => {
    const request = input();
    request.settings.toolResultTimeoutMs = 60;
    const { session, iterator } = await setup(request);
    await prompt(session, "permission-native");
    await next(iterator, "interaction_request");
    expect(await next(iterator, "interaction_cancel")).toMatchObject({
      requestId: "permission-1",
    });
    expect(await next(iterator, "observation", "control-reply")).toMatchObject({
      data: {
        response: {
          subtype: "error",
          error: "Host interaction deadline exceeded",
        },
      },
    });
  });
  it("fails malformed required control correlation explicitly", async () => {
    const { session, iterator } = await setup();
    await prompt(session, "control-malformed");
    expect(await next(iterator, "session_error")).toMatchObject({
      error: { code: "protocol" },
    });
    await session.close();
  });
  it("interrupt cancels the pending interaction before the resident interrupt receipt", async () => {
    const { session, iterator } = await setup();
    await prompt(session, "permission-native");
    await next(iterator, "interaction_request");
    await session.interrupt("Host aborted");
    expect(await next(iterator, "interaction_cancel")).toMatchObject({
      requestId: "permission-1",
    });
    expect(await next(iterator, "observation", "control-reply")).toMatchObject({
      data: { response: { subtype: "error", error: "Host aborted" } },
    });
  });
});

describe("wire input, configuration and diagnostics", () => {
  it("maps prompt images to Claude base64 source objects", async () => {
    const { session, iterator } = await setup();
    await session.submitPrompt({
      turnId: "image",
      content: [
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        { type: "text", text: "image" },
      ],
    });
    expect(await next(iterator, "observation", "input")).toMatchObject({
      data: {
        message: {
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "aGVsbG8=",
              },
            },
            { type: "text", text: "image" },
          ],
        },
      },
    });
  });
  it("replays every labelled history role/call/result and attached image only once", async () => {
    const request = input();
    request.resume = {
      mode: "replay",
      restoration: "user-history-replay",
      reason: "offline divergence",
      replayTranscript: [
        {
          role: "developer",
          content: [{ type: "text", text: "Prior developer rule" }],
        },
        {
          role: "user",
          content: [
            { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
            { type: "text", text: "prior question" },
          ],
        },
        {
          role: "assistant",
          content: [
            {
              type: "tool_call",
              id: "prior-call",
              name: "edit",
              arguments: { line: 1 },
            },
          ],
        },
        {
          role: "tool_result",
          toolCallId: "prior-call",
          toolName: "edit",
          content: [{ type: "text", text: "Prior tool output" }],
          isError: false,
        },
      ],
    };
    const { session, iterator } = await setup(request);
    await prompt(session, "fresh question");
    const first = await next(iterator, "observation", "input");
    const encoded = JSON.stringify(first);
    expect(encoded).toContain("Prior host transcript developer");
    expect(encoded).toContain("Prior host transcript assistant");
    expect(encoded).toContain("prior-call");
    expect(encoded).toContain("Prior host transcript tool_result");
    expect(first).toMatchObject({
      data: {
        message: {
          content: expect.arrayContaining([
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "aGVsbG8=",
              },
            },
          ]),
        },
      },
    });
    expect(
      first.type === "observation"
        ? JSON.stringify(first.data.message).match(/fresh question/g)
        : [],
    ).toHaveLength(1);
    await next(iterator, "turn_end");
    await prompt(session, "second question");
    expect(await next(iterator, "observation", "input")).toMatchObject({
      data: {
        message: { content: [{ type: "text", text: "second question" }] },
      },
    });
  });
  it("uses exact initialized model effort levels without silently upgrading", async () => {
    const request = input();
    request.settings.effort = "high";
    const { session, iterator, receipt } = await setup(request);
    await prompt(session, "effort");
    await next(iterator, "turn_end");
    const capture = JSON.parse(await readFile(receipt, "utf8"));
    expect(capture.args[capture.args.indexOf("--effort") + 1]).toBe("high");
    const unsupported = input();
    unsupported.settings.effort = "max";
    await expect(setup(unsupported)).rejects.toThrow("Unsupported effort max");
    const ambiguous = input();
    ambiguous.model = "offline-model-plus";
    ambiguous.settings.effort = "high";
    await expect(setup(ambiguous)).rejects.toThrow(
      "exact Claude model offline-model-plus",
    );
  });
  it("matches a full model ID only when initialization declares its resolvedModel", async () => {
    const request = input();
    request.model = "canonical-offline-model";
    request.settings.effort = "xhigh";
    const { receipt } = await setup(request, {
      PCC_MODELS: JSON.stringify([
        {
          value: "offline",
          resolvedModel: "canonical-offline-model",
          supportsEffort: true,
          supportedEffortLevels: ["xhigh"],
        },
      ]),
    });
    expect(JSON.parse(await readFile(receipt, "utf8")).args).toContain("xhigh");
  });
  it("returns sanitized, bounded actionable stderr on nonzero exit", async () => {
    const request = input();
    request.auth = { mode: "api-key", apiKey: "offline-private-test-key" };
    const { session, iterator } = await setup(request, {
      PCC_STDERR:
        "Config failed: permission denied\nBearer offline-private-test-key\napi_key=sk-ant-private-secret",
    });
    await prompt(session, "nonzero");
    const error = await next(iterator, "session_error");
    expect(error).toMatchObject({
      error: {
        code: "runtime",
        details: {
          stderr: expect.stringContaining("Config failed: permission denied"),
        },
      },
    });
    expect(JSON.stringify(error)).not.toContain("offline-private-test-key");
    expect(JSON.stringify(error)).not.toContain("sk-ant-private-secret");
    expect(JSON.stringify(error)).toContain("[redacted]");
  });
  it("keeps forwarded full child packets and nonstandard results visible to the injected normalizer", async () => {
    const { session, iterator } = await setup();
    await prompt(session, "forwarded");
    expect(await next(iterator, "observation", "assistant")).toMatchObject({
      data: {
        parent_tool_use_id: "parent-native-call",
        message: { id: "child-message", model: "served-child-model" },
      },
    });
    expect(await next(iterator, "observation", "user")).toMatchObject({
      data: {
        parent_tool_use_id: "parent-native-call",
        message: {
          content: [{ type: "tool_result", tool_use_id: "child-call" }],
        },
      },
    });
    await next(iterator, "turn_end");
    await prompt(session, "result-error");
    expect(await next(iterator, "turn_end")).toMatchObject({
      status: "error",
      isError: true,
      subtype: "error_max_budget_usd",
    });
  });
});

describe("offline control policy regression", () => {
  it("allows only the exact effective host namespace and preserves approved input", async () => {
    const packets: unknown[] = [];
    const events: UnsequencedClaudeDriverEvent[] = [];
    const channel = new ControlChannel(
      input(),
      async (packet) => {
        packets.push(packet);
      },
      (event) => events.push(event),
      () => {},
    );
    expect(
      channel.handle({
        type: "control_request",
        request_id: "host-ok",
        request: {
          subtype: "can_use_tool",
          tool_name: "mcp__host__edit",
          tool_use_id: "host-call",
          input: { native: { anyOf: true } },
        },
      }),
    ).toBe(true);
    expect(packets).toEqual([
      {
        type: "control_response",
        response: {
          subtype: "success",
          request_id: "host-ok",
          response: {
            behavior: "allow",
            updatedInput: { native: { anyOf: true } },
          },
        },
      },
    ]);
    expect(events).toEqual([]);
    expect(() =>
      channel.handle({
        type: "control_request",
        request_id: "host-ok",
        request: {
          subtype: "can_use_tool",
          tool_name: "mcp__host__edit",
          tool_use_id: "host-call",
          input: { replaced: true },
        },
      }),
    ).toThrow("Conflicting duplicate control request ID");
    channel.handle({
      type: "control_request",
      request_id: "host-other",
      request: {
        subtype: "can_use_tool",
        tool_name: "mcp__host__edit_extra",
        tool_use_id: "host-call-other",
        input: {},
      },
    });
    expect(packets.at(-1)).toMatchObject({
      response: { response: { behavior: "deny" } },
    });
    await channel.close();
  });
});
