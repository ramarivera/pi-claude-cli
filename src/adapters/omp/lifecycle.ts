import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type {
  ProviderSessionState,
  SimpleStreamOptions,
} from "@oh-my-pi/pi-ai";
import type {
  ClaudeDriverEvent,
  ClaudeRuntime,
  HistoryInvalidationReason,
  HostSessionIdentity,
} from "../../contracts/index.js";

export interface OmpSessionState {
  identity: HostSessionIdentity;
  hostSessionId: string;
  agentKey: string;
  context: ExtensionContext;
  cwd: string;
  generation: number;
  active: boolean;
  roundOwner?: symbol;
  parked: boolean;
  retired: boolean;
  cleanup: Promise<void>;
  claudeSessionId?: string;
  controller?: AbortController;
  detachAbort?: () => void;
  nativeMaps: Set<Map<string, ProviderSessionState>>;
  nativeKey: string;
}
class OmpProviderState implements ProviderSessionState {
  constructor(
    readonly owner: OmpLifecycle,
    readonly state: OmpSessionState,
  ) {}
  close(): void {
    this.owner.retire(this.state);
  }
}
function agentKey(ctx: ExtensionContext): string {
  return JSON.stringify([ctx.agent.kind, ctx.agent.id]);
}
function sessionKey(hostId: string, agent: string, routingId: string): string {
  return JSON.stringify([hostId, agent, routingId]);
}
function bounded(value: string): string {
  return value.replace(/\p{Cc}/gu, " ").slice(0, 120);
}

