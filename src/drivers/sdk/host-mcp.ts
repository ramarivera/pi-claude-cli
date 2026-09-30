import {
  CallToolRequestSchema,
  CallToolResultSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  DriverEventPayload,
  HostToolCall,
  HostToolResult,
  ToolDefinition,
} from "../../contracts/index.js";
import { fingerprint, jsonObject } from "./json.js";
import { DrainingMcpServer } from "./draining-server.js";

export const HOST_MCP_NAME = "host";
export const TOOL_USE_ID_META = "claudecode/toolUseId";
interface PendingCall {
  call: HostToolCall;
  promise: Promise<CallToolResult>;
  settle(result: HostToolResult): void;
}
interface CompletedCall {
  call: HostToolCall;
  result: HostToolResult;
}

/** SDK requires a McpServer instance, but native JSON schemas use its protocol Server. */
export class HostMcpBridge {
  readonly server = new DrainingMcpServer(
    { name: HOST_MCP_NAME, version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  private readonly tools: Map<string, ToolDefinition>;
  private readonly pending = new Map<string, PendingCall>();
  private readonly early = new Map<string, HostToolResult>();
  private readonly completed = new Map<string, CompletedCall>();
  private closed = false;
  private closing?: Promise<void>;

  constructor(
    tools: readonly ToolDefinition[],
    private readonly timeoutMs: number,
    private readonly emit: (event: DriverEventPayload) => void,
  ) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
      throw new Error("SDK tool result timeout must be positive");
    this.tools = new Map();
    for (const original of tools) {
      const tool = structuredClone(original);
      if (
        tool.owner !== "host" ||
        !tool.name.trim() ||
        this.tools.has(tool.name)
      )
        throw new Error(
          "SDK host tools require unique nonempty names and host ownership",
        );
      if (
        tool.inputSchema.type !== "object" ||
        (tool.outputSchema && tool.outputSchema.type !== "object")
      )
        throw new Error(
          `SDK MCP schema for ${tool.name} must be an object schema`,
        );
      this.tools.set(tool.name, tool);
    }
    this.server.server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: [...this.tools.values()].map(
        (tool): Tool => ({
          name: tool.name,
          description: tool.description,
          title: tool.title,
          inputSchema: { ...tool.inputSchema, type: "object" },
          outputSchema: tool.outputSchema
            ? { ...tool.outputSchema, type: "object" }
            : undefined,
          annotations: tool.annotations,
          _meta: tool._meta,
        }),
      ),
    }));
    this.server.server.setRequestHandler(
      CallToolRequestSchema,
      (request, extra) => {
        const id = request.params._meta?.[TOOL_USE_ID_META];
        if (typeof id !== "string" || !id.trim())
          return this.failure(
            "tool-correlation",
            `Host MCP call is missing _meta["${TOOL_USE_ID_META}"]`,
          );
        if (!this.tools.has(request.params.name))
          return this.failure(
            "tool-correlation",
            "Host MCP call names an unexposed tool",
          );
        const call: HostToolCall = {
          type: "tool_call",
          id,
          name: request.params.name,
          arguments: jsonObject(request.params.arguments ?? {}),
        };
        return this.park(call, extra.signal);
      },
    );
  }

  ownsPermission(
    toolName: string,
    provenance?: { name: string; source: string },
  ): boolean {
    return (
      provenance?.source === "sdk" &&
      provenance.name === HOST_MCP_NAME &&
      [...this.tools.keys()].some(
        (name) => toolName === `mcp__${HOST_MCP_NAME}__${name}`,
      )
    );
  }

  private failure(
    code: "tool-correlation" | "timeout",
    message: string,
  ): CallToolResult {
    this.emit({ type: "session_error", error: { code, message } });
    return { isError: true, content: [{ type: "text", text: message }] };
  }

  private park(
    call: HostToolCall,
    signal: AbortSignal,
  ): Promise<CallToolResult> | CallToolResult {
    if (this.closed || signal.aborted)
      return cancelledResult("Host tool call cancelled");
    const prior = this.pending.get(call.id) ?? this.completed.get(call.id);
    if (prior) {
      if (fingerprint(prior.call) !== fingerprint(call))
        return this.failure(
          "tool-correlation",
          "Host MCP tool-use ID was reused with conflicting arguments",
        );
      return "promise" in prior ? prior.promise : projectResult(prior.result);
    }
    const early = this.early.get(call.id);
    if (early && early.toolName !== call.name)
      return this.failure(
        "tool-correlation",
        "Early host result tool name conflicts with MCP call",
      );
    let settle!: (result: HostToolResult) => void;
    const promise = new Promise<CallToolResult>((resolve) => {
      const cancel = () =>
        settle({
          toolCallId: call.id,
          toolName: call.name,
          ...cancelledResult("Host tool call cancelled"),
        });
      const timer = setTimeout(() => {
        this.emit({
          type: "session_error",
          error: {
            code: "timeout",
            message: "Host tool result deadline expired",
          },
        });
        settle({
          toolCallId: call.id,
          toolName: call.name,
          ...cancelledResult("Host tool result deadline expired"),
        });
      }, this.timeoutMs);
      let settled = false;
      settle = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
        this.pending.delete(call.id);
        this.early.delete(call.id);
        this.completed.set(call.id, { call, result });
        resolve(projectResult(result));
      };
      signal.addEventListener("abort", cancel, { once: true });
    });
    this.pending.set(call.id, { call, promise, settle });
    this.emit({ type: "host_tool_request", call: structuredClone(call) });
    if (early) settle(early);
    return promise;
  }

  deliver(results: readonly HostToolResult[]): void {
    if (this.closed) throw new Error("SDK host MCP bridge is closed");
    const batch = new Map<string, HostToolResult>();
    for (const original of results) {
      const result = structuredClone(original);
      projectResult(result);
      if (!result.toolCallId.trim() || !this.tools.has(result.toolName))
        throw new Error(
          "SDK host result requires an ID and an exposed tool name",
        );
      const previous =
        batch.get(result.toolCallId) ??
        this.completed.get(result.toolCallId)?.result ??
        this.early.get(result.toolCallId);
      if (previous && fingerprint(previous) !== fingerprint(result))
        throw new Error("Conflicting duplicate SDK host result");
      const pending = this.pending.get(result.toolCallId);
      if (pending && pending.call.name !== result.toolName)
        throw new Error("SDK host result tool name conflicts with its call");
      batch.set(result.toolCallId, result);
    }
    for (const [id, result] of batch) {
      const pending = this.pending.get(id);
      if (pending) pending.settle(result);
      else if (!this.completed.has(id)) this.early.set(id, result);
    }
  }

  cancel(reason: string): void {
    for (const { call, settle } of [...this.pending.values()])
      settle({
        toolCallId: call.id,
        toolName: call.name,
        ...cancelledResult(reason),
      });
    this.early.clear();
  }

  close(): Promise<void> {
    if (!this.closing) {
      this.closed = true;
      this.cancel("Host tool call cancelled because SDK session closed");
      this.completed.clear();
      this.closing = this.server.drain().then(() => this.server.close());
    }
    return this.closing;
  }

  forceClose(): Promise<void> {
    return this.server.close();
  }
}

function cancelledResult(message: string): {
  isError: true;
  content: [{ type: "text"; text: string }];
} {
  return { isError: true, content: [{ type: "text", text: message }] };
}
function projectResult(result: HostToolResult): CallToolResult {
  return CallToolResultSchema.parse({
    content: [...result.content],
    isError: result.isError,
    structuredContent: result.structuredContent,
    _meta: result._meta,
  });
}
