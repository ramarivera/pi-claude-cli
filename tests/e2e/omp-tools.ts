import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import {
  gate,
  nativeDiagnostic,
  normalizedObservation,
  observeSteeringStatus,
  providerPrompt,
  record,
  response,
  sentinel,
  slow,
  systemPrompt,
} from "./observer.js";

export default function register(api: ExtensionAPI): void {
  const { Type } = api.typebox;
  api.events.on("pi-claude-cli:observation", normalizedObservation);
  api.events.on("pi-claude-cli:diagnostic", nativeDiagnostic);
  api.on("session_start", (_event, ctx) =>
    observeSteeringStatus(ctx, "session_start"),
  );
  api.on("context", (_event, ctx) => observeSteeringStatus(ctx, "context"));
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
    name: "pcc_gate",
    label: "E2E boundary gate",
    loadMode: "essential",
    approval: "read",
    description:
      "Call exactly once when requested. Waits for the sandbox controller, then returns a nonce that must be reported exactly.",
    parameters: Type.Object({}),
    execute: (id, _params, signal) => gate(id, signal),
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
