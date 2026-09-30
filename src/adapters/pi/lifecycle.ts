import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type {
  ClaudeRuntime,
  HistoryInvalidationReason,
  HostSessionIdentity,
} from "../../contracts/index.js";

export interface PiSessionState {
  identity: HostSessionIdentity;
  cwd: string;
  parentId?: string;
  claudeSessionId?: string;
  active: boolean;
  parked: boolean;
  retired: boolean;
  generation: number;
  cleanup: Promise<void>;
  contextSignal?: AbortSignal;
  controller?: AbortController;
  releaseSignal?: () => void;
}

/** Owns host identity and cancellation; Claude history reconciliation stays in core. */
export class PiLifecycle {
  private readonly sessions = new Map<string, PiSessionState>();
  private currentId?: string;
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
  private create(
    sessionId: string,
    cwd: string,
    parentId?: string,
  ): PiSessionState {
    const state: PiSessionState = {
      identity: { sessionId, branchId: "main", historyRevision: "0" },
      cwd,
      parentId,
      active: false,
      parked: false,
      retired: false,
      generation: 0,
      cleanup: Promise.resolve(),
    };
    this.sessions.set(sessionId, state);
    return state;
  }
  private capture(ctx: ExtensionContext): PiSessionState {
    const sessionId = ctx.sessionManager.getSessionId();
    const state =
      this.sessions.get(sessionId) ?? this.create(sessionId, ctx.cwd);
    state.cwd = ctx.cwd;
    state.contextSignal = ctx.signal;
    this.currentId = sessionId;
    return state;
  }
  session(providerSessionId?: string): PiSessionState {
    const current = this.currentId
      ? this.sessions.get(this.currentId)
      : undefined;
    if (!current)
      throw new Error("Pi session_start must run before the provider round");
    if (!providerSessionId || providerSessionId === current.identity.sessionId)
      return current;
    // Pi summaries and extension subagents may supply an independent routing ID.
    return (
      this.sessions.get(providerSessionId) ??
      this.create(providerSessionId, current.cwd, current.identity.sessionId)
    );
  }
  private enqueue(
    state: PiSessionState,
    operation: () => Promise<void>,
  ): Promise<void> {
    state.cleanup = state.cleanup.then(
      operation,
      async (previousError: unknown) => {
        await operation();
        throw previousError;
      },
    );
    void state.cleanup.catch(() => {}); // The next round/hook still awaits and reports this failure.
    return state.cleanup;
  }
  detach(state: PiSessionState): void {
    state.releaseSignal?.();
    state.releaseSignal = undefined;
  }
  invalidate(
    state: PiSessionState,
    reason: HistoryInvalidationReason,
    branchId = state.identity.branchId,
  ): Promise<void> {
    const previous = { ...state.identity };
    state.generation++;
    state.identity = {
      ...previous,
      branchId,
      historyRevision: String(Number(previous.historyRevision) + 1),
    };
    state.claudeSessionId = undefined;
    state.parked = false;
    this.detach(state);
    state.controller?.abort(new Error(`Pi session invalidated: ${reason}`));
    const pending = this.runtimePromise;
    return this.enqueue(state, async () => {
      if (pending) await (await pending).invalidate(previous, reason);
    });
  }
  bindAbort(state: PiSessionState, signal?: AbortSignal): AbortSignal {
    this.detach(state);
    state.controller = new AbortController();
    const controller = state.controller;
    if (signal) {
      const abort = () => {
        controller.abort(signal.reason);
        void this.invalidate(state, "abort");
      };
      signal.addEventListener("abort", abort, { once: true });
      state.releaseSignal = () => signal.removeEventListener("abort", abort);
      if (signal.aborted) abort();
    }
    return controller.signal;
  }
  async closeState(state: PiSessionState): Promise<void> {
    state.retired = true;
    state.generation++;
    state.parked = false;
    this.detach(state);
    state.controller?.abort(new Error("Pi session closed"));
    this.sessions.delete(state.identity.sessionId);
    const pending = this.runtimePromise;
    await this.enqueue(state, async () => {
      if (pending) await (await pending).close(state.identity.sessionId);
    });
  }
  private async closeFamily(state: PiSessionState): Promise<void> {
    const family = [...this.sessions.values()].filter(
      (item) => item === state || item.parentId === state.identity.sessionId,
    );
    await Promise.all(family.map((item) => this.closeState(item)));
    if (this.currentId === state.identity.sessionId) this.currentId = undefined;
  }
  private async closeAll(): Promise<void> {
    const pending = this.runtimePromise;
    this.runtimePromise = undefined;
    const states = [...this.sessions.values()];
    this.sessions.clear();
    this.currentId = undefined;
    for (const state of states) {
      state.retired = true;
      state.generation++;
      state.parked = false;
      this.detach(state);
      state.controller?.abort(new Error("Pi extension shut down"));
    }
    const cleanup = await Promise.allSettled(
      states.map((state) => state.cleanup),
    );
    if (pending) await (await pending).closeAll();
    const failures = cleanup.flatMap((result) =>
      result.status === "rejected" ? [result.reason as unknown] : [],
    );
    if (failures.length)
      throw new AggregateError(failures, "Pi session cleanup failed");
  }
  register(pi: ExtensionAPI): void {
    pi.on("session_start", async (event, ctx) => {
      const existed = this.sessions.has(ctx.sessionManager.getSessionId());
      const state = this.capture(ctx);
      if (event.reason === "reload" || (existed && event.reason !== "startup"))
        await this.invalidate(
          state,
          event.reason === "fork"
            ? "fork"
            : event.reason === "reload"
              ? "reload"
              : "import",
        );
      else if (event.reason === "fork")
        state.identity = {
          ...state.identity,
          branchId: `fork:${ctx.sessionManager.getLeafId() ?? "root"}`,
          historyRevision: "1",
        };
    });
    pi.on("before_agent_start", (_event, ctx) => {
      this.capture(ctx);
    });
    pi.on("context_with_system", (_event, ctx) => {
      this.capture(ctx);
    });
    pi.on("session_compact", async (_event, ctx) => {
      await this.invalidate(this.capture(ctx), "compaction");
    });
    pi.on("session_tree", async (event, ctx) => {
      await this.invalidate(
        this.capture(ctx),
        "tree",
        `tree:${event.newLeafId ?? "root"}`,
      );
    });
    pi.on("session_compact_failed", async (event, ctx) => {
      const state = this.capture(ctx);
      if (event.aborted && (state.parked || state.active))
        await this.invalidate(state, "abort");
    });
    pi.on("agent_end", async (_event, ctx) => {
      const state = this.capture(ctx);
      if (state.parked)
        await this.invalidate(state, ctx.signal?.aborted ? "abort" : "reset");
    });
    pi.on("session_shutdown", async (event, ctx) => {
      if (event.reason === "quit" || event.reason === "reload")
        await this.closeAll();
      else {
        const state = this.sessions.get(ctx.sessionManager.getSessionId());
        if (state) await this.closeFamily(state);
      }
    });
  }
}

/** Pi's HTTP idle bound becomes a driver-activity idle bound, suspended for host work. */
export function idleWatchdog(
  timeoutMs: number | undefined,
  timeout: () => void,
): { touch(): void; stop(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  const touch = () => {
    stop();
    if (timeoutMs !== undefined && timeoutMs > 0 && timeoutMs < 2_147_483_647)
      timer = setTimeout(timeout, timeoutMs);
  };
  return { touch, stop };
}
