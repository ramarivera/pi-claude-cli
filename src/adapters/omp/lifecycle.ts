import { randomUUID } from "node:crypto";
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
import { diagnosticId, projectOmpDiagnostic } from "./diagnostics.js";

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
  key: string;
  disposable: boolean;
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
  private runtimeSlot?: {
    pending: Promise<ClaudeRuntime>;
    value?: ClaudeRuntime;
  };
  private readonly deferredCleanupErrors: unknown[] = [];
  private api?: ExtensionAPI;
  constructor(private readonly factory: () => Promise<ClaudeRuntime>) {}
  runtime(owner?: OmpSessionState): Promise<ClaudeRuntime> {
    const generation = owner?.generation;
    if (this.deferredCleanupErrors.length)
      throw new AggregateError(
        this.deferredCleanupErrors.splice(0),
        "OMP deferred runtime cleanup failed",
      );
    if (!this.runtimeSlot) {
      const slot = {
        pending: this.factory(),
        value: undefined as ClaudeRuntime | undefined,
      };
      this.runtimeSlot = slot;
      void slot.pending.then(
        (value) => {
          slot.value = value;
        },
        () => {
          if (this.runtimeSlot === slot) this.runtimeSlot = undefined;
        },
      );
    }
    const pending = this.runtimeSlot.pending;
    // A factory may trigger native cancellation before its pending slot is recorded.
    if (
      owner &&
      (owner.retired ||
        owner.generation !== generation ||
        owner.controller?.signal.aborted)
    )
      this.runtimeForCleanup(owner);
    return pending;
  }
  private runtimeForCleanup(
    exclude?: OmpSessionState,
  ): ClaudeRuntime | undefined {
    const slot = this.runtimeSlot;
    if (!slot || slot.value) return slot?.value;
    if (
      ![...this.sessions.values()].some(
        (state) =>
          state !== exclude &&
          !state.retired &&
          (state.active || state.parked) &&
          !state.controller?.signal.aborted,
      )
    ) {
      this.runtimeSlot = undefined;
      void slot.pending
        .then(
          (runtime) => runtime.closeAll(),
          () => {},
        )
        .catch((error: unknown) => {
          this.deferredCleanupErrors.push(error);
        });
    }
    return undefined;
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
    const disposable = !options.sessionId && !options.providerSessionState;
    const routingId = disposable ? randomUUID() : (options.sessionId ?? hostId);
    const key = sessionKey(hostId, agent, routingId);
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
          sessionId: disposable
            ? routingId
            : ctx.agent.kind === "main" &&
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
        key,
        disposable,
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
        this.reportCleanup(state, error);
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
    if (!state.disposable)
      state.context.ui.setStatus("pi-claude-cli-progress", undefined);
    const runtime = this.runtimeForCleanup(state);
    state.cleanup = state.cleanup.then(async () => {
      if (runtime) await runtime.invalidate(identity, reason);
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
    if (!state.disposable)
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
    const runtime = this.runtimeForCleanup(state);
    const close = async () => {
      if (runtime) await runtime.close(state.identity.sessionId);
    };
    state.cleanup = state.cleanup.then(close, async (previous: unknown) => {
      await close();
      throw previous;
    });
    if (state.disposable)
      void state.cleanup.then(
        () => {
          if (this.sessions.get(state.key) === state)
            this.sessions.delete(state.key);
        },
        () => {},
      );
    // Native close() is synchronous; retain cleanup for subsequent awaited lifecycle hooks.
    void state.cleanup.catch((error: unknown) => {
      this.reportCleanup(state, error);
    });
  }
  async closeState(state: OmpSessionState): Promise<void> {
    this.retire(state);
    await state.cleanup;
  }
  private reportCleanup(state: OmpSessionState, error: unknown): void {
    const message = `Claude cleanup failed: ${bounded(error instanceof Error ? error.message : "runtime error")}`;
    this.api?.logger.error(message);
    state.context.ui.notify(message, "error");
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
    const diagnostic = projectOmpDiagnostic(event);
    if (diagnostic) {
      api.events.emit("pi-claude-cli:diagnostic", {
        owner: "claude",
        callScope: state.disposable ? "auxiliary" : "session",
        hostSession: {
          sessionId: diagnosticId(state.identity.sessionId),
          branchId: diagnosticId(state.identity.branchId),
          historyRevision: diagnosticId(state.identity.historyRevision),
        },
        hostAgent: {
          kind:
            state.context.agent.kind === "main" ||
            state.context.agent.kind === "sub"
              ? state.context.agent.kind
              : undefined,
          id: diagnosticId(state.context.agent.id),
          parentId: diagnosticId(state.context.agent.parentId),
        },
        event: diagnostic,
      });
      return;
    }
    if (
      state.disposable ||
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
      .filter(([key]) =>
        [
          "claudeSessionId",
          "turnId",
          "messageId",
          "parentToolUseId",
          "toolUseId",
          "taskId",
          "agentId",
        ].includes(key),
      )
      .flatMap(([key, value]) => {
        const id = diagnosticId(value);
        return id ? [[key, id] as const] : [];
      });
    // setStatus adds a plain extension row beneath OMP's prompt bar. Routine
    // runtime metadata belongs in its file logger, not in the interactive footer.
    api.logger.debug(`Claude ${event.family}: ${bounded(event.subtype)}`, {
      owner: "claude",
      hostSessionId: diagnosticId(state.identity.sessionId),
      hostAgentId: diagnosticId(state.context.agent.id),
      sequence: event.sequence,
      attribution: Object.fromEntries(attribution),
    });
    api.events.emit("pi-claude-cli:observation", {
      owner: "claude",
      hostSession: { ...state.identity },
      hostAgent: { ...state.context.agent },
      event: structuredClone(event),
    });
  }
  register(api: ExtensionAPI): void {
    this.api = api;
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
      const cleanup = await Promise.allSettled(
        states.map((state) => state.cleanup),
      );
      const failures: unknown[] = cleanup.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (
        [...this.sessions.values()].every((state) => state.retired) &&
        this.runtimeSlot
      ) {
        const slot = this.runtimeSlot;
        this.runtimeSlot = undefined;
        if (slot.value) {
          try {
            await slot.value.closeAll();
          } catch (error) {
            failures.push(error);
          }
        } else
          void slot.pending
            .then(
              (runtime) => runtime.closeAll(),
              () => {},
            )
            .catch((error: unknown) => {
              this.deferredCleanupErrors.push(error);
            });
      }
      if (failures.length)
        throw new AggregateError(failures, "OMP runtime cleanup failed");
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
