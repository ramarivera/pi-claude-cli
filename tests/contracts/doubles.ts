import {
  CONTRACT_VERSION,
  type ClaudeDriver,
  type ClaudeDriverEvent,
  type ClaudeDriverFactory,
  type ClaudeDriverSession,
  type ClaudeRoundEvent,
  type DriverEventPayload,
  type DriverKind,
  type DriverSessionRequest,
  type HostAdapter,
  type HostRoundRequest,
  type HostToolCall,
  type HostToolResult,
  type InteractionResponse,
} from "../../src/contracts/index.js";

/** Offline doubles verify the public seam, not either real runtime transport. */
class EventQueue implements AsyncIterable<ClaudeDriverEvent> {
  private items: ClaudeDriverEvent[] = [];
  private readers: ((result: IteratorResult<ClaudeDriverEvent>) => void)[] = [];
  private ended = false;

  push(event: ClaudeDriverEvent): void {
    if (this.ended) throw new Error("event pump closed");
    const reader = this.readers.shift();
    if (reader) reader({ done: false, value: event });
    else this.items.push(event);
  }

  end(): void {
    this.ended = true;
    for (const reader of this.readers.splice(0)) {
      reader({ done: true, value: undefined });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<ClaudeDriverEvent> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item) return Promise.resolve({ done: false, value: item });
        if (this.ended)
          return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve) => this.readers.push(resolve));
      },
    };
  }
}

interface ParkedCall {
  call: HostToolCall;
  promise: Promise<HostToolResult>;
  resolve: (result: HostToolResult) => void;
}

export class ContractSessionDouble implements ClaudeDriverSession {
  readonly events = new EventQueue();
  readonly delivered: HostToolResult[] = [];
  readonly prompts: string[] = [];
  readonly interactions: InteractionResponse[] = [];
  private sequence = 0;
  private closed = false;
  private calls = new Map<string, ParkedCall>();
  private completed = new Map<string, HostToolResult>();
  private earlyResults = new Map<string, HostToolResult>();
  private turnId: string | undefined;

  constructor(readonly request: DriverSessionRequest) {}

  private emit(payload: DriverEventPayload): void {
    this.events.push({
      ...payload,
      sequence: ++this.sequence,
      attribution: {
        claudeSessionId: "claude-double-session",
        turnId: this.turnId,
        parentToolUseId: null,
      },
    });
  }

  async submitPrompt(
    prompt: Parameters<ClaudeDriverSession["submitPrompt"]>[0],
  ): Promise<void> {
    if (this.closed) throw new Error("driver closed");
    this.turnId = prompt.turnId;
    this.prompts.push(prompt.turnId);
    this.emit({
      type: "initialized",
      claudeSessionId: "claude-double-session",
      model: this.request.model,
      runtimeVersion: "offline-double",
      capabilities: [],
      tools: this.request.tools.map((tool) => `mcp__host__${tool.name}`),
      mcpServers: [{ name: "host", status: "connected" }],
    });
  }

  requestHostTool(call: HostToolCall): Promise<HostToolResult> {
    if (this.closed) return Promise.reject(new Error("driver closed"));
    if (!call.id)
      return Promise.reject(new Error("missing authoritative tool_use id"));
    const existing = this.calls.get(call.id);
    if (existing) return existing.promise;
    const completed = this.completed.get(call.id);
    if (completed) return Promise.resolve(completed);

    let settle: ((result: HostToolResult) => void) | undefined;
    const promise = new Promise<HostToolResult>((resolve) => {
      settle = resolve;
    });
    if (!settle) throw new Error("promise failed to initialize");
    this.calls.set(call.id, { call, promise, resolve: settle });
    this.emit({ type: "host_tool_request", call });
    const early = this.earlyResults.get(call.id);
    if (early) {
      this.earlyResults.delete(call.id);
      this.deliverOne(early);
    }
    return promise;
  }

  private deliverOne(result: HostToolResult): void {
    if (this.completed.has(result.toolCallId)) return;
    const pending = this.calls.get(result.toolCallId);
    if (!pending) {
      this.earlyResults.set(result.toolCallId, result);
      return;
    }
    this.calls.delete(result.toolCallId);
    this.completed.set(result.toolCallId, result);
    this.delivered.push(result);
    pending.resolve(result);
  }

  async deliverToolResults(results: readonly HostToolResult[]): Promise<void> {
    if (this.closed) throw new Error("driver closed");
    for (const result of results) {
      if (!result.toolCallId) throw new Error("uncorrelated tool result");
      this.deliverOne(result);
    }
  }

  async answerInteraction(response: InteractionResponse): Promise<void> {
    if (this.closed) throw new Error("driver closed");
    this.interactions.push(response);
  }

  finishTurn(): void {
    if (this.calls.size) throw new Error("cannot finish a parked turn");
    this.emit({
      type: "turn_end",
      status: "success",
      subtype: "success",
      isError: false,
    });
  }

  async interrupt(reason = "Operation aborted"): Promise<void> {
    if (this.closed) return;
    for (const { call } of [...this.calls.values()]) {
      this.deliverOne({
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: "text", text: reason }],
        isError: true,
      });
    }
    this.earlyResults.clear();
    this.emit({
      type: "turn_end",
      status: "aborted",
      subtype: "aborted",
      isError: true,
      error: { code: "aborted", message: reason },
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    if (this.calls.size) await this.interrupt("Session closed");
    this.closed = true;
    this.emit({ type: "session_closed", reason: "closed" });
    this.events.end();
  }
}

export interface ContractDriverDouble extends ClaudeDriver {
  sessions: ContractSessionDouble[];
}

function createDriverDouble(kind: DriverKind): ContractDriverDouble {
  const sessions: ContractSessionDouble[] = [];
  return {
    kind,
    capabilities: {
      contractVersion: CONTRACT_VERSION,
      driver: kind,
      toolCorrelation: "claude-tool-use-meta",
      residentSessions: true,
      persistedResume: true,
      structuredToolResults: true,
      images: true,
      steering: "unsupported",
      interactions: ["permission"],
      supportedDialogKinds: [],
      forwardSubagentText: false,
    },
    sessions,
    openSession: async (request) => {
      const session = new ContractSessionDouble(request);
      sessions.push(session);
      return session;
    },
  };
}

export const createCliContractDouble: ClaudeDriverFactory = () =>
  createDriverDouble("cli");
export const createSdkContractDouble: ClaudeDriverFactory = () =>
  createDriverDouble("sdk");

export interface PiHostDoubleRequest {
  providerRound: HostRoundRequest;
  host: "pi";
}
export interface OmpHostDoubleRequest {
  providerRound: HostRoundRequest;
  host: "omp";
  editFormat: "hashline" | "replace" | "apply-patch";
}

export const piHostContractDouble: HostAdapter<
  PiHostDoubleRequest,
  ClaudeRoundEvent
> = {
  toRequest: (request) => request.providerRound,
  fromEvent: (event) => event,
};
export const ompHostContractDouble: HostAdapter<
  OmpHostDoubleRequest,
  ClaudeRoundEvent
> = {
  toRequest: (request) => request.providerRound,
  fromEvent: (event) => event,
};
