import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { RequestId } from "@modelcontextprotocol/sdk/types.js";

/** Tracks MCP response writes for shutdown, never for Claude tool-use correlation. */
export class DrainingMcpServer extends McpServer {
  private readonly requests = new Set<RequestId>();
  private readonly waiters: (() => void)[] = [];

  override async connect(transport: Transport): Promise<void> {
    // Protocol.connect owns and wraps these public callbacks. Our observer runs first.
    const onmessage = transport.onmessage;
    transport.onmessage = (message, extra) => {
      if (
        "method" in message &&
        message.method === "tools/call" &&
        "id" in message
      )
        this.requests.add(message.id);
      if ("method" in message && message.method === "notifications/cancelled") {
        const id = message.params?.requestId;
        if (typeof id === "string" || typeof id === "number") this.complete(id);
      }
      onmessage?.(message, extra);
    };
    const onclose = transport.onclose;
    transport.onclose = () => {
      this.requests.clear();
      this.release();
      onclose?.();
    };
    const send = transport.send.bind(transport);
    transport.send = async (message, options) => {
      try {
        await send(message, options);
      } finally {
        if (
          "id" in message &&
          !("method" in message) &&
          (typeof message.id === "string" || typeof message.id === "number")
        )
          this.complete(message.id);
      }
    };
    await super.connect(transport);
  }

  private complete(id: RequestId): void {
    this.requests.delete(id);
    this.release();
  }

  private release(): void {
    if (!this.requests.size)
      for (const resolve of this.waiters.splice(0)) resolve();
  }

  drain(): Promise<void> {
    if (!this.requests.size) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}
