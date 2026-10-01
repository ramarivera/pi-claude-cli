import type { DriverSessionRequest } from "../contracts/index.js";

export const HOST_MCP_NAME = "host";

export function hostToolName(nativeName: string): string {
  return `mcp__${HOST_MCP_NAME}__${nativeName}`;
}

/** Reconcile native host instructions with Claude's MCP tool namespace. */
export function hostToolSystemPrompt(
  request: Pick<DriverSessionRequest, "systemPrompt" | "tools" | "settings">,
): string {
  if (request.tools.length === 0) return request.systemPrompt;
  const names = request.tools.map(
    (tool) =>
      `${JSON.stringify(tool.name)} -> ${JSON.stringify(hostToolName(tool.name))}`,
  );
  return [
    request.systemPrompt,
    [
      "Host tool transport names",
      "The native host tools listed below are available through MCP with their original input schemas and behavior.",
      "Use the mapped Claude callable name even when host instructions or history use the native name.",
      ...names,
      request.settings.claudeTools.length === 0
        ? "Claude built-in tools are disabled for this session."
        : `Configured Claude built-in tools: ${JSON.stringify(request.settings.claudeTools)}.`,
      "Use the exposed tool definitions to determine availability; a native name in instructions is not a separate callable tool.",
    ].join("\n"),
  ].join("\n\n");
}
