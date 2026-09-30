import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Api,
  type Model,
  type ToolCall,
} from "@earendil-works/pi-ai";
import type {
  AssistantContent,
  ClaudeRoundEvent,
  HostToolCall,
  ToolDefinition,
} from "../../contracts/index.js";

export class PiProjection {
  readonly stream = createAssistantMessageEventStream();
  readonly message: AssistantMessage;
  private started = false;
  private terminal = false;
  private readonly positions = new Map<string, number>();
  private readonly ended = new Set<number>();
  private readonly hostCalls = new Map<string, number>();
  constructor(
    model: Model<Api>,
    private tools: readonly ToolDefinition[],
  ) {
    this.message = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      stopReason: "pending",
      timestamp: Date.now(),
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
  }
  setTools(tools: readonly ToolDefinition[]): void {
    this.tools = tools;
  }
  private start(): void {
    if (!this.started) {
      this.started = true;
      this.stream.push({ type: "start", partial: this.message });
    }
  }
  private block(key: string, content: AssistantContent): number | undefined {
    if (content.type === "tool_call" || content.type === "image")
      return undefined;
    const existing = this.positions.get(key);
    if (existing !== undefined) return existing;
    this.start();
    const index = this.message.content.length;
    this.positions.set(key, index);
    if (content.type === "text") {
      this.message.content.push({ type: "text", text: "" });
      this.stream.push({
        type: "text_start",
        contentIndex: index,
        partial: this.message,
      });
    } else {
      this.message.content.push({
        type: "thinking",
        thinking: content.redacted ? content.thinking : "",
        thinkingSignature: content.signature,
        redacted: content.redacted,
      });
      this.stream.push({
        type: "thinking_start",
        contentIndex: index,
        partial: this.message,
      });
    }
    this.reconcile(index, content);
    return index;
  }
  private reconcile(index: number, content: AssistantContent): void {
    const block = this.message.content[index];
    if (content.type === "thinking" && block.type === "thinking") {
      block.thinkingSignature = content.signature ?? block.thinkingSignature;
      block.redacted = content.redacted ?? block.redacted;
    }
    const current =
      block.type === "text"
        ? block.text
        : block.type === "thinking"
          ? block.thinking
          : undefined;
    const next =
      content.type === "text"
        ? content.text
        : content.type === "thinking"
          ? content.thinking
          : undefined;
    if (current === undefined || next === undefined) return;
    if (current === next || current.startsWith(next)) return;
    if (!next.startsWith(current))
      throw new Error(
        "Claude snapshot conflicts with already emitted Pi content",
      );
    if (this.ended.has(index))
      throw new Error("Claude snapshot changed a completed Pi content block");
    const delta = next.slice(current.length);
    if (block.type === "text") {
      block.text = next;
      this.stream.push({
        type: "text_delta",
        contentIndex: index,
        delta,
        partial: this.message,
      });
    } else if (block.type === "thinking") {
      block.thinking = next;
      this.stream.push({
        type: "thinking_delta",
        contentIndex: index,
        delta,
        partial: this.message,
      });
    }
  }
  private end(index: number): void {
    if (this.ended.has(index)) return;
    const block = this.message.content[index];
    this.ended.add(index);
    if (block.type === "text")
      this.stream.push({
        type: "text_end",
        contentIndex: index,
        content: block.text,
        partial: this.message,
      });
    else if (block.type === "thinking")
      this.stream.push({
        type: "thinking_end",
        contentIndex: index,
        content: block.thinking,
        partial: this.message,
      });
  }
  private hostCall(call: HostToolCall): void {
    if (!this.tools.some((tool) => tool.name === call.name))
      throw new Error(`Claude requested inactive Pi tool ${call.name}`);
    const previous = this.hostCalls.get(call.id);
    if (previous !== undefined) {
      const block = this.message.content[previous];
      if (
        JSON.stringify(block) !== JSON.stringify({ ...call, type: "toolCall" })
      )
        throw new Error(`Conflicting host tool call ${call.id}`);
      return;
    }
    this.start();
    const index = this.message.content.length;
    const toolCall: ToolCall = { ...call, type: "toolCall" };
    this.hostCalls.set(call.id, index);
    this.message.content.push(toolCall);
    this.stream.push({
      type: "toolcall_start",
      contentIndex: index,
      partial: this.message,
    });
    this.stream.push({
      type: "toolcall_end",
      contentIndex: index,
      toolCall,
      partial: this.message,
    });
    this.ended.add(index);
  }
  accept(round: ClaudeRoundEvent): void {
    if (this.terminal) return;
    if (round.type === "driver_event") {
      const event = round.event;
      if (event.attribution.parentToolUseId || event.attribution.agentId)
        return;
      if (
        (event.type === "message_start" ||
          event.type === "assistant_snapshot") &&
        event.model
      )
        this.message.responseModel = event.model;
      if (event.type === "content_start")
        this.block(`${event.messageId}:${event.index}`, event.content);
      else if (event.type === "content_delta") {
        const index = this.positions.get(`${event.messageId}:${event.index}`);
        if (index === undefined) return;
        const block = this.message.content[index];
        if (event.delta.kind === "text" && block.type === "text")
          this.reconcile(index, {
            type: "text",
            text: block.text + event.delta.text,
          });
        else if (event.delta.kind === "thinking" && block.type === "thinking")
          this.reconcile(index, {
            type: "thinking",
            thinking: block.thinking + event.delta.thinking,
          });
        else if (event.delta.kind === "signature" && block.type === "thinking")
          block.thinkingSignature =
            (block.thinkingSignature ?? "") + event.delta.signature;
      } else if (event.type === "content_end") {
        const index = this.positions.get(`${event.messageId}:${event.index}`);
        if (index !== undefined) this.end(index);
      } else if (event.type === "assistant_snapshot")
        event.content.forEach((content, offset) => {
          const key = `${event.messageId}:${event.contentIndexes?.[offset] ?? offset}`;
          const index = this.block(key, content);
          if (index !== undefined) this.reconcile(index, content);
        });
      else if (event.type === "host_tool_request") this.hostCall(event.call);
      return;
    }
    this.start();
    if (round.model) this.message.responseModel = round.model;
    // Round content is authoritative, but must retain previously emitted blocks.
    let cursor = 0;
    for (const content of round.content) {
      if (content.type === "tool_call") {
        if (!round.pendingToolCallIds.includes(content.id)) continue;
        this.hostCall(content);
      } else {
        if (content.type === "image")
          throw new Error(
            "Pi assistant output doesn't support Claude image blocks",
          );
        let index = this.message.content.findIndex(
          (block, position) =>
            position >= cursor && block.type === content.type,
        );
        if (index === -1)
          index = this.block(`terminal:${cursor}`, content) ?? -1;
        if (index >= 0) {
          this.reconcile(index, content);
          cursor = index + 1;
        }
      }
    }
    if (round.usage) {
      const usage = round.usage;
      this.message.usage = {
        input: usage.inputTokens,
        output: usage.outputTokens,
        cacheRead: usage.cacheReadTokens,
        cacheWrite: usage.cacheWriteTokens,
        reasoning: usage.reasoningTokens,
        totalTokens:
          usage.inputTokens +
          usage.outputTokens +
          usage.cacheReadTokens +
          usage.cacheWriteTokens,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: usage.costUsd ?? 0,
        },
      };
    }
    for (let index = 0; index < this.message.content.length; index++)
      this.end(index);
    this.message.stopReason = round.reason;
    if (round.reason === "error" || round.reason === "aborted")
      this.fail(
        round.error?.message ?? `Claude round ${round.reason}`,
        round.reason,
      );
    else {
      this.terminal = true;
      this.stream.push({
        type: "done",
        reason: round.reason,
        message: this.message,
      });
      this.stream.end(this.message);
    }
  }
  fail(error: unknown, reason: "error" | "aborted" = "error"): void {
    if (this.terminal) return;
    this.terminal = true;
    this.message.stopReason = reason;
    this.message.errorMessage =
      error instanceof Error ? error.message : String(error);
    this.stream.push({ type: "error", reason, error: this.message });
    this.stream.end(this.message);
  }
  finish(): void {
    if (!this.terminal)
      this.fail("Claude runtime ended without a round boundary");
  }
}
