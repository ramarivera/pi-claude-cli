// Wire protocol types for Claude CLI stream-json NDJSON communication

// NDJSON message types from Claude CLI stdout

export interface ClaudeStreamEventMessage {
  type: "stream_event";
  event: ClaudeApiEvent;
}

export interface ClaudeResultMessage {
  type: "result";
  // Claude Code emits "success" plus error subtypes such as
  // "error_during_execution" and "error_max_turns" — never a literal "error".
  // Treat anything that is not "success" (or is_error/api_error_status set) as
  // a failure.
  subtype: string;
  is_error?: boolean;
  api_error_status?: string | null;
  result?: string;
  error?: string;
  session_id?: string;
}

export interface ClaudeRateLimitEventMessage {
  type: "rate_limit_event";
  rate_limit_info?: {
    status?: string; // "allowed" when within limits; otherwise throttled/blocked
    rateLimitType?: string;
    resetsAt?: number;
    overageStatus?: string;
  };
  session_id?: string;
}

export interface ClaudeSystemMessage {
  type: "system";
  subtype: string;
  session_id?: string;
  tools?: unknown[];
}

export interface ClaudeControlRequest {
  type: "control_request";
  request_id: string;
  request: {
    subtype: "can_use_tool";
    tool_name: string;
    input: Record<string, unknown>;
  };
}

export type NdjsonMessage =
  | ClaudeStreamEventMessage
  | ClaudeResultMessage
  | ClaudeRateLimitEventMessage
  | ClaudeSystemMessage
  | ClaudeControlRequest;

// Claude API event types (inside stream_event wrapper)

export interface ClaudeApiEvent {
  type: string; // message_start, content_block_start, content_block_delta, content_block_stop, message_delta, message_stop
  index?: number;
  message?: {
    id?: string;
    type?: string;
    role?: string;
    content?: unknown[];
    model?: string;
    usage?: ClaudeUsage;
  };
  content_block?: {
    type: string; // "text", "tool_use", "thinking"
    text?: string;
    id?: string;
    name?: string;
    input?: string;
  };
  delta?: {
    type?: string; // "text_delta", "input_json_delta", "thinking_delta", "signature_delta"
    text?: string;
    partial_json?: string;
    thinking?: string;
    signature?: string;
    stop_reason?: string;
  };
  usage?: ClaudeUsage;
}

export interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

// Content block tracking during stream processing

export interface TrackedContentBlock {
  type: "text" | "thinking";
  text: string;
  index: number; // Claude's content_block index
}
