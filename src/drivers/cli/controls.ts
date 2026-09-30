import type {
  DriverSessionRequest,
  InteractionRequest,
  InteractionResponse,
  JsonObject,
  UnsequencedClaudeDriverEvent,
} from "../../contracts/index.js";

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
interface PendingInteraction {
  request: InteractionRequest;
  timer: ReturnType<typeof setTimeout>;
}
interface PendingControl {
  resolve: (value: JsonObject) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Current published control nesting, with ownership and explicit failure policy. */
export class ControlChannel {
  private interactions = new Map<string, PendingInteraction>();
  private outgoing = new Map<string, PendingControl>();
  private replies = new Map<string, string>();
  private requestBodies = new Map<string, string>();
  private cancelled = new Set<string>();
  private counter = 0;
  private closed = false;
  constructor(
    private readonly session: DriverSessionRequest,
    private readonly send: (packet: unknown) => Promise<void>,
    private readonly emit: (event: UnsequencedClaudeDriverEvent) => void,
    private readonly fail: (message: string) => void,
  ) {}

  async request(request: JsonObject, timeoutMs = 10000): Promise<JsonObject> {
    if (this.closed) throw new Error("Control channel closed");
    const id = `pcc-control-${++this.counter}`;
    const response = new Promise<JsonObject>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.outgoing.delete(id);
        reject(
          new Error(
            `Claude ${String(request.subtype)} control deadline exceeded`,
          ),
        );
      }, timeoutMs);
      this.outgoing.set(id, { resolve, reject, timer });
    });
    try {
      await this.send({ type: "control_request", request_id: id, request });
    } catch (error) {
      const pending = this.outgoing.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.outgoing.delete(id);
        pending.reject(
          error instanceof Error ? error : new Error("Control write failed"),
        );
      }
    }
    return response;
  }
  /** Returns whether driver, rather than the shared normalizer, owns this packet. */
  handle(packet: unknown): boolean {
    if (!object(packet)) return false;
    if (
      this.closed &&
      (packet.type === "control_request" ||
        packet.type === "control_response" ||
        packet.type === "control_cancel_request")
    )
      return true;
    if (packet.type === "control_response") {
      if (
        !object(packet.response) ||
        typeof packet.response.request_id !== "string"
      )
        throw new Error("Malformed nested control response ID");
      const response = packet.response;
      const id = response.request_id as string;
      const pending = this.outgoing.get(id);
      if (!pending) return true;
      this.outgoing.delete(id);
      clearTimeout(pending.timer);
      if (response.subtype === "success" && object(response.response))
        pending.resolve(response.response as JsonObject);
      else
        pending.reject(
          new Error(
            response.subtype === "error"
              ? "Claude rejected requested control"
              : "Malformed Claude control response",
          ),
        );
      return true;
    }
    if (packet.type === "control_cancel_request") {
      if (typeof packet.request_id !== "string" || !packet.request_id)
        throw new Error("Control cancellation lacks request ID");
      const pending = this.interactions.get(packet.request_id);
      if (pending) {
        clearTimeout(pending.timer);
        this.interactions.delete(packet.request_id);
        this.cancelled.add(packet.request_id);
        this.emit({
          type: "interaction_cancel",
          requestId: packet.request_id,
          attribution: {},
        });
      }
      return true;
    }
    if (packet.type !== "control_request") return false;
    if (
      typeof packet.request_id !== "string" ||
      !packet.request_id ||
      !object(packet.request) ||
      typeof packet.request.subtype !== "string"
    )
      throw new Error("Malformed CLI control request");
    const id = packet.request_id;
    const request = packet.request;
    const body = JSON.stringify(request);
    const oldBody = this.requestBodies.get(id);
    if (oldBody !== undefined && oldBody !== body)
      throw new Error("Conflicting duplicate control request ID");
    if (this.requestBodies.size >= 4096) {
      const oldest = this.requestBodies.keys().next().value!;
      this.requestBodies.delete(oldest);
      this.cancelled.delete(oldest);
      this.replies.delete(oldest);
    }
    this.requestBodies.set(id, body);
    if (this.cancelled.has(id)) return true;
    if (this.interactions.has(id)) return true;
    const previous = this.replies.get(id);
    if (previous) {
      void this.send(JSON.parse(previous) as unknown).catch(() =>
        this.fail("Control reply replay failed"),
      );
      return true;
    }
    if (request.subtype === "can_use_tool") {
      if (
        typeof request.tool_name !== "string" ||
        !request.tool_name ||
        typeof request.tool_use_id !== "string" ||
        !request.tool_use_id ||
        !object(request.input)
      )
        throw new Error(
          "Permission request requires tool name, authoritative tool ID and input",
        );
      const name = request.tool_name;
      if (
        this.session.tools.some((tool) => `mcp__host__${tool.name}` === name)
      ) {
        this.emit({
          type: "observation",
          family: "diagnostic",
          subtype: "host-mcp-permission",
          data: { requestId: id, toolName: name },
          attribution: { toolUseId: request.tool_use_id },
        });
        void this.reply(id, {
          behavior: "allow",
          updatedInput: request.input as JsonObject,
        }).catch(() => this.fail("Host tool permission write failed"));
      } else {
        const userServer = this.session.settings.userMcpServers.find(
          (server) =>
            name.startsWith(`mcp__${server.name}__`) &&
            name.length > `mcp__${server.name}__`.length,
        );
        if (!this.session.settings.claudeTools.includes(name) && !userServer) {
          void this.reply(id, {
            behavior: "deny",
            message:
              "Tool isn't in the effective host/native/user MCP inventory",
          }).catch(() => this.fail("Permission denial write failed"));
        } else {
          this.park({
            kind: "permission",
            requestId: id,
            toolUseId: request.tool_use_id,
            toolName: name,
            input: request.input as JsonObject,
            ...(typeof request.title === "string"
              ? { title: request.title }
              : {}),
            ...(userServer
              ? {
                  mcpServer: {
                    name: userServer.name,
                    source: "explicit-user-config",
                  },
                }
              : {}),
          });
        }
      }
    } else if (request.subtype === "elicitation") {
      if (
        typeof request.mcp_server_name !== "string" ||
        typeof request.message !== "string"
      )
        throw new Error("Malformed MCP elicitation");
      if (
        !this.session.settings.userMcpServers.some(
          (server) => server.name === request.mcp_server_name,
        )
      )
        this.unsupported(id, "Elicitation server isn't explicitly configured");
      else if (
        request.mode !== undefined &&
        request.mode !== "form" &&
        request.mode !== "url"
      )
        this.unsupported(id, "Unsupported elicitation mode");
      else if (
        (request.requested_schema !== undefined &&
          !object(request.requested_schema)) ||
        (request.url !== undefined && typeof request.url !== "string")
      )
        throw new Error("Malformed elicitation schema or URL");
      else
        this.park({
          kind: "elicitation",
          requestId: id,
          serverName: request.mcp_server_name,
          message: request.message,
          ...(request.mode ? { mode: request.mode } : {}),
          ...(typeof request.url === "string" ? { url: request.url } : {}),
          ...(object(request.requested_schema)
            ? { requestedSchema: request.requested_schema as JsonObject }
            : {}),
        });
    } else {
      // No dialog kinds are declared: an error cannot settle a dialog as a user choice.
      this.unsupported(
        id,
        request.subtype === "request_user_dialog"
          ? "CLI dialog kind isn't supported by this host"
          : `Unsupported CLI control subtype: ${request.subtype}`,
      );
    }
    return true;
  }
  private park(request: InteractionRequest): void {
    if (this.interactions.size >= 1024)
      throw new Error("Pending interaction limit exceeded");
    const timer = setTimeout(() => {
      this.interactions.delete(request.requestId);
      this.emit({
        type: "interaction_cancel",
        requestId: request.requestId,
        attribution: {},
      });
      void this.reply(
        request.requestId,
        undefined,
        "Host interaction deadline exceeded",
      ).catch(() => this.fail("Interaction timeout write failed"));
    }, this.session.settings.toolResultTimeoutMs);
    this.interactions.set(request.requestId, { request, timer });
    this.emit({
      type: "interaction_request",
      request,
      attribution:
        request.kind === "permission" ? { toolUseId: request.toolUseId } : {},
    });
  }
  private unsupported(id: string, message: string): void {
    this.emit({
      type: "observation",
      family: "diagnostic",
      subtype: "unsupported-control",
      data: { requestId: id, message },
      attribution: {},
    });
    void this.reply(id, undefined, message).catch(() =>
      this.fail("Unsupported control write failed"),
    );
  }
  private async reply(
    id: string,
    response?: JsonObject,
    error?: string,
  ): Promise<void> {
    const packet = {
      type: "control_response",
      response: error
        ? { subtype: "error", request_id: id, error }
        : { subtype: "success", request_id: id, response: response ?? {} },
    };
    if (this.replies.size >= 4096)
      this.replies.delete(this.replies.keys().next().value!);
    this.replies.set(id, JSON.stringify(packet));
    await this.send(packet);
  }
  async answer(response: InteractionResponse): Promise<void> {
    const pending = this.interactions.get(response.requestId);
    if (!pending)
      throw new Error("Unknown, answered or canceled interaction request ID");
    if (
      response.kind !== "unsupported" &&
      pending.request.kind !== response.kind
    )
      throw new Error("Interaction response kind doesn't match request");
    if (response.kind === "dialog")
      throw new Error("No CLI dialog kinds are supported");
    clearTimeout(pending.timer);
    this.interactions.delete(response.requestId);
    if (response.kind === "unsupported")
      await this.reply(response.requestId, undefined, response.error);
    else await this.reply(response.requestId, response.decision as JsonObject);
  }
  async cancelInteractions(reason: string): Promise<void> {
    const pending = [...this.interactions];
    this.interactions.clear();
    await Promise.all(
      pending.map(async ([id, interaction]) => {
        clearTimeout(interaction.timer);
        this.emit({
          type: "interaction_cancel",
          requestId: id,
          attribution: {},
        });
        await this.reply(id, undefined, reason);
      }),
    );
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const pending of this.outgoing.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Control channel closed"));
    }
    this.outgoing.clear();
    await this.cancelInteractions("Host session closed");
    this.replies.clear();
    this.requestBodies.clear();
    this.cancelled.clear();
  }
}
