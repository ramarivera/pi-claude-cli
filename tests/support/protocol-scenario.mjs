/** Deterministic inference substitute shared by both offline transport seams. */
export async function runScenario(
  command,
  sessionId,
  send,
  callTool,
  listTools,
) {
  const envelope = (packet) =>
    send({ session_id: sessionId, parent_tool_use_id: null, ...packet });
  const stream = (event) => envelope({ type: "stream_event", event });
  const messageId = `${command.turn}-message`;
  stream({
    type: "message_start",
    message: {
      id: messageId,
      model: "offline-model",
      usage: { input_tokens: 7, cache_read_input_tokens: 2 },
    },
  });
  if (command.mode === "hold") return;
  if (command.mode === "error") {
    envelope({
      type: "result",
      uuid: `${command.turn}-result`,
      subtype: "error_max_turns",
      is_error: true,
      errors: ["Offline controlled exhaustion"],
      usage: { input_tokens: 7, output_tokens: 1 },
    });
    return;
  }
  if (command.mode === "malformed") {
    envelope({ type: "assistant", message: { content: [] } });
    return;
  }
  if (command.mode === "tools" || command.mode === "slow-tool") {
    envelope({
      type: "system",
      subtype: "status",
      kind: "tools_listing",
      listing: await listTools(),
    });
    const calls = command.calls;
    envelope({
      type: "assistant",
      uuid: `${command.turn}-proposal`,
      message: {
        id: messageId,
        model: "offline-model",
        content: calls.map((call) => ({
          type: "tool_use",
          id: call.id,
          name: `mcp__host__${call.name}`,
          input: call.arguments,
        })),
        stop_reason: command.mode === "slow-tool" ? null : "tool_use",
        usage: { input_tokens: 7, output_tokens: 2 },
      },
    });
    stream({
      type: "message_delta",
      delta: { stop_reason: "tool_use" },
      usage: { output_tokens: 2 },
    });
    // The slow scenario parks while inference owns its unfinished message.
    if (command.mode === "tools") stream({ type: "message_stop" });
    const results = await Promise.all(
      calls.map(async (call) => ({
        id: call.id,
        result: await callTool(call),
      })),
    );
    envelope({
      type: "system",
      subtype: "local_command_output",
      kind: "tool_results",
      results,
    });
    if (command.mode === "slow-tool") return;
    const resumedId = `${command.turn}-continuation`;
    stream({
      type: "message_start",
      message: { id: resumedId, model: "offline-model" },
    });
    const text = results
      .map(
        ({ id, result }) =>
          `${id}:${JSON.stringify(result.structuredContent ?? result.content)}:${result.isError}`,
      )
      .join("|");
    envelope({
      type: "assistant",
      uuid: `${command.turn}-answer`,
      message: {
        id: resumedId,
        model: "offline-model",
        content: [{ type: "text", text }],
        stop_reason: "end_turn",
      },
    });
    stream({
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { input_tokens: 3, output_tokens: 4 },
    });
    stream({ type: "message_stop" });
  } else {
    stream({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    });
    stream({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: command.text },
    });
    stream({ type: "content_block_stop", index: 0 });
    const snapshot = {
      type: "assistant",
      uuid: `${command.turn}-answer`,
      message: {
        id: messageId,
        model: "offline-model",
        content: [{ type: "text", text: command.text }],
        stop_reason: "end_turn",
      },
    };
    envelope(snapshot);
    envelope(snapshot);
    stream({
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 4 },
    });
    stream({ type: "message_stop" });
  }
  const terminal = {
    type: "result",
    uuid: `${command.turn}-result`,
    subtype: "success",
    is_error: false,
    result: "offline complete",
    usage: {
      input_tokens: 10,
      output_tokens: 6,
      cache_read_input_tokens: 2,
      cache_creation_input_tokens: 1,
    },
    total_cost_usd: 0.001,
  };
  envelope(terminal);
  envelope({ ...terminal, uuid: `${command.turn}-duplicate` });
}