/** Native OMP provider-session teardown owns only the matching logical agent. */
export class OmpLifecycle {
  private readonly sessions = new Map<string, OmpSessionState>();
  private currentContext?: ExtensionContext;
  private runtimePromise?: Promise<ClaudeRuntime>;
  constructor(private readonly factory: () => Promise<ClaudeRuntime>) {}
  runtime(): Promise<ClaudeRuntime> {
    if (!this.runtimePromise) {
      const pending = this.factory();
      this.runtimePromise = pending;
      void pending.catch(() => {
        if (this.runtimePromise === pending) this.runtimePromise = undefined;
      });
    }
    return this.runtimePromise;
  }
  capture(ctx: ExtensionContext): void {
    this.currentContext = ctx;
    for (const state of this.forContext(ctx)) {
      state.context = ctx;
      state.cwd = ctx.cwd;
    }
  }
  private forContext(ctx: ExtensionContext): OmpSessionState[] {
    return [...this.sessions.values()].filter(
      (state) =>
        !state.retired &&
        state.hostSessionId === ctx.sessionManager.getSessionId() &&
        state.agentKey === agentKey(ctx),
    );
  }
  session(options: SimpleStreamOptions): OmpSessionState {
    const ctx = this.currentContext;
    if (!ctx)
      throw new Error(
        "OMP session_start or context must run before the provider round",
      );
    const hostId = ctx.sessionManager.getSessionId();
    const agent = agentKey(ctx);
    const key = sessionKey(hostId, agent, options.sessionId ?? hostId);
    const nativeKey = `pi-claude-cli:${agent}`;
    const existing = options.providerSessionState?.get(nativeKey);
    if (
      existing &&
      (!(existing instanceof OmpProviderState) || existing.owner !== this)
    )
      existing.close();
    let state = this.sessions.get(key);
    if (!state || state.retired) {
      const cleanup = state?.cleanup ?? Promise.resolve();
      state = {
        identity: {
          sessionId:
            ctx.agent.kind === "main" &&
            ctx.agent.id === "Main" &&
            (!options.sessionId || options.sessionId === hostId)
              ? hostId
              : key,
          branchId: "root",
          historyRevision: "0",
        },
        hostSessionId: hostId,
        agentKey: agent,
        context: ctx,
        cwd: options.cwd ?? ctx.cwd,
        generation: 0,
        active: false,
        parked: false,
        retired: false,
        cleanup,
        nativeMaps: new Set(),
        nativeKey,
      };
      this.sessions.set(key, state);
    }
    state.context = ctx;
    state.cwd = options.cwd ?? ctx.cwd;
    if (options.providerSessionState) {
      if (
        existing instanceof OmpProviderState &&
        existing.owner === this &&
        existing.state !== state
      )
        existing.close();
      options.providerSessionState.set(
        nativeKey,
        new OmpProviderState(this, state),
      );
      state.nativeMaps.add(options.providerSessionState);
    }
    return state;
  }
  detach(state: OmpSessionState): void {
    state.detachAbort?.();
    state.detachAbort = undefined;
    state.controller = undefined;
  }
  bindAbort(state: OmpSessionState, signal?: AbortSignal): AbortSignal {
    this.detach(state);
    const controller = new AbortController();
    state.controller = controller;
    const abort = () => {
      controller.abort(signal?.reason);
      void this.invalidate(state, "abort").catch((error: unknown) => {
        state.context.ui.setStatus(
          "pi-claude-cli-cleanup",
          `Claude cleanup failed: ${bounded(error instanceof Error ? error.message : "runtime error")}`,
        );
      });
    };
    if (signal) {
      signal.addEventListener("abort", abort, { once: true });
      state.detachAbort = () => signal.removeEventListener("abort", abort);
      if (signal.aborted) abort();
    }
    return controller.signal;
  }
  invalidate(
    state: OmpSessionState,
    reason: HistoryInvalidationReason,
  ): Promise<void> {
    const identity = { ...state.identity };
    state.generation++;
    state.identity.historyRevision = String(state.generation);
    if (reason === "tree" || reason === "branch" || reason === "fork")
      state.identity.branchId = `${reason}:${state.generation}`;
    state.claudeSessionId = undefined;
    state.parked = false;
    state.controller?.abort(reason);
    this.detach(state);
    state.context.ui.setStatus("pi-claude-cli-progress", undefined);
    const runtime = this.runtimePromise;
    state.cleanup = state.cleanup.then(async () => {
      if (runtime) await (await runtime).invalidate(identity, reason);
    });
    return state.cleanup;
  }
  retire(state: OmpSessionState): void {
    if (state.retired) return;
    state.retired = true;
    state.generation++;
    state.parked = false;
    state.controller?.abort("OMP provider session closed");
    this.detach(state);
    state.context.ui.setStatus("pi-claude-cli-progress", undefined);
    for (const map of state.nativeMaps) {
      const entry = map.get(state.nativeKey);
      if (
        entry instanceof OmpProviderState &&
        entry.owner === this &&
        entry.state === state
      )
        map.delete(state.nativeKey);
    }
    const runtime = this.runtimePromise;
    state.cleanup = state.cleanup.then(async () => {
      if (runtime) await (await runtime).close(state.identity.sessionId);
    });
    // Native close() is synchronous; retain cleanup for subsequent awaited lifecycle hooks.
    void state.cleanup.catch((error: unknown) => {
      state.context.ui.setStatus(
        "pi-claude-cli-cleanup",
        `Claude cleanup failed: ${bounded(error instanceof Error ? error.message : "runtime error")}`,
      );
    });
  }
  observe(
    api: ExtensionAPI,
    state: OmpSessionState,
    event: ClaudeDriverEvent,
  ): void {
    if (!event.attribution.parentToolUseId && !event.attribution.agentId) {
      if (event.type === "initialized")
        state.claudeSessionId = event.claudeSessionId;
      else if (event.attribution.claudeSessionId)
        state.claudeSessionId = event.attribution.claudeSessionId;
    }
    if (event.type !== "observation") return;
    if (
      ![
        "task",
        "tool-progress",
        "status",
        "retry",
        "rate-limit",
        "compaction",
      ].includes(event.family)
    )
      return;
    const attribution = Object.entries(event.attribution)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => `${key}=${bounded(String(value))}`)
      .join(" ");
    state.context.ui.setStatus(
      "pi-claude-cli-progress",
      `Claude ${event.family}: ${bounded(event.subtype)}${attribution ? ` [${attribution}]` : ""}`,
    );
    api.events.emit("pi-claude-cli:observation", {
      owner: "claude",
      hostSession: { ...state.identity },
      hostAgent: { ...state.context.agent },
      event: structuredClone(event),
    });
  }
  unsupportedSteering(
    api: ExtensionAPI,
    state: OmpSessionState,
    driver: "cli" | "sdk",
  ): void {
    state.context.ui.setStatus(
      "pi-claude-cli-steering",
      `Claude ${driver}: live steering unsupported; queued input stays with OMP`,
    );
    api.events.emit("pi-claude-cli:capability", {
      capability: "live-steering",
      supported: false,
      driver,
      owner: "claude",
      hostSession: { ...state.identity },
      hostAgent: { ...state.context.agent },
    });
  }
  register(api: ExtensionAPI): void {
    api.on("session_start", async (_event, ctx) => {
      const existing = this.forContext(ctx);
      this.capture(ctx);
      await Promise.all(
        existing.map((state) => this.invalidate(state, "reload")),
      );
    });
    api.on("before_agent_start", (_event, ctx) => this.capture(ctx));
    api.on("context", (_event, ctx) => this.capture(ctx));
    api.on("session_compact", async (_event, ctx) => {
      this.capture(ctx);
      await Promise.all(
        this.forContext(ctx).map((state) =>
          this.invalidate(state, "compaction"),
        ),
      );
    });
    api.on("session_tree", async (_event, ctx) => {
      this.capture(ctx);
      await Promise.all(
        this.forContext(ctx).map((state) => this.invalidate(state, "tree")),
      );
    });
    api.on("session_before_switch", async (event, ctx) => {
      this.capture(ctx);
      const states = this.forContext(ctx);
      await Promise.all(
        states.map((state) =>
          this.invalidate(
            state,
            event.reason === "fork"
              ? "fork"
              : event.reason === "resume"
                ? "reload"
                : "reset",
          ),
        ),
      );
      for (const state of states) this.retire(state);
      await Promise.all(states.map((state) => state.cleanup));
    });
    api.on("session_switch", (_event, ctx) => this.capture(ctx));
    api.on("session_before_branch", async (_event, ctx) => {
      this.capture(ctx);
      const states = this.forContext(ctx);
      await Promise.all(
        states.map((state) => this.invalidate(state, "branch")),
      );
      for (const state of states) this.retire(state);
      await Promise.all(states.map((state) => state.cleanup));
    });
    api.on("session_branch", async (_event, ctx) => {
      this.capture(ctx);
      await Promise.all(
        this.forContext(ctx).map((state) => this.invalidate(state, "branch")),
      );
    });
    api.on("agent_end", async (event, ctx) => {
      if (event.willContinue) return;
      for (const state of this.forContext(ctx))
        if (state.parked) await this.invalidate(state, "abort");
    });
    api.on("session_shutdown", async (_event, ctx) => {
      const states = [...this.sessions.values()].filter(
        (state) => state.agentKey === agentKey(ctx),
      );
      for (const state of states) this.retire(state);
      await Promise.all(states.map((state) => state.cleanup));
      if (
        [...this.sessions.values()].every((state) => state.retired) &&
        this.runtimePromise
      )
        await (await this.runtimePromise).closeAll();
    });
  }
}

