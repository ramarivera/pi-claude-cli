import { readFileSync } from "node:fs";
import type {
  AuthConfig,
  DriverFactoryOptions,
  DriverKind,
  Effort,
  RuntimeSettings,
  UserMcpServer,
} from "../src/contracts/index.js";

export interface RuntimeConfiguration {
  driver: DriverKind;
  auth: AuthConfig;
  settings: RuntimeSettings;
  driverOptions: DriverFactoryOptions;
}

type Environment = Readonly<Record<string, string | undefined>>;

function positiveNumber(env: Environment, name: string): number | undefined {
  const value = env[name];
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0)
    throw new Error(`${name} must be a finite positive number`);
  return parsed;
}

function strings(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    throw new Error(`${name} must be a JSON array of strings`);
  return value;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringRecord(value: unknown, name: string): Record<string, string> {
  if (
    !object(value) ||
    Object.values(value).some((item) => typeof item !== "string")
  )
    throw new Error(`${name} must contain only string values`);
  return value as Record<string, string>;
}

/** Explicit configured user servers keep Claude ownership; host is reserved. */
function userMcpServers(path: string | undefined): UserMcpServer[] {
  if (!path) return [];
  const file: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!object(file) || !object(file.mcpServers))
    throw new Error("PI_CLAUDE_MCP_CONFIG must contain an mcpServers object");
  return Object.entries(file.mcpServers).map(([name, config]) => {
    if (name === "host") throw new Error("MCP server name host is reserved");
    if (!name || !object(config))
      throw new Error("Invalid user MCP server configuration");
    if (typeof config.command === "string" && config.command.length > 0) {
      if (config.type !== undefined && config.type !== "stdio")
        throw new Error(`MCP server ${name} has incompatible type and command`);
      return {
        name,
        config: {
          type: "stdio",
          command: config.command,
          args:
            config.args === undefined
              ? undefined
              : strings(config.args, `MCP server ${name} args`),
          env:
            config.env === undefined
              ? undefined
              : stringRecord(config.env, `MCP server ${name} env`),
        },
      };
    }
    if (
      (config.type === "http" || config.type === "sse") &&
      typeof config.url === "string"
    ) {
      const url = new URL(config.url);
      if (!["http:", "https:"].includes(url.protocol))
        throw new Error(`MCP server ${name} requires an HTTP or HTTPS URL`);
      return {
        name,
        config: {
          type: config.type,
          url: config.url,
          headers:
            config.headers === undefined
              ? undefined
              : stringRecord(config.headers, `MCP server ${name} headers`),
        },
      };
    }
    throw new Error(
      `MCP server ${name} requires an explicit stdio, http or sse configuration`,
    );
  });
}

/** Both entrypoints share transport configuration; neither host's OAuth is read. */
export function readRuntimeConfiguration(
  env: Environment = process.env,
): RuntimeConfiguration {
  const driver = env.PI_CLAUDE_DRIVER ?? "cli";
  if (driver !== "cli" && driver !== "sdk")
    throw new Error("PI_CLAUDE_DRIVER must be cli or sdk");
  const mode = env.PI_CLAUDE_AUTH ?? "claude-login";
  let auth: AuthConfig;
  if (mode === "claude-login") auth = { mode };
  else if (mode === "api-key") {
    if (!env.ANTHROPIC_API_KEY)
      throw new Error("Explicit api-key mode requires ANTHROPIC_API_KEY");
    auth = {
      mode,
      apiKey: env.ANTHROPIC_API_KEY,
      baseUrl: env.ANTHROPIC_BASE_URL,
    };
  } else throw new Error("PI_CLAUDE_AUTH must be claude-login or api-key");
  const effort = env.PI_CLAUDE_EFFORT || undefined;
  const efforts: readonly string[] = ["low", "medium", "high", "xhigh", "max"];
  if (effort && !efforts.includes(effort))
    throw new Error("Unsupported PI_CLAUDE_EFFORT");
  const maxTurns = positiveNumber(env, "PI_CLAUDE_MAX_TURNS");
  if (maxTurns !== undefined && !Number.isInteger(maxTurns))
    throw new Error("PI_CLAUDE_MAX_TURNS must be an integer");
  const maxOutputTokens = positiveNumber(env, "PI_CLAUDE_MAX_OUTPUT_TOKENS");
  if (maxOutputTokens !== undefined && !Number.isSafeInteger(maxOutputTokens))
    throw new Error("PI_CLAUDE_MAX_OUTPUT_TOKENS must be a safe integer");
  const forward = env.PI_CLAUDE_FORWARD_SUBAGENT_TEXT;
  if (forward !== undefined && forward !== "0" && forward !== "1")
    throw new Error("PI_CLAUDE_FORWARD_SUBAGENT_TEXT must be 0 or 1");
  return {
    driver,
    auth,
    settings: {
      effort: effort as Effort | undefined,
      maxTurns,
      maxOutputTokens,
      maxBudgetUsd: positiveNumber(env, "PI_CLAUDE_MAX_BUDGET_USD"),
      toolResultTimeoutMs:
        positiveNumber(env, "PI_CLAUDE_TOOL_TIMEOUT_MS") ?? 180_000,
      claudeTools: strings(
        JSON.parse(env.PI_CLAUDE_INTERNAL_TOOLS ?? "[]"),
        "PI_CLAUDE_INTERNAL_TOOLS",
      ),
      userMcpServers: userMcpServers(env.PI_CLAUDE_MCP_CONFIG),
      forwardSubagentText: forward === "1",
      settingSources: [],
    },
    driverOptions: {
      executable: env.PI_CLAUDE_EXECUTABLE || undefined,
      shutdownTimeoutMs:
        positiveNumber(env, "PI_CLAUDE_SHUTDOWN_TIMEOUT_MS") ?? 5_000,
      environment: env,
    },
  };
}
