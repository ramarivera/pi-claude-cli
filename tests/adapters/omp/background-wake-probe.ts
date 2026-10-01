import assert from "node:assert/strict";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { buildAsyncResultBatchMessage } from "@oh-my-pi/pi-coding-agent/session/async-job-delivery";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { readRuntimeConfiguration } from "../../../entrypoints/config.js";
import { toRequest } from "../../../src/adapters/omp/request.js";
import { projectRound } from "../../../src/adapters/omp/stream.js";
import type {
  ClaudeRoundEvent,
  ClaudeRuntime,
  HostRoundRequest,
} from "../../../src/contracts/index.js";

// Native notification assembly, conversion and Agent continuation; responses
// are scripted locally. This probe never opens a Claude session or uses HTTP.
const originalFetch = globalThis.fetch;
globalThis.fetch = () => {
  throw new Error("Background wake probe mustn't use HTTP");
};
const evidence = [];
try {
  for (const withImage of [false, true]) {
    const configuration = readRuntimeConfiguration({});
    const requests: HostRoundRequest[] = [];
    const runtime: ClaudeRuntime = {
      async *streamRound(request): AsyncIterable<ClaudeRoundEvent> {
        requests.push(request);
        yield {
          type: "round_end",
          roundId: request.roundId,
          reason: "stop",
          pendingToolCallIds: [],
          content: [{ type: "text", text: "Offline background wake response" }],
        };
      },
      async invalidate() {},
      async close() {},
      async closeAll() {},
    };
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
        tools: [],
      },
      convertToLlm,
      sessionId: "background-wake",
      streamFn: (model, context, options = {}) => {
        const request = toRequest(
          model,
          context,
          options,
          configuration,
          {
            sessionId: "background-wake",
            branchId: "root",
            historyRevision: "0",
          },
          process.cwd(),
        );
        return projectRound(model, request, options, runtime, {
          driver: "cli",
        });
      },
    });
    await agent.prompt("Start NuBreakingResearch");
    const job = withImage
      ? ({
          type: "task",
          label: "NuBreakingResearch",
          latestDetails: {
            images: [
              { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
            ],
          },
        } as Parameters<typeof buildAsyncResultBatchMessage>[0][number]["job"])
      : undefined;
    const notification = buildAsyncResultBatchMessage([
      {
        jobId: "NuBreakingResearch",
        result: "Research completed with distinctive marker",
        durationMs: 335000,
        epoch: 0,
        job,
      },
    ]);
    assert.ok(notification);
    assert.equal(notification.role, "custom");
    agent.appendMessage(notification);
    await agent.continue();
    assert.equal(agent.state.error, undefined);
    assert.equal(requests.length, 2);
    const wake = requests[1];
    assert.equal(wake.input.kind, "prompt");
    if (wake.input.kind !== "prompt")
      throw new Error("Expected notification prompt");
    assert.deepEqual(
      wake.input.messages?.map((message) => message.role),
      withImage ? ["developer", "user"] : ["developer"],
    );
    assert.ok(
      wake.input.content.some(
        (block) =>
          block.type === "text" && block.text.includes("distinctive marker"),
      ),
    );
    assert.equal(
      wake.input.content.filter((block) => block.type === "image").length,
      withImage ? 1 : 0,
    );
    await agent.prompt("Remember the completed research");
    assert.equal(agent.state.error, undefined);
    assert.equal(requests.length, 3);
    assert.deepEqual(
      requests[2].transcript.filter((message) => message.role === "developer"),
      wake.input.messages?.filter((message) => message.role === "developer"),
    );
    evidence.push({
      withImage,
      rounds: requests.length,
      roles: wake.input.messages?.map((message) => message.role),
    });
  }
} finally {
  globalThis.fetch = originalFetch;
}
console.log(JSON.stringify({ evidence, inference: false }));