/** Await hooks/runtime setup under the same owned round cancellation. */
export function withSignal<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return operation;
  return new Promise<T>((resolve, reject) => {
    const aborted = () => {
      signal.removeEventListener("abort", aborted);
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error("OMP provider request aborted"),
      );
    };
    operation.then(
      (result) => {
        signal.removeEventListener("abort", aborted);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", aborted);
        reject(error);
      },
    );
    if (signal.aborted) aborted();
    else signal.addEventListener("abort", aborted, { once: true });
  });
}

/** OMP clears these managed timers on shutdown; terminal rounds clear them sooner. */
export function nativeWatchdog(
  ctx: ExtensionContext,
  options: SimpleStreamOptions,
  expire: (error: Error) => void,
): { touch(): void; stop(): void } {
  for (const value of [
    options.streamFirstEventTimeoutMs,
    options.streamIdleTimeoutMs,
  ])
    if (
      value !== undefined &&
      (!Number.isSafeInteger(value) || value < 0 || value > 2_147_483_647)
    )
      throw new Error(
        "OMP stream timeout must be an integer between 0 and 2147483647 ms",
      );
  let timer: ReturnType<ExtensionContext["setTimeout"]> | undefined;
  let stopped = false;
  const stopTimer = () => {
    if (timer !== undefined) ctx.clearTimer(timer);
    timer = undefined;
  };
  const arm = (milliseconds: number | undefined, phase: string) => {
    stopTimer();
    if (stopped || !milliseconds) return;
    timer = ctx.setTimeout(() => {
      timer = undefined;
      stopped = true;
      expire(new Error(`Claude ${phase} timeout after ${milliseconds}ms`));
    }, milliseconds);
  };
  arm(options.streamFirstEventTimeoutMs, "first event");
  return {
    touch() {
      arm(options.streamIdleTimeoutMs, "stream idle");
    },
    stop() {
      stopped = true;
      stopTimer();
    },
  };
}
