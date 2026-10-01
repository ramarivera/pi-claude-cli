import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  gate,
  nativeOutput,
  providerPrompt,
  record,
  response,
  sentinel,
  slow,
  steeringAdmission,
  systemPrompt,
} from "./observer.js";

export default function register(api: ExtensionAPI): void {
  api.on("cache_warming_decision", () => ({ action: "stop" }));
  api.on("before_agent_start", (event) =>
    systemPrompt("before_agent_start", event.systemPrompt),
  );
  api.on("before_provider_request", (event, ctx) =>
    providerPrompt(event.payload, ctx.sessionManager.getSessionId()),
  );
  api.on("after_provider_response", (event, ctx) =>
    response(event.status, event.headers, ctx.model?.provider),
  );
  api.on("provider_stream_event", (event) => {
    const data = event.data;
    if (typeof data !== "object" || data === null) return;
    nativeOutput(data);
    // Canonical events contain synthetic test data; avoid arbitrary raw diagnostics.
    if ("type" in data && data.type === "host_tool_request")
      record("canonical-tool", data);
    else if ("type" in data && data.type === "initialized")
      record("initialized", data);
    else steeringAdmission(data);
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
    name: "pcc_gate",
    label: "E2E boundary gate",
    description:
      "Call exactly once when requested. Waits for the sandbox controller, then returns a nonce that must be reported exactly.",
    parameters: Type.Object({}),
    execute: (id, _params, signal) => gate(id, signal),
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
