import type {
  CallToolResult,
  ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { JsonObject } from "../../src/contracts/index.js";
export interface ScenarioCall {
  id: string;
  name: string;
  arguments: JsonObject;
}
export interface ScenarioCommand {
  turn: string;
  mode: "text" | "tools" | "slow-tool" | "hold" | "error" | "malformed";
  text?: string;
  calls?: ScenarioCall[];
}
export function runScenario(
  command: ScenarioCommand,
  sessionId: string,
  send: (packet: unknown) => void,
  callTool: (call: ScenarioCall) => Promise<CallToolResult>,
  listTools: () => Promise<ListToolsResult>,
): Promise<void>;
