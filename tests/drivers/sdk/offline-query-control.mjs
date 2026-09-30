#!/usr/bin/env node
/** OFFLINE runtime double. No inference, authentication, filesystem tools or network. */
import { createInterface } from "node:readline";

const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const input = createInterface({ input: process.stdin });
for await (const line of input) {
  const packet = JSON.parse(line);
  if (packet.type === "control_request") {
    send({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: packet.request_id,
        response: {},
      },
    });
  } else if (packet.type === "user") {
    const text = packet.message.content[0]?.text;
    if (text === "begin-offline-park") {
      send({
        type: "system",
        subtype: "init",
        session_id: "offline-sdk-control-session",
        model: "offline-no-inference",
        capabilities: [],
        tools: ["mcp__host__edit"],
        mcp_servers: [],
      });
      send({
        type: "control_request",
        request_id: "offline-mcp-call",
        request: {
          subtype: "mcp_message",
          server_name: "host",
          message: {
            jsonrpc: "2.0",
            id: 99,
            method: "tools/call",
            params: {
              name: "edit",
              arguments: {
                input: "private-offline-patch",
                i: "private-offline-intent",
              },
              _meta: { "claudecode/toolUseId": "toolu_offline_park" },
            },
          },
        },
      });
    } else if (text === "begin-offline-parallel") {
      send({
        type: "system",
        subtype: "init",
        session_id: "offline-sdk-control-session",
        model: "offline-no-inference",
        capabilities: [],
        tools: ["mcp__host__edit", "mcp__host__pcc_sentinel"],
        mcp_servers: [],
      });
      // Both requests are put on the wire without waiting for either response.
      for (const call of [
        {
          id: 101,
          controlId: "offline-parallel-a",
          toolUseId: "toolu_offline_edit",
          name: "edit",
          arguments: { input: "private-offline-patch" },
        },
        {
          id: 102,
          controlId: "offline-parallel-b",
          toolUseId: "toolu_offline_sentinel",
          name: "pcc_sentinel",
          arguments: {},
        },
      ])
        send({
          type: "control_request",
          request_id: call.controlId,
          request: {
            subtype: "mcp_message",
            server_name: "host",
            message: {
              jsonrpc: "2.0",
              id: call.id,
              method: "tools/call",
              params: {
                name: call.name,
                arguments: call.arguments,
                _meta: { "claudecode/toolUseId": call.toolUseId },
              },
            },
          },
        });
    } else if (text === "emit-after-park") {
      send({
        type: "stream_event",
        uuid: "offline-message-stop-frame",
        session_id: "offline-sdk-control-session",
        parent_tool_use_id: null,
        event: { type: "message_stop" },
      });
      send({
        type: "assistant",
        uuid: "offline-snapshot-frame",
        session_id: "offline-sdk-control-session",
        parent_tool_use_id: null,
        message: {
          id: "offline-assistant-message",
          role: "assistant",
          model: "offline-no-inference",
          content: [
            {
              type: "tool_use",
              id: "toolu_offline_park",
              name: "mcp__host__edit",
              input: {
                input: "private-offline-patch",
                i: "private-offline-intent",
              },
            },
          ],
          stop_reason: "tool_use",
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });
    }
  } else if (
    packet.type === "control_response" &&
    packet.response.request_id === "offline-mcp-call"
  ) {
    send({
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: "offline-sdk-control-session",
      result: "offline host result received",
      num_turns: 1,
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
    });
  } else if (
    packet.type === "control_response" &&
    packet.response.request_id.startsWith("offline-parallel-")
  ) {
    send({
      type: "system",
      subtype: "task_notification",
      task_id: `offline-complete-${packet.response.request_id}`,
      status: "completed",
      output_file: "",
      summary: "offline MCP response received",
      session_id: "offline-sdk-control-session",
    });
  }
}
