import { randomUUID } from "node:crypto";
import type { SimpleStreamOptions } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import {
  VERSION,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  createConfiguredRuntime,
  readRuntimeConfiguration,
  type RuntimeConfiguration,
} from "../../../entrypoints/runtime.js";
import type {
  ClaudeRuntime,
  HostSessionIdentity,
} from "../../contracts/index.js";
import {
  payloadForHook,
  replacementRequest,
  toPiRequest,
} from "./normalize.js";
import { PiProjection } from "./projection.js";

export const PROVIDER_ID = "pi-claude-cli";
export const SUPPORTED_PI_VERSION = "0.99.1";
export function assertPiVersion(version: string): void {
  if (version !== SUPPORTED_PI_VERSION)
    throw new Error(
      `pi-claude-cli requires Pi ${SUPPORTED_PI_VERSION}; loaded ${version}`,
    );
}
export interface PiAdapterOptions {
  configuration?: RuntimeConfiguration;
  runtimeFactory?: (
    configuration: RuntimeConfiguration,
  ) => Promise<ClaudeRuntime>;
}

export function registerPiAdapter(
  pi: ExtensionAPI,
  options: PiAdapterOptions = {},
): void {
  assertPiVersion(VERSION);
  const configuration = options.configuration ?? readRuntimeConfiguration();
  const factory = options.runtimeFactory ?? createConfiguredRuntime;
  let runtimePromise: Promise<ClaudeRuntime> | undefined;
  let context: ExtensionContext | undefined;
  let session: HostSessionIdentity | undefined;
  const claudeIds = new Map<string, string>();
  const runtime = () => (runtimePromise ??= factory(configuration));
  pi.on("session_start", (_event, ctx) => {
    context = ctx;
    session = {
      sessionId: ctx.sessionManager.getSessionId(),
      branchId: "main",
      historyRevision: "0",
    };
  });
  pi.on("before_agent_start", (_event, ctx) => {
    context = ctx;
  });
  pi.registerProvider(PROVIDER_ID, {
    baseUrl: PROVIDER_ID,
    apiKey: "unused",
    api: PROVIDER_ID,
    models: getBuiltinModels("anthropic").map((model) => ({
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      input: model.input,
      cost: model.cost,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      thinkingLevelMap: model.thinkingLevelMap,
    })),
    streamSimple(model, transcript, streamOptions: SimpleStreamOptions = {}) {
      const projection = new PiProjection(model, []);
      void (async () => {
        let ownedRuntime: ClaudeRuntime | undefined;
        let activeSession: HostSessionIdentity | undefined;
        try {
          if (!context || !session)
            throw new Error(
              "Pi session_start must run before the provider round",
            );
          activeSession = { ...session };
          let request = toPiRequest(
            transcript,
            model,
            streamOptions,
            configuration,
            activeSession,
            context.cwd,
            randomUUID(),
          );
          const payload = payloadForHook(request);
          const replacement = await streamOptions.onPayload?.(payload, model);
          if (replacement !== undefined)
            request = replacementRequest(replacement, request);
          projection.setTools(request.tools);
          ownedRuntime = await runtime();
          let observed = false;
          for await (const event of ownedRuntime.streamRound(request)) {
            if (event.type === "driver_event") {
              if (event.event.type === "initialized")
                claudeIds.set(
                  activeSession.sessionId,
                  event.event.claudeSessionId,
                );
              if (!observed) {
                observed = true;
                const headers: Record<string, string> = {
                  "x-pi-claude-driver": configuration.driver,
                  "x-pi-claude-transport":
                    configuration.driver === "cli" ? "subprocess" : "agent-sdk",
                  "x-pi-claude-cost": "reported-estimate-usd",
                };
                const claudeId =
                  claudeIds.get(activeSession.sessionId) ??
                  event.event.attribution.claudeSessionId;
                if (claudeId) headers["x-pi-claude-session-id"] = claudeId;
                await streamOptions.onResponse?.({ status: 0, headers }, model);
              }
              await streamOptions.onProviderStreamEvent?.(
                structuredClone(event.event),
                model,
              );
            }
            projection.accept(event);
          }
          projection.finish();
        } catch (error) {
          if (ownedRuntime && activeSession)
            await ownedRuntime
              .invalidate(
                activeSession,
                streamOptions.signal?.aborted ? "abort" : "reset",
              )
              .catch(() => undefined);
          projection.fail(
            error,
            streamOptions.signal?.aborted ? "aborted" : "error",
          );
        }
      })();
      return projection.stream;
    },
  });
}
