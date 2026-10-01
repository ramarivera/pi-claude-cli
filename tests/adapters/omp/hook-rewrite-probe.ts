import assert from "node:assert/strict";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { type } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { readRuntimeConfiguration } from "../../../entrypoints/config.js";
import { toRequest } from "../../../src/adapters/omp/request.js";
import { projectRound } from "../../../src/adapters/omp/stream.js";
import { Channel } from "../../../src/core/channel.js";
import { createClaudeEventNormalizer } from "../../../src/core/normalizer.js";
import { createClaudeRuntime } from "../../../src/core/runtime.js";
import type {
  ClaudeDriver,
  ClaudeDriverEvent,
  DriverSessionRequest,
  HostRoundRequest,
  HostToolResult,
} from "../../../src/contracts/index.js";

// Scripted Claude events, real OMP Agent dispatch/argument mutation/conversion.
// No filesystem tools, Claude subprocesses, inference or network requests.
globalThis.fetch = () => {
  throw new Error("Hook rewrite probe mustn't use HTTP");
};
const evidence = [];
for (const kind of ["cli", "sdk"] as const) {
  const opened: DriverSessionRequest[] = [];
  const delivered: HostToolResult[] = [];
  const requests: HostRoundRequest[] = [];
  const executed: string[] = [];
  let mutations = 0;
  const driver: ClaudeDriver = {
    kind,
    capabilities: {
      contractVersion: 1,
      driver: kind,
      toolCorrelation: "claude-tool-use-meta",
      residentSessions: true,
      persistedResume: kind === "sdk",
      structuredToolResults: true,
      images: true,
      steering: "tool-boundary",
      interactions: [],
      supportedDialogKinds: [],
      forwardSubagentText: false,
    },
    async openSession(request) {
      opened.push(request);
      const events = new Channel<ClaudeDriverEvent>();
      const normalizer = createClaudeEventNormalizer({
        tools: request.tools,
        hostMcpServerName: "host",
        requestedModel: request.model,
      });
      let sequence = 0;
      let message = 0;
      let prompts = 0;
      const sessionId = `${kind}-${opened.length}`;
      const emit = (packet: unknown) => {
        for (const event of normalizer.normalize(packet))
          events.push({ ...event, sequence: ++sequence });
      };
      const answer = () => {
        emit({
          type: "assistant",
          session_id: sessionId,
          uuid: `answer-${++message}`,
          message: {
            id: `answer-${message}`,
            model: request.model,
            content: [
              { type: "text", text: "Executed rewritten command; done" },
            ],
            stop_reason: "end_turn",
          },
        });
        emit({
          type: "result",
          subtype: "success",
          is_error: false,
          session_id: sessionId,
          uuid: `end-${message}`,
          result: "done",
          usage: {},
        });
      };
      const propose = (name: string, args: Record<string, string>) => {
        const id = `${name}-call`;
        emit({
          type: "assistant",
          session_id: sessionId,
          uuid: `proposal-${++message}`,
          message: {
            id: `proposal-${message}`,
            model: request.model,
            content: [
              { type: "tool_use", id, name: `mcp__host__${name}`, input: args },
            ],
            stop_reason: "tool_use",
          },
        });
        events.push({
          type: "host_tool_request",
          sequence: ++sequence,
          attribution: { claudeSessionId: sessionId },
          call: { type: "tool_call", id, name, arguments: args },
        });
      };
      return {
        events,
        async submitPrompt() {
          if (++prompts === 1)
            emit({
              type: "system",
              subtype: "init",
              session_id: sessionId,
              model: request.model,
              claude_code_version: "2.1.285",
              tools: [],
              mcp_servers: [],
            });
          if (request.resume.mode === "replay" || prompts > 1) answer();
          else propose("bash", { command: "original" });
        },
        async deliverToolResults(results) {
          delivered.push(...results);
          if (results.some((r) => r.toolName === "bash"))
            propose("read", { path: "fixture" });
          else answer();
        },
        async answerInteraction() {},
        async interrupt() {},
        async close() {
          events.end();
        },
      };
    },
  };
  const runtime = createClaudeRuntime({ driver });
  const configuration = readRuntimeConfiguration({ PI_CLAUDE_DRIVER: kind });
  const model = {
    ...getBundledModel("anthropic", "claude-haiku-4-5-20251001"),
    provider: "pi-claude-cli",
    api: "pi-claude-cli",
  };
  const agent = new Agent({
    initialState: {
      model,
      systemPrompt: [],
      disableReasoning: true,
      tools: [
        {
          name: "bash",
          label: "Native dispatch fixture",
          description: "Offline command fixture",
          parameters: type({ command: "string" }),
          async execute(_id, args) {
            executed.push(args.command);
            return {
              content: [{ type: "text", text: `Executed ${args.command}` }],
            };
          },
        },
        {
          name: "read",
          label: "Native read fixture",
          description: "Offline read fixture",
          parameters: type({ path: "string" }),
          async execute() {
            return { content: [{ type: "text", text: "fixture content" }] };
          },
        },
      ],
    },
    convertToLlm,
    sessionId: "native-rewrite",
    beforeToolCall({ toolCall, args }) {
      if (toolCall.name !== "bash") return;
      mutations++;
      return { args: { ...args, command: "rewritten" } };
    },
    streamFn: (model, context, options = {}) => {
      const request = toRequest(
        model,
        context,
        options,
        configuration,
        { sessionId: "native-rewrite", branchId: "root", historyRevision: "0" },
        process.cwd(),
      );
      requests.push(request);
      return projectRound(model, request, options, runtime, { driver: kind });
    },
  });
  try {
    await agent.prompt("Use the native fixtures");
    assert.equal(agent.state.error, undefined);
    assert.equal(mutations, 1);
    assert.deepEqual(executed, ["rewritten"]);
    const recorded = requests[1].transcript.find((m) => m.role === "assistant");
    assert.equal(
      recorded?.content.find((b) => b.type === "tool_call")?.arguments.command,
      "rewritten",
    );
    assert.deepEqual(
      opened.map((r) => r.resume.mode),
      ["fresh"],
    );
    assert.deepEqual(
      delivered.map((r) => r.toolName),
      ["bash", "read"],
    );
    await agent.prompt("Remember the executed command");
    assert.equal(agent.state.error, undefined);
    assert.equal(requests.length, 4);
    assert.equal(opened.length, 1);
    evidence.push({
      driver: kind,
      nativeArgumentRevisions: mutations,
      executed,
      residentOpens: opened.length,
      delivered: delivered.map((r) => r.toolName),
      followup: true,
    });
  } finally {
    await runtime.closeAll();
  }
}
console.log(JSON.stringify({ evidence, inference: false }));
