import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { record, response, sentinel, slow } from "./observer.js";

export default function register(api: ExtensionAPI): void {
  api.on("cache_warming_decision", () => ({ action: "stop" }));
  api.on("after_provider_response", (event) =>
    response(event.status, event.headers),
  );
  api.on("provider_stream_event", (event) => {
    const data = event.data;
    if (typeof data !== "object" || data === null) return;
    // Canonical events contain synthetic test data; avoid arbitrary raw diagnostics.
    if ("type" in data && data.type === "host_tool_request")
      record("canonical-tool", data);
    else if ("type" in data && data.type === "initialized")
      record("initialized", data);
  });
  api.on("tool_execution_start", (event) => record("tool-start", event));
  api.on("tool_execution_end", (event) => record("tool-end", event));
  api.registerTool({
    name: "pcc_sentinel",
    label: "E2E sentinel",
    description:
      "Call exactly once when requested. Returns a structured nonce and execution counter; report the nonce exactly.",
    parameters: Type.Object({}),
    execute: sentinel,
  });
  api.registerTool({
    name: "pcc_slow",
    label: "E2E abort tool",
    description:
      "When requested call this slow cancellable sandbox tool once. It waits for the host abort signal.",
    parameters: Type.Object({}),
    execute: (id, _params, signal) => slow(id, signal),
  });
}
