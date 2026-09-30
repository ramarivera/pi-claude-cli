import assert from "node:assert/strict";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { registerCustomApi, streamSimple } from "@oh-my-pi/pi-ai";
import type { SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createSettingsAwareStreamFn } from "@oh-my-pi/pi-coding-agent/session/settings-stream-fn";
import { resolveOpenAIWebsocketPreference } from "@oh-my-pi/pi-coding-agent/session/settings-stream-fn";
import { cfgThinkingBudgets } from "@oh-my-pi/pi-coding-agent/session/settings";
import { readRuntimeConfiguration } from "../../../entrypoints/config.js";
import { toRequest } from "../../../src/adapters/omp/request.js";
import { projectRound } from "../../../src/adapters/omp/stream.js";
import type {
  ClaudeRoundEvent,
  ClaudeRuntime,
  HostRoundRequest,
} from "../../../src/contracts/index.js";

let globalFetchCalls = 0;
let customFetchCalls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = () => {
  globalFetchCalls++;
  throw new Error("Native default regression mustn't make HTTP calls");
};
const evidence = [];
try {
  for (const driver of ["cli", "sdk"] as const) {
    const configuration = readRuntimeConfiguration({
      PI_CLAUDE_DRIVER: driver,
      PI_CLAUDE_MAX_OUTPUT_TOKENS: "512",
    });
    const settings = Settings.isolated();
    const requests: HostRoundRequest[] = [];
    const supplied: SimpleStreamOptions[] = [];
    const runtime: ClaudeRuntime = {
      async *streamRound(request): AsyncIterable<ClaudeRoundEvent> {
        requests.push(request);
        yield {
          type: "driver_event",
          roundId: request.roundId,
          event: {
            type: "initialized",
            sequence: 0,
            claudeSessionId: `offline-${driver}`,
            model: request.model,
            runtimeVersion: "offline",
            capabilities: [],
            tools: [],
            mcpServers: [],
            attribution: { claudeSessionId: `offline-${driver}` },
          },
        };
        yield {
          type: "round_end",
          roundId: request.roundId,
          reason: "stop",
          pendingToolCallIds: [],
          content: [{ type: "text", text: "offline native response" }],
        };
      },
      async invalidate() {},
      async close() {},
      async closeAll() {},
    };
    registerCustomApi("pi-claude-cli", (model, context, options = {}) => {
      supplied.push(options);
      const request = toRequest(
        model,
        context,
        options,
        configuration,
        { sessionId: "native-session", branchId: "root", historyRevision: "0" },
        process.cwd(),
      );
      return projectRound(model, request, options, runtime, { driver });
    });
    const model = {
      ...getBundledModel("anthropic", "claude-haiku-4-5-20251001"),
      provider: "pi-claude-cli",
      api: "pi-claude-cli",
    };
    const settingsAware = createSettingsAwareStreamFn(settings, streamSimple);
    const agent = new Agent({
      initialState: {
        model,
        systemPrompt: ["Native default distinctive system marker"],
        disableReasoning: true,
        tools: [],
      },
      cwd: process.cwd(),
      sessionId: "native-session",
      providerSessionState: new Map(),
      streamFn: (model, context, options) =>
        settingsAware(model, context, {
          ...options,
          // Match sdk.ts primaryStreamFn: these are supplied even with thinking off.
          thinkingBudgets: cfgThinkingBudgets.get(settings),
          preferWebsockets: resolveOpenAIWebsocketPreference(settings),
          ...(requests.length
            ? {
                fetch: () => {
                  customFetchCalls++;
                  throw new Error("Claude doesn't use custom OMP HTTP hooks");
                },
              }
            : {}),
        }),
    });
    await agent.prompt("first native prompt");
    assert.equal(agent.state.messages.at(-1)?.role, "assistant");
    assert.equal(agent.state.error, undefined);
    await agent.prompt("second native prompt");
    assert.equal(agent.state.error, undefined);
    assert.equal(requests.length, 2);
    assert.equal(
      supplied.every((options) => typeof options.fetch === "function"),
      true,
    );
    assert.equal(
      supplied.every((options) => options.thinkingBudgets?.high === 16384),
      true,
    );
    for (const request of requests) {
      assert.equal(request.settings.maxOutputTokens, 512);
      assert.equal(request.settings.effort, undefined);
      assert.equal(
        request.systemPrompt,
        "Native default distinctive system marker",
      );
    }
    assert.deepEqual(
      requests.map((request) => request.input),
      [
        {
          kind: "prompt",
          content: [{ type: "text", text: "first native prompt" }],
        },
        {
          kind: "prompt",
          content: [{ type: "text", text: "second native prompt" }],
        },
      ],
    );
    evidence.push({
      driver,
      rounds: requests.length,
      injectedFetch: true,
      injectedThinkingBudgets: true,
    });
  }
  assert.equal(globalFetchCalls, 0);
  assert.equal(customFetchCalls, 0);
  console.log(JSON.stringify({ evidence, globalFetchCalls, customFetchCalls }));
} finally {
  globalThis.fetch = originalFetch;
}
