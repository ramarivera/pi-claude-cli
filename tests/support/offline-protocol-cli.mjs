#!/usr/bin/env node
/** OFFLINE child transport: real JSONL and MCP, deterministic authored inference. */
import { readFile } from "node:fs/promises";
import { writeFileSync, renameSync } from "node:fs";
import { createInterface } from "node:readline";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { runScenario } from "./protocol-scenario.mjs";

const args = process.argv.slice(2);
if (args.includes("--version"))
  process.stdout.write("2.1.285 (Offline protocol transport)\n");
else {
  const flag = (name) => args[args.indexOf(name) + 1];
  const config = JSON.parse(await readFile(flag("--mcp-config"), "utf8"));
  const sessionId = process.env.PCC_SCENARIO_SESSION;
  const send = (packet) => {
    if (packet.kind === "tools_listing") receipt.listing = packet.listing;
    if (packet.kind === "tool_results") receipt.results.push(packet.results);
    if (packet.kind === "tools_listing" || packet.kind === "tool_results")
      save();
    process.stdout.write(`${JSON.stringify(packet)}\n`);
  };
  let client;
  let transport;
  const connect = async () => {
    if (!client) {
      const endpoint = config.mcpServers.host;
      transport = new StdioClientTransport({
        command: endpoint.command,
        args: endpoint.args,
      });
      client = new Client({ name: "offline-conformance", version: "1" });
      await client.connect(transport);
    }
    return client;
  };
  const receipt = {
    pid: process.pid,
    args,
    prompts: [],
    controls: [],
    listing: null,
    results: [],
    systemPrompt: await readFile(flag("--system-prompt-file"), "utf8"),
  };
  const save = () => {
    const path = process.env.PCC_SCENARIO_RECEIPT;
    writeFileSync(`${path}.pending`, JSON.stringify(receipt));
    renameSync(`${path}.pending`, path);
  };
  await save();
  const lines = createInterface({ input: process.stdin });
  let initialized = false;
  let currentTurn;
  let work = Promise.resolve();
  lines.on("line", (line) => {
    const packet = JSON.parse(line);
    if (packet.type === "control_request") {
      receipt.controls.push(packet.request.subtype);
      void save();
      send({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: packet.request_id,
          response:
            packet.request.subtype === "initialize"
              ? {
                  models: [
                    {
                      value: "offline-model",
                      supportsEffort: true,
                      supportedEffortLevels: ["low", "medium", "high"],
                    },
                  ],
                }
              : {},
        },
      });
      if (packet.request.subtype === "interrupt" && currentTurn)
        send({
          type: "result",
          session_id: sessionId,
          uuid: `${currentTurn}-abort`,
          subtype: "error_aborted",
          is_error: true,
          terminal_reason: "user_abort",
          errors: ["Offline interrupted"],
        });
    } else if (packet.type === "user") {
      receipt.prompts.push(packet.message);
      work = work
        .then(async () => {
          await save();
          if (!initialized) {
            initialized = true;
            send({
              type: "system",
              subtype: "init",
              session_id: sessionId,
              model: "offline-model",
              claude_code_version: "2.1.285",
              tools: Object.keys(config.mcpServers),
              mcp_servers: [{ name: "host", status: "connected" }],
            });
          }
          const command = JSON.parse(packet.message.content.at(-1).text);
          currentTurn = command.turn;
          await runScenario(
            command,
            sessionId,
            send,
            async (call) =>
              (await connect()).callTool({
                name: call.name,
                arguments: call.arguments,
                _meta: { "claudecode/toolUseId": call.id },
              }),
            async () => (await connect()).listTools(),
          );
        })
        .catch((error) => {
          process.stderr.write(`Offline scenario failed: ${error.message}\n`);
          process.exitCode = 1;
        });
    }
  });
  lines.on("close", () => {
    void client?.close();
    void transport?.close();
  });
}
