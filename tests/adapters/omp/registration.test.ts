import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ProviderConfig } from "@oh-my-pi/pi-coding-agent";
import type { Model } from "@oh-my-pi/pi-ai";
import type {
  ClaudeRuntime,
  HostRoundRequest,
} from "../../../src/contracts/index.js";
import { readRuntimeConfiguration } from "../../../entrypoints/config.js";
vi.mock(
  "@oh-my-pi/pi-utils",
  async () => import("@oh-my-pi/pi-utils/fetch-retry"),
);
vi.mock("@oh-my-pi/pi-ai", async () => {
  const native = await import("@oh-my-pi/pi-ai/utils/event-stream");
  return {
    createAssistantMessageEventStream: native.createAssistantMessageEventStream,
  };
});
vi.mock("@oh-my-pi/pi-coding-agent", () => ({ VERSION: "18.4.4" }));
vi.mock("@oh-my-pi/pi-catalog/models", () => ({
  getBundledModels: () => [
    {
      id: "claude-haiku-4-5",
      name: "Haiku",
      reasoning: false,
      input: ["text", "image"],
      cost: {},
      contextWindow: 200000,
      maxTokens: 64000,
    },
  ],
}));
import {
  assertOmpVersion,
  registerOmpAdapter,
} from "../../../src/adapters/omp/index.js";
import entrypoint from "../../../entrypoints/omp.js";

function setup() {
  let provider: ProviderConfig | undefined;
  const registerProvider = vi.fn((id: string, config: ProviderConfig) => {
    expect(id).toBe("pi-claude-cli");
    provider = config;
  });
  const on = vi.fn();
  const api = { registerProvider, on } as unknown as ExtensionAPI;
  return {
    api,
    on,
    registerProvider,
    provider: () => {
      if (!provider) throw new Error("Provider missing");
      return provider;
    },
  };
}
describe("OMP discovery and native registration", () => {
  it("guards the exact approved native version", () => {
    expect(() => assertOmpVersion("18.4.4")).not.toThrow();
    expect(() => assertOmpVersion("18.4.3")).toThrow("requires OMP 18.4.4");
  });
  it("exposes a native default entrypoint", () => {
    expect(typeof entrypoint).toBe("function");
  });
  it("registers the provider and uses the shared configuration/runtime factory", async () => {
    const host = setup();
    const requests: HostRoundRequest[] = [];
    const backend: ClaudeRuntime = {
      async *streamRound(request) {
        requests.push(request);
        yield {
          type: "round_end",
          roundId: request.roundId,
          reason: "stop",
          content: [{ type: "text", text: "done" }],
          pendingToolCallIds: [],
        };
      },
      invalidate: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      closeAll: vi.fn(async () => {}),
    };
    const configuration = readRuntimeConfiguration({ PI_CLAUDE_DRIVER: "sdk" });
    const runtimeFactory = vi.fn(async () => backend);
    registerOmpAdapter(host.api, { configuration, runtimeFactory });
    expect(runtimeFactory).toHaveBeenCalledWith(configuration);
    expect(host.provider().models?.[0]).toMatchObject({
      id: "claude-haiku-4-5",
      reasoning: false,
      thinking: undefined,
    });
    const nativeStream = host.provider().streamSimple?.(
      {
        id: "claude-haiku-4-5",
        api: "pi-claude-cli",
        provider: "pi-claude-cli",
        reasoning: false,
      } as Model,
      { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
      {
        cwd: "/native-cwd",
        onPayload: (payload) => ({
          ...(payload as HostRoundRequest),
          systemPrompt: "hook",
        }),
      },
    );
    expect((await nativeStream?.result())?.content).toEqual([
      { type: "text", text: "done" },
    ]);
    expect(requests[0]).toMatchObject({
      cwd: "/native-cwd",
      systemPrompt: "hook",
      auth: { mode: "claude-login" },
    });
  });
});
