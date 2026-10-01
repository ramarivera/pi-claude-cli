import { afterEach, describe, expect, it } from "vitest";
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type {
  ClaudeDriverEvent,
  ClaudeDriverSession,
  DriverFactoryOptions,
  DriverSessionRequest,
  HostToolResult,
  JsonObject,
  UnsequencedClaudeDriverEvent,
} from "../../../src/contracts/index.js";
import { createCliDriver } from "../../../src/drivers/cli/index.js";
import { JsonLines } from "../../../src/drivers/cli/framing.js";

const fixture = fileURLToPath(new URL("./offline-claude.mjs", import.meta.url));
const schema: JsonObject = {
  type: "object",
  properties: {
    edit: {
      anyOf: [
        { const: "replace" },
        {
          type: "object",
          properties: { line: { type: "integer" } },
          additionalProperties: false,
        },
      ],
    },
  },
  required: ["edit"],
  additionalProperties: false,
};
function request(): DriverSessionRequest {
  return {
    identity: {
      sessionId: "host",
      branchId: "main",
      historyRevision: "1",
      driver: "cli",
      cwd: process.cwd(),
      configurationDigest: "config",
      history: { messages: [], messageDigests: [], digest: "empty" },
    },
    resume: { mode: "fresh", restoration: "none", reason: "offline test" },
    model: "offline-model",
    systemPrompt: "Use the exact supplied system prompt 🦔",
    tools: [
      {
        name: "edit",
        owner: "host",
        description: "Edit with native nested schema",
        inputSchema: schema,
        outputSchema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
        },
        annotations: { destructiveHint: true },
        _meta: { native: true },
      },
    ],
    settings: {
      toolResultTimeoutMs: 1000,
      claudeTools: [],
      userMcpServers: [],
      maxTurns: 3,
      maxOutputTokens: 8192,
      maxBudgetUsd: 0.25,
      forwardSubagentText: true,
    },
    auth: { mode: "claude-login" },
  };
}
/** Labelled offline normalizer double; process tests aren't production normalization proof. */
const normalizer: DriverFactoryOptions["normalizerFactory"] = () => ({
  normalize(value) {
    const packet = value as Record<string, unknown>;
    const events: UnsequencedClaudeDriverEvent[] = [];
    if (packet.type === "result")
      events.push({
        type: "turn_end",
        status: "success",
        subtype: "success",
        isError: false,
        attribution: {},
      });
    else if (packet.type === "assistant")
      events.push({
        type: "assistant_snapshot",
        messageId: "offline-msg",
        content: [{ type: "text", text: String(packet.text) }],
        attribution: {},
      });
    else
      events.push({
        type: "observation",
        family: "diagnostic",
        subtype: String(packet.subtype ?? packet.type),
        data: JSON.parse(JSON.stringify(packet)) as JsonObject,
        attribution: {},
      });
    return events;
  },
});
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});
async function open(
  extraEnv: Record<string, string | undefined> = {},
  override?: DriverSessionRequest,
) {
  await chmod(fixture, 0o755);
  const directory = await mkdtemp(join(tmpdir(), "pcc-cli-test-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const receipt = join(directory, "receipt.json");
  const cleanEnv: Record<string, undefined> = Object.fromEntries(
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
  const driver = createCliDriver({
    executable: fixture,
    normalizerFactory: normalizer,
    environment: { ...cleanEnv, PCC_RECEIPT: receipt, ...extraEnv },
    shutdownTimeoutMs: 60,
  });
  const session = await driver.openSession(override ?? request());
  cleanup.push(() => session.close());
  return {
    session,
    iterator: session.events[Symbol.asyncIterator](),
    receipt,
    directory,
    driver,
  };
}
async function until(
  iterator: AsyncIterator<ClaudeDriverEvent>,
  predicate: (event: ClaudeDriverEvent) => boolean,
): Promise<ClaudeDriverEvent> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        for (;;) {
          const next = await iterator.next();
          if (next.done)
            throw new Error("Event stream ended before expected event");
          if (predicate(next.value)) return next.value;
        }
      })(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Offline event deadline")),
          5000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}
const prompt = (session: ClaudeDriverSession, text: string) =>
  session.submitPrompt({ turnId: text, content: [{ type: "text", text }] });
const result = (id: string, text = id): HostToolResult => ({
  toolCallId: id,
  toolName: "edit",
  content: [
    { type: "text", text },
    { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
  ],
  isError: false,
  structuredContent: { id },
  _meta: { passed: true },
  details: { privateHostDetail: "retained outside model output" },
});

describe("CLI resident process (offline child double)", () => {
  it("maps native edit/write instructions in the actual CLI system-prompt file", async () => {
    const r = request();
    r.systemPrompt =
      "Use edit for existing files and write for new files. Keep literal mcp__host__edit examples.";
    r.tools = ["edit", "write", "read", "bash", "mcp__remote__query"].map(
      (name) => ({
        owner: "host" as const,
        name,
        description: `Native ${name} tool`,
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      }),
    );
    const { session, iterator, receipt } = await open({}, r);
    await prompt(session, "tool inventory proof");
    await until(iterator, (event) => event.type === "turn_end");
    const actual = JSON.parse(await readFile(receipt, "utf8"))
      .systemPrompt as string;
    expect(actual.startsWith(r.systemPrompt + "\n\n")).toBe(true);
    for (const tool of r.tools)
      expect(actual).toContain(`"${tool.name}" -> "mcp__host__${tool.name}"`);
    expect(actual).toContain(
      "Claude built-in tools are disabled for this session.",
    );
    expect(actual).toContain(
      "Use the mapped Claude callable name even when host instructions or history use the native name.",
    );
  });

  it("lists only exposed host tools and the configured CLI built-ins", async () => {
    const r = request();
    r.tools = [
      {
        owner: "host",
        name: "read",
        description: "Read only",
        inputSchema: { type: "object" },
      },
    ];
    r.settings.claudeTools = ["Bash", "WebSearch"];
    const { session, iterator, receipt } = await open({}, r);
    await prompt(session, "tool inventory proof");
    await until(iterator, (event) => event.type === "turn_end");
    const actual = JSON.parse(await readFile(receipt, "utf8"));
    expect(actual.systemPrompt).toContain('"read" -> "mcp__host__read"');
    expect(actual.systemPrompt).not.toContain("mcp__host__edit");
    expect(actual.systemPrompt).not.toContain("mcp__host__write");
    expect(actual.systemPrompt).toContain(
      'Configured Claude built-in tools: ["Bash","WebSearch"].',
    );
    expect(actual.systemPrompt).not.toContain("built-in tools are disabled");
    expect(actual.args[actual.args.indexOf("--tools") + 1]).toBe(
      "Bash,WebSearch",
    );
  });

  it("honors capability-validated effort over conflicting inherited runtime settings", async () => {
    const r = request();
    r.settings.effort = "high";
    const { session, iterator, receipt } = await open(
      { CLAUDE_CODE_EFFORT_LEVEL: "low" },
      r,
    );
    await prompt(session, "offline explicit effort");
    await until(iterator, (event) => event.type === "turn_end");
    expect(JSON.parse(await readFile(receipt, "utf8")).environment.effort).toBe(
      "high",
    );
  });
  it("keeps long native tool instructions beyond Claude's default MCP description limit", async () => {
    const r = request();
    r.tools = r.tools.map((tool) => ({
      ...tool,
      description: "native instruction ".repeat(500),
    }));
    const { session, iterator, receipt } = await open({}, r);
    await prompt(session, "offline description proof");
    await until(iterator, (event) => event.type === "turn_end");
    expect(
      JSON.parse(await readFile(receipt, "utf8")).environment
        .maxMcpDescriptionLength,
    ).toBe(String(r.tools[0].description.length));
  });
  it("rejects immediate steering without consuming a normal next prompt", async () => {
    const { session, iterator } = await open();
    await expect(
      session.submitPrompt({
        turnId: "steer",
        priority: "now",
        content: [{ type: "text", text: "immediate steering" }],
      }),
    ).rejects.toThrow("CLI steering priorities unsupported");
    await session.submitPrompt({
      turnId: "normal",
      priority: "next",
      content: [{ type: "text", text: "normal continuation" }],
    });
    const terminal = await until(
      iterator,
      (event) => event.type === "turn_end",
    );
    expect(terminal).toMatchObject({ type: "turn_end", status: "success" });
  });
  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid output-token limit %s before executable preflight",
    async (limit) => {
      const r = request();
      r.settings.maxOutputTokens = limit;
      await expect(
        createCliDriver({
          executable: "/missing/claude",
          normalizerFactory: normalizer,
        }).openSession(r),
      ).rejects.toThrow("maxOutputTokens must be a positive integer");
    },
  );
  it("uses prompt-file argv, explicit cwd/model, bounded config files, login env and a resident second turn", async () => {
    const { session, iterator, receipt } = await open({
      CLAUDE_CONFIG_DIR: "/offline-selected-config",
    });
    await prompt(session, "first");
    await until(iterator, (event) => event.type === "turn_end");
    const before = JSON.parse(await readFile(receipt, "utf8")) as {
      pid: number;
      args: string[];
      cwd: string;
      systemPrompt: string;
      environment: JsonObject;
      config: JsonObject;
    };
    expect(
      before.systemPrompt.startsWith(request().systemPrompt + "\n\n"),
    ).toBe(true);
    expect((before.config.mcpServers as JsonObject).host).not.toHaveProperty(
      "env",
    );
    expect(before.environment).not.toHaveProperty("bunBeBun");
    expect(before.cwd).toBe(process.cwd());
    expect(before.args).toContain("--system-prompt-file");
    expect(before.args).not.toContain("--system-prompt");
    expect(before.args[before.args.indexOf("--tools") + 1]).toBe("");
    expect(before.args).toEqual(
      expect.arrayContaining([
        "-p",
        "--strict-mcp-config",
        "--input-format",
        "stream-json",
        "--permission-prompt-tool",
        "stdio",
        "--model",
        "offline-model",
        "--forward-subagent-text",
        "--max-turns",
        "3",
        "--max-budget-usd",
        "0.25",
      ]),
    );
    expect(before.environment).toMatchObject({
      configDir: "/offline-selected-config",
      hasKey: false,
      cloudMcp: "0",
      maxOutputTokens: "8192",
    });
    const tempDirectory = dirname(
      before.args[before.args.indexOf("--system-prompt-file") + 1],
    );
    expect((await stat(tempDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(join(tempDirectory, "system.txt"))).mode & 0o777).toBe(
      0o600,
    );
    expect((await stat(join(tempDirectory, "host.sock"))).mode & 0o777).toBe(
      0o600,
    );
    await prompt(session, "second");
    const second = await until(
      iterator,
      (event) => event.type === "assistant_snapshot",
    );
    expect(second).toMatchObject({
      content: [{ type: "text", text: "second" }],
      attribution: { turnId: "second" },
    });
    await until(iterator, (event) => event.type === "turn_end");
    expect(JSON.parse(await readFile(receipt, "utf8")).pid).toBe(before.pid);
    await Promise.all([session.close(), session.close()]);
    await expect(stat(tempDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    expect(() => process.kill(before.pid, 0)).toThrow();
  });
  it("doesn't terminate at message_stop", async () => {
    const { session, iterator, receipt } = await open();
    await prompt(session, "message-stop");
    await until(
      iterator,
      (event) =>
        event.type === "observation" && event.subtype === "stream_event",
    );
    const { pid } = JSON.parse(await readFile(receipt, "utf8"));
    expect(() => process.kill(pid, 0)).not.toThrow();
    await expect(prompt(session, "overlapping")).rejects.toThrow("active turn");
  });
  it("reassembles fragmented multibyte NDJSON and drains valid buffered messages once", async () => {
    const { session, iterator } = await open();
    await prompt(session, "fragment");
    expect(
      await until(iterator, (event) => event.type === "assistant_snapshot"),
    ).toMatchObject({ content: [{ type: "text", text: "hello 🦔 café" }] });
    expect(
      await until(iterator, (event) => event.type === "turn_end"),
    ).toMatchObject({ status: "success" });
  });
  it.each([
    ["eof", "transport", "without a terminal result"],
    ["stdout-eof", "transport", "without a terminal result"],
    ["bad-json", "protocol", "JSON frame"],
    ["oversize", "protocol", "JSON frame"],
    ["nonzero", "runtime", "7"],
  ])(
    "surfaces %s as an actionable session error and cleans resources",
    async (action, code, message) => {
      const { session, iterator, receipt } = await open();
      await prompt(session, action);
      expect(
        await until(iterator, (event) => event.type === "session_error"),
      ).toMatchObject({
        error: { code, message: expect.stringContaining(message) },
      });
      await session.close();
      const capture = JSON.parse(await readFile(receipt, "utf8"));
      await expect(
        stat(
          dirname(
            capture.args[capture.args.indexOf("--system-prompt-file") + 1],
          ),
        ),
      ).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
  it("force-kills an uncooperative process group including MCP-like grandchildren", async () => {
    const { session, iterator, receipt, directory } = await open({
      PCC_HANG: "1",
      PCC_TREE: join(tmpdir(), "unused"),
    });
    // Use a dedicated capture rather than probing an unrelated process tree.
    const grandchildFile = join(directory, "grandchild");
    await prompt(session, "ready");
    await until(iterator, (event) => event.type === "turn_end");
    await session.close();
    const capture = JSON.parse(await readFile(receipt, "utf8"));
    expect(() => process.kill(capture.pid, 0)).toThrow();
    const second = await open({ PCC_TREE: grandchildFile, PCC_HANG: "1" });
    await prompt(second.session, "tree");
    await until(second.iterator, (event) => event.type === "turn_end");
    const grandchild = Number(await readFile(grandchildFile, "utf8"));
    await second.session.close();
    // Linux can retain a killed grandchild briefly as a zombie owned by init.
    try {
      expect(await readFile(`/proc/${grandchild}/stat`, "utf8")).toMatch(
        /\) Z /,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    void iterator;
  });
  it("reaps descendants that inherited stdout after their CLI leader exits", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pcc-exit-tree-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const capture = join(directory, "grandchild");
    const { session, iterator } = await open({ PCC_TREE: capture });
    await prompt(session, "exit-tree");
    expect(
      await until(iterator, (event) => event.type === "session_error"),
    ).toMatchObject({ error: { code: "transport" } });
    await session.close();
    const pid = Number(await readFile(capture, "utf8"));
    try {
      expect(await readFile(`/proc/${pid}/stat`, "utf8")).toMatch(/\) Z /);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  });
  it("reports EPIPE when the live child's stdin closes before an interrupt write", async () => {
    const { session, iterator } = await open();
    await prompt(session, "stdin-epipe");
    await until(
      iterator,
      (event) =>
        event.type === "observation" && event.subtype === "stream_event",
    );
    await expect(session.interrupt()).rejects.toThrow(/stdin|closed|write/i);
    expect(
      await until(iterator, (event) => event.type === "session_error"),
    ).toMatchObject({ error: { code: "transport" } });
    await session.close();
  });
  it.each([
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_API_KEY_HELPER",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
  ])("rejects login billing override %s before spawning", async (name) => {
    const driver = createCliDriver({
      executable: "/must-not-spawn",
      normalizerFactory: normalizer,
      environment: { [name]: "offline-secret-value" },
    });
    await expect(driver.openSession(request())).rejects.toThrow(name);
  });
  it("uses only the explicitly provided API key and endpoint without inherited tokens", async () => {
    const input = request();
    input.auth = {
      mode: "api-key",
      apiKey: "offline-test-key",
      baseUrl: "https://example.invalid",
    };
    const { session, iterator, receipt } = await open(
      {
        ANTHROPIC_AUTH_TOKEN: "offline-inherited-token",
        CLAUDE_CODE_OAUTH_TOKEN: "offline-oauth",
      },
      input,
    );
    await prompt(session, "explicit-key");
    await until(iterator, (event) => event.type === "turn_end");
    expect(
      JSON.parse(await readFile(receipt, "utf8")).environment,
    ).toMatchObject({ hasKey: true, baseUrl: "https://example.invalid" });
  });
  it("fails version preflight before resident startup/inference", async () => {
    await expect(open({ PCC_VERSION: "2.1.284" })).rejects.toThrow(
      "requires 2.1.285",
    );
  });
  it("reports an unavailable executable preflight without exposing env", async () => {
    const driver = createCliDriver({
      executable: "/offline-missing-cli",
      normalizerFactory: normalizer,
      environment: {
        ANTHROPIC_API_KEY: undefined,
        ANTHROPIC_AUTH_TOKEN: undefined,
        ANTHROPIC_BASE_URL: undefined,
      },
    });
    await expect(driver.openSession(request())).rejects.toThrow(
      "preflight failed",
    );
  });
});

describe("native MCP endpoint and correlated parked calls (offline MCP client double)", () => {
  it("reports permission, MCP dispatch and missing metadata without tool input or error payloads", async () => {
    const { session, iterator } = await open();
    await prompt(session, "tools-missing-meta");
    const diagnostics: ClaudeDriverEvent[] = [];
    await until(iterator, (event) => {
      if (
        event.type === "observation" &&
        ["host-mcp-transport", "host-mcp-permission"].includes(event.subtype)
      )
        diagnostics.push(event);
      return event.type === "turn_end";
    });
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          subtype: "host-mcp-transport",
          data: { phase: "ready" },
        }),
        expect.objectContaining({
          subtype: "host-mcp-transport",
          data: { phase: "tools-listed" },
        }),
        expect.objectContaining({
          subtype: "host-mcp-transport",
          data: { phase: "missing-tool-use-id" },
          attribution: { turnId: "tools-missing-meta" },
        }),
        expect.objectContaining({
          subtype: "host-mcp-permission",
          data: {
            requestId: "permission-missing",
            toolName: "mcp__host__edit",
          },
          attribution: {
            turnId: "tools-missing-meta",
            toolUseId: "missing-meta-permission",
          },
        }),
      ]),
    );
    expect(
      diagnostics.some(
        (event) =>
          event.type === "observation" && event.data.phase === "call-received",
      ),
    ).toBe(false);
    expect(JSON.stringify(diagnostics)).not.toMatch(
      /updatedInput|arguments|claudecode\/toolUseId|apiKey/,
    );
  });
  it("preserves complete native JSON Schema and parks the actual MCP handler until matching unordered results", async () => {
    const { session, iterator } = await open();
    await prompt(session, "tools");
    const advertised = await until(
      iterator,
      (event) => event.type === "observation" && event.subtype === "tools",
    );
    expect(advertised).toMatchObject({
      data: {
        data: {
          tools: [
            {
              name: "edit",
              inputSchema: schema,
              outputSchema: request().tools[0].outputSchema,
              annotations: { destructiveHint: true },
              _meta: { native: true },
            },
          ],
        },
      },
    });
    const first = await until(
      iterator,
      (event) => event.type === "host_tool_request",
    );
    const second = await until(
      iterator,
      (event) => event.type === "host_tool_request",
    );
    expect(first).toMatchObject({
      call: { id: "tool-b", name: "edit", arguments: { id: "tool-b" } },
    });
    expect(second).toMatchObject({
      call: { id: "tool-a", name: "edit", arguments: { id: "tool-a" } },
    });
    await session.deliverToolResults([result("tool-a", "first-result")]);
    const firstResult = await until(
      iterator,
      (event) =>
        event.type === "observation" && event.subtype === "tool-result",
    );
    expect(firstResult).toMatchObject({
      data: {
        id: "tool-a",
        result: {
          content: result("tool-a", "first-result").content,
          structuredContent: { id: "tool-a" },
          _meta: { passed: true },
          isError: false,
        },
      },
    });
    await session.deliverToolResults([result("tool-b", "second-result")]);
    expect(
      await until(
        iterator,
        (event) =>
          event.type === "observation" && event.subtype === "tool-result",
      ),
    ).toMatchObject({
      data: {
        id: "tool-b",
        result: { content: result("tool-b", "second-result").content },
      },
    });
    await until(iterator, (event) => event.type === "turn_end");
    await session.deliverToolResults([result("tool-b", "second-result")]);
    await expect(
      session.deliverToolResults([result("tool-b", "conflict")]),
    ).rejects.toThrow("Conflicting duplicate");
  });
  it("fails missing authoritative metadata instead of using JSON-RPC IDs or call ordering", async () => {
    const { session, iterator } = await open();
    await prompt(session, "tools-missing-meta");
    expect(
      await until(
        iterator,
        (event) =>
          event.type === "observation" && event.subtype === "tool-error",
      ),
    ).toMatchObject({
      data: { error: expect.stringContaining("claudecode/toolUseId") },
    });
    await until(iterator, (event) => event.type === "turn_end");
  });
  it("buffers valid early results and matches their exact IDs", async () => {
    const { session, iterator } = await open();
    await session.deliverToolResults([
      result("tool-a", "early-a"),
      result("tool-b", "early-b"),
    ]);
    await prompt(session, "tools");
    const first = await until(
      iterator,
      (event) =>
        event.type === "observation" && event.subtype === "tool-result",
    );
    const second = await until(
      iterator,
      (event) =>
        event.type === "observation" && event.subtype === "tool-result",
    );
    expect([first, second]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          data: expect.objectContaining({
            id: "tool-a",
            result: expect.objectContaining({
              content: result("tool-a", "early-a").content,
            }),
          }),
        }),
        expect.objectContaining({
          data: expect.objectContaining({
            id: "tool-b",
            result: expect.objectContaining({
              content: result("tool-b", "early-b").content,
            }),
          }),
        }),
      ]),
    );
  });
  it("interrupt settles all pending native handlers as isError true", async () => {
    const { session, iterator } = await open();
    await prompt(session, "tools");
    await until(iterator, (event) => event.type === "host_tool_request");
    await until(iterator, (event) => event.type === "host_tool_request");
    await session.interrupt("offline cancellation");
    for (let index = 0; index < 2; index++)
      expect(
        await until(
          iterator,
          (event) =>
            event.type === "observation" && event.subtype === "tool-result",
        ),
      ).toMatchObject({
        data: {
          result: {
            isError: true,
            content: [{ type: "text", text: "offline cancellation" }],
          },
        },
      });
    await until(iterator, (event) => event.type === "turn_end");
    await expect(
      session.deliverToolResults([result("tool-a", "late success")]),
    ).rejects.toThrow("Conflicting duplicate");
  });
  it("park deadline releases each handler with an error instead of fabricating success", async () => {
    const input = request();
    input.settings.toolResultTimeoutMs = 80;
    const { session, iterator } = await open({}, input);
    await prompt(session, "tools");
    await until(iterator, (event) => event.type === "host_tool_request");
    expect(
      await until(
        iterator,
        (event) =>
          event.type === "observation" && event.subtype === "tool-result",
      ),
    ).toMatchObject({
      data: {
        result: {
          isError: true,
          content: [
            {
              type: "text",
              text: expect.stringContaining("deadline exceeded"),
            },
          ],
        },
      },
    });
    await until(iterator, (event) => event.type === "turn_end");
  });
});

