import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { createAssistantMessageEventStream } from "@oh-my-pi/pi-ai";
import { VERSION } from "@oh-my-pi/pi-coding-agent";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import {
  createConfiguredRuntime,
  readRuntimeConfiguration,
} from "../../../entrypoints/runtime.js";
import type { RuntimeConfiguration } from "../../../entrypoints/runtime.js";
import type { ClaudeRuntime } from "../../contracts/index.js";
import { replacePayload, toRequest } from "./request.js";
import { projectRound } from "./stream.js";

export const OMP_VERSION = "18.4.4";
export function assertOmpVersion(version: string): void {
  if (version !== OMP_VERSION)
    throw new Error(
      `pi-claude-cli requires OMP ${OMP_VERSION}; loaded ${version}`,
    );
}
export interface OmpAdapterOptions {
  configuration?: RuntimeConfiguration;
  runtimeFactory?: (
    configuration: RuntimeConfiguration,
  ) => Promise<ClaudeRuntime>;
}
export function registerOmpAdapter(
  api: ExtensionAPI,
  options: OmpAdapterOptions = {},
): void {
  assertOmpVersion(VERSION);
  const configuration = options.configuration ?? readRuntimeConfiguration();
  const runtime = (options.runtimeFactory ?? createConfiguredRuntime)(
    configuration,
  );
  // Lifecycle bindings are added in the second scoped checkpoint.
  let cwd = process.cwd();
  let sessionId: string = crypto.randomUUID();
  api.on("session_start", (_event, ctx) => {
    cwd = ctx.cwd;
    sessionId = ctx.sessionManager.getSessionId();
  });
  api.registerProvider("pi-claude-cli", {
    api: "pi-claude-cli",
    baseUrl: "claude-runtime://local",
    apiKey: "claude-runtime-owned",
    authHeader: false,
    models: getBundledModels("anthropic")
      .filter(
        (model) => model.contextWindow !== null && model.maxTokens !== null,
      )
      .map((model) => ({
        id: model.id,
        name: `${model.name} (Claude runtime)`,
        reasoning: model.reasoning,
        thinking: model.reasoning ? model.thinking : undefined,
        input: [...model.input],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: model.contextWindow!,
        maxTokens: model.maxTokens!,
      })),
    streamSimple(model, context, streamOptions = {}) {
      const output = createAssistantMessageEventStream();
      void (async () => {
        try {
          const request = toRequest(
            model,
            context,
            streamOptions,
            configuration,
            {
              sessionId: streamOptions.sessionId ?? sessionId,
              branchId: "root",
              historyRevision: "0",
            },
            cwd,
          );
          const replacement = await streamOptions.onPayload?.(
            request,
            model,
            streamOptions.signal,
          );
          const source = projectRound(
            model,
            replacePayload(request, replacement),
            streamOptions,
            await runtime,
            { driver: configuration.driver },
          );
          for await (const event of source) output.push(event);
          output.end(await source.result());
        } catch (error) {
          const reason = streamOptions.signal?.aborted ? "aborted" : "error";
          output.push({
            type: "error",
            reason,
            error: {
              role: "assistant",
              content: [],
              api: model.api,
              provider: model.provider,
              model: model.id,
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  total: 0,
                },
              },
              stopReason: reason,
              errorMessage:
                error instanceof Error
                  ? error.message
                  : "Claude OMP adapter failed",
              timestamp: Date.now(),
            },
          });
          output.end();
        }
      })();
      return output;
    },
  });
}
