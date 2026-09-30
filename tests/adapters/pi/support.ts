import { vi } from "vitest";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import type {
  Api,
  Model,
  AssistantMessage,
  AssistantMessageEvent,
} from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionEvent,
  ProviderConfig,
} from "@earendil-works/pi-coding-agent";
import type {
  ClaudeRuntime,
  ClaudeRoundEvent,
  DriverEventPayload,
  ClaudeDriverEvent,
  HostRoundRequest,
} from "../../../src/contracts/index.js";
import { readRuntimeConfiguration } from "../../../entrypoints/config.js";

export const configuration = readRuntimeConfiguration({});
export const model: Model<Api> = {
  ...getBuiltinModels("anthropic").find((item) => item.reasoning)!,
  api: "pi-claude-cli",
  provider: "pi-claude-cli",
};
export const tool = {
  name: "custom",
  description: "Native tool",
  owner: "host" as const,
  inputSchema: {
    type: "object",
    properties: { input: { type: "string" } },
    required: ["input"],
  },
};
export function driver(
  payload: DriverEventPayload,
  sequence = 1,
): ClaudeRoundEvent {
  return {
    type: "driver_event",
    roundId: "r",
    event: {
      ...payload,
      attribution: { claudeSessionId: "claude-real" },
      sequence,
    } as ClaudeDriverEvent,
  };
}
export const initialized = () =>
  driver({
    type: "initialized",
    claudeSessionId: "claude-real",
    model: model.id,
    runtimeVersion: "2.1",
    capabilities: [],
    tools: [],
    mcpServers: [],
  });
export function runtime(
  events: ClaudeRoundEvent[],
): ClaudeRuntime & { requests: HostRoundRequest[] } {
  const requests: HostRoundRequest[] = [];
  return {
    requests,
    streamRound: vi.fn(async function* (request) {
      requests.push(request);
      yield* events;
    }),
    invalidate: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    closeAll: vi.fn(async () => {}),
  };
}
export function host() {
  let provider: ProviderConfig | undefined;
  const handlers = new Map<
    string,
    (event: ExtensionEvent, context: ExtensionContext) => unknown
  >();
  const pi = {
    on: vi.fn(
      (
        event: string,
        handler: (event: ExtensionEvent, context: ExtensionContext) => unknown,
      ) => {
        handlers.set(event, handler);
        return () => {};
      },
    ),
    registerProvider: vi.fn((_name: string, config: ProviderConfig) => {
      provider = config;
    }),
    setActiveTools: vi.fn(),
    getAllTools: vi.fn(() => {
      throw new Error("Configured inventory must never be read");
    }),
  } as unknown as ExtensionAPI;
  const context = {
    cwd: "/native/cwd",
    sessionManager: {
      getSessionId: () => "host-session",
      getLeafId: () => "changing-leaf",
    },
  } as unknown as ExtensionContext;
  return {
    pi,
    context,
    emit: async (event: ExtensionEvent, ctx = context) => {
      await handlers.get(event.type)?.(event, ctx);
    },
    provider: () => {
      if (!provider?.streamSimple) throw new Error("Provider not registered");
      return provider as ProviderConfig & {
        streamSimple: NonNullable<ProviderConfig["streamSimple"]>;
      };
    },
  };
}
export function assistant(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: model.api,
    model: model.id,
    provider: model.provider,
    stopReason,
    timestamp: 1,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}
export async function collect(
  stream: AsyncIterable<AssistantMessageEvent>,
): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(structuredClone(event));
  return events;
}
