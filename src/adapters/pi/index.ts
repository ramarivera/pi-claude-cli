import { randomUUID } from "node:crypto";
import type { SimpleStreamOptions } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { VERSION, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createConfiguredRuntime,
  readRuntimeConfiguration,
  type RuntimeConfiguration,
} from "../../../entrypoints/runtime.js";
import type { ClaudeRuntime } from "../../contracts/index.js";
import {
  payloadForHook,
  replacementRequest,
  toPiRequest,
} from "./normalize.js";
import { PiProjection } from "./projection.js";
import { PiLifecycle, idleWatchdog, type PiSessionState } from "./lifecycle.js";

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
  const lifecycle = new PiLifecycle(() => factory(configuration));
  lifecycle.register(pi);
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
      thinkingLevelMap: model.reasoning
        ? { ...model.thinkingLevelMap, minimal: null }
        : model.thinkingLevelMap,
    })),
    streamSimple(model, transcript, streamOptions: SimpleStreamOptions = {}) {
      const projection = new PiProjection(model, []);
      void (async () => {
        let ownedRuntime: ClaudeRuntime | undefined;
        let state: PiSessionState | undefined;
        let generation: number | undefined;
        let ownsRound = false;
        let timeoutError: Error | undefined;
        const watchdog = idleWatchdog(streamOptions.timeoutMs, () => {
          timeoutError = new Error(
            `Claude provider stream was idle for ${streamOptions.timeoutMs}ms`,
          );
          if (state) void lifecycle.invalidate(state, "reset");
        });
        try {
          state = lifecycle.session(streamOptions.sessionId);
          if (state.active)
            throw new Error(
              "Concurrent Pi provider rounds for one session aren't supported",
            );
          state.active = true;
          ownsRound = true;
          await state.cleanup;
          generation = state.generation;
          const hostSignal = streamOptions.signal ?? state.contextSignal;
          let request = toPiRequest(
            transcript,
            model,
            { ...streamOptions, signal: hostSignal },
            configuration,
            { ...state.identity },
            state.cwd,
            randomUUID(),
          );
          request.signal = lifecycle.bindAbort(state, hostSignal);
          if (request.signal.aborted)
            throw new Error("Pi provider round was aborted before it started");
          watchdog.touch();
          const payload = payloadForHook(request);
          const replacement = await streamOptions.onPayload?.(payload, model);
          if (replacement !== undefined)
            request = replacementRequest(replacement, request);
          projection.setTools(request.tools);
          ownedRuntime = await lifecycle.runtime();
          if (
            state.retired ||
            generation !== state.generation ||
            request.signal?.aborted
          )
            throw (
              timeoutError ??
              new Error(
                "Pi provider round was invalidated before runtime initialization",
              )
            );
          let observed = false;
          for await (const event of ownedRuntime.streamRound(request)) {
            if (timeoutError) throw timeoutError;
            if (
              (state.retired || generation !== state.generation) &&
              !(
                event.type === "round_end" &&
                (event.reason === "aborted" || event.reason === "error")
              )
            )
              throw new Error(
                "Pi provider round was invalidated while streaming",
              );
            if (event.type === "driver_event") {
              watchdog.touch();
              if (event.event.type === "initialized")
                state.claudeSessionId = event.event.claudeSessionId;
              if (!observed) {
                observed = true;
                const headers: Record<string, string> = {
                  "x-pi-claude-driver": configuration.driver,
                  "x-pi-claude-transport":
                    configuration.driver === "cli" ? "subprocess" : "agent-sdk",
                  "x-pi-claude-cost": "reported-estimate-usd",
                };
                const claudeId =
                  state.claudeSessionId ??
                  event.event.attribution.claudeSessionId;
                if (claudeId) headers["x-pi-claude-session-id"] = claudeId;
                await streamOptions.onResponse?.({ status: 0, headers }, model);
              }
              await streamOptions.onProviderStreamEvent?.(
                structuredClone(event.event),
                model,
              );
            }
            if (event.type === "round_end") {
              watchdog.stop();
              state.parked = event.reason === "toolUse";
              if (!state.parked) lifecycle.detach(state);
              if (
                (event.reason === "error" || event.reason === "aborted") &&
                generation === state.generation
              )
                await lifecycle.invalidate(
                  state,
                  event.reason === "aborted" ? "abort" : "reset",
                );
              if (state.parentId && !state.parked)
                await lifecycle.closeState(state);
            }
            projection.accept(event);
          }
          projection.finish();
        } catch (caught) {
          let error: unknown = caught;
          const aborted =
            streamOptions.signal?.aborted ||
            state?.contextSignal?.aborted ||
            state?.retired ||
            (generation !== undefined && generation !== state?.generation);
          if (
            ownsRound &&
            state &&
            generation !== undefined &&
            generation === state.generation
          ) {
            try {
              await lifecycle.invalidate(
                state,
                streamOptions.signal?.aborted ? "abort" : "reset",
              );
            } catch (cleanupError) {
              error = new Error(
                `${error instanceof Error ? error.message : String(error)}; Claude cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
              );
            }
          }
          if (ownsRound && state) {
            try {
              await state.cleanup;
            } catch (cleanupError) {
              error = new Error(
                `${String(error)}; Claude cleanup failed: ${String(cleanupError)}`,
              );
            }
          }
          if (ownsRound && state?.parentId && !state.retired) {
            try {
              await lifecycle.closeState(state);
            } catch (cleanupError) {
              error = new Error(
                `${String(error)}; Claude cleanup failed: ${String(cleanupError)}`,
              );
            }
          }
          projection.fail(
            timeoutError ?? error,
            !timeoutError && aborted ? "aborted" : "error",
          );
        } finally {
          watchdog.stop();
          if (ownsRound && state) {
            state.active = false;
            if (!state.parked) lifecycle.detach(state);
          }
        }
      })();
      return projection.stream;
    },
  });
}
