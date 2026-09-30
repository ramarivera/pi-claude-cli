import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readRuntimeConfiguration } from "../entrypoints/config.js";

describe("shared entrypoint configuration", () => {
  it.each(["cli", "sdk"] as const)(
    "constructs and closes the production %s runtime without loading the official query or making inference",
    async (driver) => {
      vi.resetModules();
      vi.doMock("@anthropic-ai/claude-agent-sdk", () => {
        throw new Error("Official inference module must stay lazy");
      });
      try {
        const { createConfiguredRuntime } =
          await import("../entrypoints/runtime.js");
        const runtime = await createConfiguredRuntime(
          readRuntimeConfiguration({ PI_CLAUDE_DRIVER: driver }),
        );
        await runtime.closeAll();
        expect(runtime.streamRound).toBeTypeOf("function");
      } finally {
        vi.doUnmock("@anthropic-ai/claude-agent-sdk");
        vi.resetModules();
      }
    },
  );

  it("defaults to the original CLI driver and official login without activating native tools", () => {
    const config = readRuntimeConfiguration({
      CLAUDE_CONFIG_DIR: "/own-login",
    });
    expect(config.driver).toBe("cli");
    expect(config.auth).toEqual({ mode: "claude-login" });
    expect(config.settings.claudeTools).toEqual([]);
    expect(config.settings.userMcpServers).toEqual([]);
    expect(config.settings.settingSources).toEqual([]);
    expect(config.driverOptions.environment).toEqual({
      CLAUDE_CONFIG_DIR: "/own-login",
    });
  });

  it("makes SDK and API billing explicit and preserves bounded execution settings", () => {
    const config = readRuntimeConfiguration({
      PI_CLAUDE_DRIVER: "sdk",
      PI_CLAUDE_AUTH: "api-key",
      ANTHROPIC_API_KEY: "offline-test-key",
      ANTHROPIC_BASE_URL: "https://example.invalid",
      PI_CLAUDE_MAX_TURNS: "4",
      PI_CLAUDE_MAX_OUTPUT_TOKENS: "512",
      PI_CLAUDE_MAX_BUDGET_USD: "0.25",
      PI_CLAUDE_TOOL_TIMEOUT_MS: "1000",
      PI_CLAUDE_EFFORT: "xhigh",
      PI_CLAUDE_FORWARD_SUBAGENT_TEXT: "1",
      PI_CLAUDE_EXECUTABLE: "/published/claude",
      PI_CLAUDE_INTERNAL_TOOLS: '["WebSearch"]',
    });
    expect(config.driver).toBe("sdk");
    expect(config.auth).toEqual({
      mode: "api-key",
      apiKey: "offline-test-key",
      baseUrl: "https://example.invalid",
    });
    expect(config.settings).toMatchObject({
      maxTurns: 4,
      maxOutputTokens: 512,
      maxBudgetUsd: 0.25,
      toolResultTimeoutMs: 1000,
      effort: "xhigh",
      forwardSubagentText: true,
      claudeTools: ["WebSearch"],
    });
    expect(config.driverOptions.executable).toBe("/published/claude");
  });

  it.each([
    { PI_CLAUDE_DRIVER: "http" },
    { PI_CLAUDE_AUTH: "host-token" },
    { PI_CLAUDE_AUTH: "api-key" },
    { PI_CLAUDE_MAX_TURNS: "1.5" },
    { PI_CLAUDE_MAX_TURNS: "0" },
    { PI_CLAUDE_MAX_OUTPUT_TOKENS: "0" },
    { PI_CLAUDE_MAX_OUTPUT_TOKENS: "-1" },
    { PI_CLAUDE_MAX_OUTPUT_TOKENS: "1.5" },
    { PI_CLAUDE_MAX_OUTPUT_TOKENS: "Infinity" },
    { PI_CLAUDE_MAX_OUTPUT_TOKENS: "9007199254740992" },
    { PI_CLAUDE_MAX_BUDGET_USD: "Infinity" },
    { PI_CLAUDE_TOOL_TIMEOUT_MS: "-1" },
    { PI_CLAUDE_EFFORT: "ultra" },
    { PI_CLAUDE_INTERNAL_TOOLS: '["Read",42]' },
    { PI_CLAUDE_FORWARD_SUBAGENT_TEXT: "true" },
  ])("rejects invalid configuration before runtime creation: %j", (env) => {
    expect(() => readRuntimeConfiguration(env)).toThrow();
  });

  it("preserves explicit user MCP owners and rejects reserved names or ambiguous transport", () => {
    const dir = mkdtempSync(join(tmpdir(), "pcc-config-test-"));
    const path = join(dir, "mcp.json");
    try {
      writeFileSync(
        path,
        JSON.stringify({
          mcpServers: {
            own: {
              command: "node",
              args: ["user-server.mjs"],
              env: { EXAMPLE: "fixture" },
            },
            remote: {
              type: "http",
              url: "https://example.invalid/mcp",
              headers: { "x-fixture": "1" },
            },
          },
        }),
      );
      const config = readRuntimeConfiguration({ PI_CLAUDE_MCP_CONFIG: path });
      expect(config.settings.userMcpServers).toEqual([
        {
          name: "own",
          config: {
            type: "stdio",
            command: "node",
            args: ["user-server.mjs"],
            env: { EXAMPLE: "fixture" },
          },
        },
        {
          name: "remote",
          config: {
            type: "http",
            url: "https://example.invalid/mcp",
            headers: { "x-fixture": "1" },
          },
        },
      ]);
      for (const invalid of [
        { host: { command: "node" } },
        { own: { type: "http", command: "node" } },
        { remote: { type: "http", url: "file:///tmp/socket" } },
        { own: { command: "node", env: { BAD: 42 } } },
        { own: { command: "node", args: "--wrong-shape" } },
      ]) {
        writeFileSync(path, JSON.stringify({ mcpServers: invalid }));
        expect(() =>
          readRuntimeConfiguration({ PI_CLAUDE_MCP_CONFIG: path }),
        ).toThrow();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
