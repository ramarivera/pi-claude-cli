import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import {
  providerPrompt,
  record,
  response,
  sentinel,
  slow,
  systemPrompt,
} from "./observer.js";

export default function register(api: ExtensionAPI): void {
  const { Type } = api.typebox;
  api.on("cache_warming_decision", () => ({ action: "stop" }));
  api.on("before_agent_start", (event) =>
    systemPrompt("before_agent_start", event.systemPrompt),
  );
  api.on("before_provider_request", (event) => providerPrompt(event.payload));
  api.on("after_provider_response", (event) =>
    response(event.status, event.headers),
  );
  api.on("tool_execution_start", (event) => record("tool-start", event));
  api.on("tool_execution_end", (event) => record("tool-end", event));
  api.registerTool({
    name: "pcc_sentinel",
    label: "E2E sentinel",
    loadMode: "essential",
    approval: "read",
    description:
      "Call exactly once when requested. Returns a structured nonce and execution counter; report the nonce exactly.",
    parameters: Type.Object({}),
    execute: sentinel,
  });
  api.registerTool({
    name: "pcc_slow",
    label: "E2E abort tool",
    loadMode: "essential",
    approval: "read",
    description:
      "When requested call this slow cancellable sandbox tool once. It waits for the host abort signal.",
    parameters: Type.Object({}),
    execute: (id, _params, signal) => slow(id, signal),
  });
}
