import * as OmpAI from "@oh-my-pi/pi-ai";
import type * as OmpCatalog from "@oh-my-pi/pi-catalog/models";
import { createAssistantMessageEventStream } from "@oh-my-pi/pi-ai";
import { VERSION } from "@oh-my-pi/pi-coding-agent";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import {
  createConfiguredRuntime,
  readRuntimeConfiguration,
} from "../../../entrypoints/runtime.js";
import type { RuntimeConfiguration } from "../../../entrypoints/runtime.js";
import {
  OmpLifecycle,
  nativeWatchdog,
  withSignal,
  type OmpSessionState,
} from "./lifecycle.js";
import type { ClaudeRuntime } from "../../contracts/index.js";
import { payloadForHook, replacePayload, toRequest } from "./request.js";
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
  // OMP's extension loader re-exports the native catalog from its retained ai root.
  // Type-only catalog import avoids resolving a second catalog in compiled hosts.
  const { getBundledModels } = OmpAI as typeof OmpAI &
    Pick<typeof OmpCatalog, "getBundledModels">;
  if (typeof getBundledModels !== "function")
    throw new Error("OMP native extension catalog export is unavailable");
  const configuration = options.configuration ?? readRuntimeConfiguration();
  const lifecycle = new OmpLifecycle(() =>
    (options.runtimeFactory ?? createConfiguredRuntime)(configuration),
  );
  lifecycle.register(api);
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
        let state: OmpSessionState | undefined;
        let ownsRound = false;
        const roundOwner = Symbol("OMP provider round");
        let generation: number | undefined;
        let timeoutError: Error | undefined;
        let watchdog: ReturnType<typeof nativeWatchdog> | undefined;
        try {
          state = lifecycle.session(streamOptions);
          if (state.active)
            throw new Error(
              "Concurrent OMP provider rounds for one logical agent aren't supported",
            );
          state.active = true;
          state.roundOwner = roundOwner;
          ownsRound = true;
          await state.cleanup;
          generation = state.generation;
          const signal = lifecycle.bindAbort(state, streamOptions.signal);
          if (signal.aborted)
            throw new Error("OMP provider round was aborted before it started");
          const request = toRequest(
            model,
            context,
            { ...streamOptions, signal },
            configuration,
            { ...state.identity },
            state.cwd,
          );
          const active = state;
          watchdog = nativeWatchdog(state.context, streamOptions, (error) => {
            timeoutError = error;
            active.controller?.abort(error);
            void lifecycle.invalidate(active, "reset").catch(() => {
              /* Cleanup is retained in active.cleanup. */
            });
          });
          if (streamOptions.liveSteering)
            lifecycle.unsupportedSteering(api, state, configuration.driver);
          const replacement = await withSignal(
            Promise.resolve(
              streamOptions.onPayload?.(
                payloadForHook(request),
                model,
                request.signal,
              ),
            ),
            request.signal,
          );
          const ownedRuntime = await withSignal(
            lifecycle.runtime(),
            request.signal,
          );
          if (
            state.retired ||
            generation !== state.generation ||
            request.signal?.aborted
          )
            throw new Error(
              "OMP provider round was invalidated before runtime initialization",
            );
          const activeState = state;
          const source = projectRound(
            model,
            replacePayload(request, replacement),
            { ...streamOptions, signal: request.signal },
            ownedRuntime,
            {
              driver: configuration.driver,
              claudeSessionId: activeState.claudeSessionId,
              restoration:
                !activeState.claudeSessionId &&
                request.input.kind === "prompt" &&
                request.transcript.length > 1
                  ? "user-history-replay"
                  : "runtime-managed",
              activity: () => watchdog?.touch(),
              failure: () => timeoutError,
              observe: (event) => lifecycle.observe(api, activeState, event),
              terminal: async (reason) => {
                watchdog?.stop();
                if (activeState.roundOwner === roundOwner)
                  activeState.active = false;
                activeState.parked = reason === "toolUse";
                if (!activeState.parked) {
                  lifecycle.detach(activeState);
                  activeState.context.ui.setStatus(
                    "pi-claude-cli-progress",
                    undefined,
                  );
                }
                if (
                  (reason === "error" || reason === "aborted") &&
                  generation === activeState.generation
                )
                  await lifecycle.invalidate(
                    activeState,
                    reason === "aborted" ? "abort" : "reset",
                  );
              },
            },
          );
          for await (const event of source) output.push(event);
          output.end(await source.result());
        } catch (error) {
          const reason =
            !timeoutError &&
            (streamOptions.signal?.aborted || state?.controller?.signal.aborted)
              ? "aborted"
              : "error";
          if (state && ownsRound && generation === state.generation) {
            try {
              await lifecycle.invalidate(
                state,
                reason === "aborted" ? "abort" : "reset",
              );
            } catch {
              /* Stream preserves the triggering error; cleanup remains tracked. */
            }
          }
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
                timeoutError?.message ??
                (error instanceof Error
                  ? error.message
                  : "Claude OMP adapter failed"),
              timestamp: Date.now(),
            },
          });
          output.end();
        } finally {
          watchdog?.stop();
          if (state && ownsRound && state.roundOwner === roundOwner) {
            state.active = false;
            state.roundOwner = undefined;
          }
        }
      })();
      return output;
    },
  });
}
