#!/usr/bin/env node
/** OFFLINE deterministic CLI double: no inference, no credentials or network. */
import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write(
    (process.env.PCC_VERSION ?? "2.1.285") + " (Offline Claude double)\n",
  );
} else {
  const flag = (name) => args[args.indexOf(name) + 1];
  const config = JSON.parse(await readFile(flag("--mcp-config"), "utf8"));
  if (process.env.PCC_RECEIPT)
    await writeFile(
      process.env.PCC_RECEIPT,
      JSON.stringify({
        pid: process.pid,
        cwd: process.cwd(),
        args,
        systemPrompt: await readFile(flag("--system-prompt-file"), "utf8"),
        config,
        environment: {
          configDir: process.env.CLAUDE_CONFIG_DIR,
          hasKey: !!process.env.ANTHROPIC_API_KEY,
          baseUrl: process.env.ANTHROPIC_BASE_URL,
          cloudMcp: process.env.ENABLE_CLAUDEAI_MCP_SERVERS,
        },
      }),
    );
  if (process.env.PCC_HANG === "1") {
    process.on("SIGTERM", () => {});
    setInterval(() => {}, 1000);
  }
  const rl = createInterface({ input: process.stdin });
  const send = (packet) => process.stdout.write(JSON.stringify(packet) + "\n");
  let client;
  let transport;
  for await (const line of rl) {
    const packet = JSON.parse(line);
    if (packet.type !== "user") continue;
    const action = packet.message.content.at(-1).text;
    send({
      type: "system",
      subtype: "init",
      session_id: "offline-session",
      model: "offline-model",
    });
    if (action === "fragment") {
      const bytes = Buffer.from(
        JSON.stringify({ type: "assistant", text: "hello 🦔 café" }) +
          "\n" +
          JSON.stringify({ type: "result", subtype: "success" }),
      );
      for (let index = 0; index < bytes.length; index++) {
        process.stdout.write(bytes.subarray(index, index + 1));
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      process.stdout.write("\n");
    } else if (action === "message-stop") {
      send({ type: "stream_event", event: { type: "message_stop" } });
    } else if (action === "eof") {
      process.exit(0);
    } else if (action === "bad-json") {
      process.stdout.write("{broken}\n");
    } else if (action === "oversize") {
      process.stdout.write("x".repeat(1024 * 1024 + 1));
    } else if (action === "nonzero") {
      process.stderr.write("offline stderr\n");
      process.exit(7);
    } else if (action === "tree") {
      const grandchild = spawn(
        process.execPath,
        ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
        { stdio: "ignore" },
      );
      await writeFile(process.env.PCC_TREE, String(grandchild.pid));
      send({ type: "result", subtype: "success" });
    } else if (action.startsWith("tools")) {
      const endpoint = config.mcpServers.host;
      transport = new StdioClientTransport({
        command: endpoint.command,
        args: endpoint.args,
      });
      client = new Client({ name: "offline-claude", version: "1.0.0" });
      await client.connect(transport);
      send({
        type: "fixture",
        subtype: "tools",
        data: await client.listTools(),
      });
      const ids = action === "tools-missing-meta" ? [""] : ["tool-b", "tool-a"];
      await Promise.all(
        ids.map(async (id) => {
          try {
            const result = await client.callTool({
              name: "edit",
              arguments: { id },
              ...(id ? { _meta: { "claudecode/toolUseId": id } } : {}),
            });
            send({ type: "fixture", subtype: "tool-result", id, result });
          } catch (error) {
            send({
              type: "fixture",
              subtype: "tool-error",
              id,
              error: error.message,
            });
          }
        }),
      );
      send({ type: "result", subtype: "success" });
    } else {
      send({ type: "assistant", text: action });
      send({ type: "result", subtype: "success" });
    }
  }
  await client?.close();
  await transport?.close();
}
