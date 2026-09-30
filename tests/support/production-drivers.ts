import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  CallToolResultSchema,
  type CallToolResult,
  type ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { createClaudeEventNormalizer } from "../../src/core/index.js";
import { createCliDriver } from "../../src/drivers/cli/index.js";
import {
  createSdkDriver,
  type SdkQueryFactory,
} from "../../src/drivers/sdk/index.js";
import { AsyncQueue } from "../../src/drivers/sdk/queue.js";
import type {
  ClaudeDriver,
  ClaudeDriverSession,
  DriverKind,
  DriverSessionRequest,
  HostRoundRequest,
  HostToolResult,
  JsonObject,
  ToolDefinition,
} from "../../src/contracts/index.js";
import { runScenario, type ScenarioCommand } from "./protocol-scenario.mjs";

export const nativeTool: ToolDefinition = {
  name: "edit",
  owner: "host",
  description: "Preserve native editing schema",
  title: "Native sentinel edit",
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
                anchor: { type: "string", pattern: "^[0-9]+#[0-9a-f]{4}$" },
                text: { type: "string" },
              },
              required: ["op", "anchor", "text"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: {
                op: { const: "delete" },
                anchor: { type: "string" },
              },
              required: ["op", "anchor"],
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
    properties: { nonce: { type: "string" } },
    required: ["nonce"],
  },
  annotations: { destructiveHint: true },
  _meta: { schemaOrigin: "offline-host" },
};
export const toolArguments: JsonObject = {
  edits: [{ op: "replace", anchor: "1#abcd", text: "native replacement" }],
};
export function toolResult(id: string, isError = false): HostToolResult {
  return {
    toolCallId: id,
    toolName: "edit",
    isError,
    content: [{ type: "text", text: `sentinel:${id}` }],
    structuredContent: { nonce: `nonce-${id}` },
    _meta: { resultOrigin: "host", id },
    details: { hostOnly: true },
  };
}
export function hostRequest(
  command: ScenarioCommand,
  overrides: Partial<HostRoundRequest> = {},
): HostRoundRequest {
  return {
    roundId: command.turn,
    session: {
      sessionId: "host-session",
      branchId: "main",
      historyRevision: "0",
    },
    cwd: process.cwd(),
    model: "offline-model",
    systemPrompt: "Distinctive system marker: integration-system",
    tools: [nativeTool],
    transcript: [],
    input: {
      kind: "prompt",
      content: [{ type: "text", text: JSON.stringify(command) }],
    },
    settings: {
      toolResultTimeoutMs: 2000,
      claudeTools: [],
      userMcpServers: [],
      maxTurns: 3,
    },
    auth: { mode: "claude-login" },
    ...overrides,
  };
}
export function sessionRequest(kind: DriverKind): DriverSessionRequest {
  const r = hostRequest({ turn: "direct", mode: "text", text: "hello" });
  return {
    identity: {
      ...r.session,
      driver: kind,
      cwd: r.cwd,
      configurationDigest: "offline",
      history: { messages: [], messageDigests: [], digest: "empty" },
    },
    resume: {
      mode: "fresh",
      restoration: "none",
      reason: "offline production integration",
    },
    model: r.model,
    systemPrompt: r.systemPrompt,
    tools: r.tools,
    settings: r.settings,
    auth: r.auth,
  };
}
const environment: Record<string, undefined> = Object.fromEntries(
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
export interface TransportCapture {
  request: DriverSessionRequest;
  session: ClaudeDriverSession;
  submitted: SDKUserMessage[];
  options?: Options;
  receipt?: string;
  interrupts: number;
  closes: number;
  client?: Client;
  listing?: ListToolsResult;
  results: { id: string; result: CallToolResult }[][];
  readReceipt(): Promise<{
    pid: number;
    args: string[];
    systemPrompt: string;
    prompts: { content: unknown[] }[];
    controls: string[];
    listing: ListToolsResult;
    results: { id: string; result: CallToolResult }[][];
  }>;
}

/** Production driver implementations; ONLY their external inference transports are offline. */
export async function productionDriver(kind: DriverKind) {
  const directory = await mkdtemp(join(tmpdir(), `pcc-conformance-${kind}-`));
  const captures: TransportCapture[] = [];
  const base = kind === "cli" ? createCliDriver() : createSdkDriver();
  const driver: ClaudeDriver = {
    kind,
    capabilities: base.capabilities,
    async openSession(request) {
      const index = captures.length;
      const capture: TransportCapture = {
        request: structuredClone(request),
        session: undefined as unknown as ClaudeDriverSession,
        submitted: [],
        interrupts: 0,
        closes: 0,
        results: [],
        async readReceipt() {
          if (!capture.receipt)
            throw new Error("Only CLI transport writes a process receipt");
          return JSON.parse(await readFile(capture.receipt, "utf8"));
        },
      };
      let selected: ClaudeDriver;
      if (kind === "cli") {
        capture.receipt = join(directory, `process-${index}.json`);
        selected = createCliDriver({
          executable: fileURLToPath(
            new URL("./offline-protocol-cli.mjs", import.meta.url),
          ),
          normalizerFactory: createClaudeEventNormalizer,
          environment: {
            ...environment,
            PCC_SCENARIO_SESSION: `offline-cli-${index}`,
            PCC_SCENARIO_RECEIPT: capture.receipt,
          },
          shutdownTimeoutMs: 150,
        });
      } else {
        const output = new AsyncQueue<unknown>();
        let work = Promise.resolve();
        let turn: string | undefined;
        let initialized = false;
        let stopped = false;
        const sessionId = `offline-sdk-${index}`;
        const connect = async () => {
          if (!capture.client) {
            const endpoint = capture.options?.mcpServers?.host;
            if (!endpoint || endpoint.type !== "sdk")
              throw new Error("Production SDK host MCP server missing");
            const [clientTransport, serverTransport] =
              InMemoryTransport.createLinkedPair();
            capture.client = new Client({
              name: "offline-conformance",
              version: "1",
            });
            await endpoint.instance.connect(serverTransport);
            await capture.client.connect(clientTransport);
          }
          return capture.client;
        };
        const query: SdkQueryFactory = ({ prompt, options }) => {
          capture.options = options;
          // Pull ahead so the real input generator acknowledges its yielded prompt
          // while the simulated inference is parked on tools/call.
          void (async () => {
            for await (const message of prompt) {
              capture.submitted.push(message);
              const last = message.message.content;
              if (!Array.isArray(last))
                throw new Error("Expected structured SDK prompt");
              const block = last.at(-1);
              if (!block || block.type !== "text")
                throw new Error("Expected scenario command text");
              const command = JSON.parse(block.text) as ScenarioCommand;
              work = work
                .then(async () => {
                  if (stopped) return;
                  if (!initialized) {
                    initialized = true;
                    output.push({
                      type: "system",
                      subtype: "init",
                      session_id: sessionId,
                      model: "offline-model",
                      claude_code_version: "2.1.285",
                      tools: options.allowedTools,
                      mcp_servers: [
                        { name: "host", status: "connected", source: "sdk" },
                      ],
                    });
                  }
                  turn = command.turn;
                  await runScenario(
                    command,
                    sessionId,
                    (packet) => {
                      if (
                        packet &&
                        typeof packet === "object" &&
                        "kind" in packet
                      ) {
                        if (
                          packet.kind === "tools_listing" &&
                          "listing" in packet
                        )
                          capture.listing = packet.listing as ListToolsResult;
                        if (
                          packet.kind === "tool_results" &&
                          "results" in packet
                        )
                          capture.results.push(
                            packet.results as {
                              id: string;
                              result: CallToolResult;
                            }[],
                          );
                      }
                      if (!stopped) output.push(packet);
                    },
                    async (call) =>
                      (await connect()).request(
                        {
                          method: "tools/call",
                          params: {
                            name: call.name,
                            arguments: call.arguments,
                            _meta: { "claudecode/toolUseId": call.id },
                          },
                        },
                        CallToolResultSchema,
                        { timeout: 4000 },
                      ),
                    async () => (await connect()).listTools(),
                  );
                })
                .catch((error: unknown) => {
                  if (!stopped)
                    output.push({
                      type: "result",
                      session_id: sessionId,
                      subtype: "error_during_execution",
                      is_error: true,
                      errors: [
                        error instanceof Error
                          ? error.message
                          : "Offline scenario failed",
                      ],
                    });
                });
            }
          })();
          return {
            [Symbol.asyncIterator]: () => output[Symbol.asyncIterator](),
            async interrupt() {
              capture.interrupts++;
              if (turn)
                output.push({
                  type: "result",
                  session_id: sessionId,
                  uuid: `${turn}-abort`,
                  subtype: "error_aborted",
                  is_error: true,
                  terminal_reason: "user_abort",
                  errors: ["Offline interrupted"],
                });
            },
            close() {
              capture.closes++;
              stopped = true;
              output.end();
            },
          };
        };
        selected = createSdkDriver({
          normalizerFactory: createClaudeEventNormalizer,
          environment,
          loadSdk: async () => ({ query }),
          shutdownTimeoutMs: 150,
        });
      }
      const session = await selected.openSession(request);
      capture.session = session;
      captures.push(capture);
      return session;
    },
  };
  return {
    driver,
    captures,
    async cleanup() {
      for (const capture of captures) {
        await capture.session.close();
        await capture.client?.close();
        if (capture.receipt) {
          const receipt = await capture.readReceipt();
          if (receipt.pid) {
            try {
              process.kill(receipt.pid, 0);
              throw new Error(
                `Offline owned process ${receipt.pid} survived close`,
              );
            } catch (error) {
              if (
                !(
                  error instanceof Error &&
                  "code" in error &&
                  error.code === "ESRCH"
                )
              )
                throw error;
            }
          }
          const privatePath =
            receipt.args[receipt.args.indexOf("--system-prompt-file") + 1];
          try {
            await stat(dirname(privatePath));
            throw new Error("CLI private directory survived close");
          } catch (error) {
            if (
              !(
                error instanceof Error &&
                "code" in error &&
                error.code === "ENOENT"
              )
            )
              throw error;
          }
        }
      }
      await rm(directory, { recursive: true, force: true });
    },
  };
}