describe("bounded NDJSON framing", () => {
  it("preserves a final complete frame without a newline and rejects oversize lines", () => {
    const received: unknown[] = [];
    const parser = new JsonLines((packet) => received.push(packet), 40);
    parser.push(Buffer.from('{"one":1}\n{"two":"🦔"}'));
    parser.end();
    expect(received).toEqual([{ one: 1 }, { two: "🦔" }]);
    expect(() =>
      new JsonLines(() => {}, 4).push(Buffer.from("12345\n")),
    ).toThrow("byte limit");
  });
});

it("admits active queued input on the retained turn after a native result and preserves its result UUIDs", async () => {
  const { session, iterator } = await open();
  await session.submitPrompt({
    turnId: "retained",
    content: [{ type: "text", text: "fragment" }],
  });
  await until(iterator, (event) => event.type === "turn_end");
  const commandId = randomUUID();
  await session.submitPrompt({
    turnId: "retained",
    content: [{ type: "text", text: "active-queued-followup" }],
    priority: "next",
    steering: "active-queue",
    commandId,
  });
  const admission = await until(
    iterator,
    (event) =>
      event.type === "observation" && event.subtype === "steering-admission",
  );
  expect(admission).toMatchObject({
    data: { commandId, state: "queued" },
    attribution: { turnId: "retained" },
  });
  const consumption = await until(
    iterator,
    (event) =>
      event.type === "observation" && event.subtype === "steering-admission",
  );
  expect(consumption).toMatchObject({ data: { commandId, state: "started" } });
  const terminal = await until(iterator, (event) => event.type === "turn_end");
  expect(terminal).toMatchObject({
    commandIds: [commandId, commandId],
    attribution: { turnId: "retained" },
  });
});
