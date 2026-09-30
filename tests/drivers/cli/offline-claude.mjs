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
          hasToken: !!process.env.ANTHROPIC_AUTH_TOKEN,
          hasHelper: !!process.env.CLAUDE_CODE_API_KEY_HELPER,
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
  const pending = new Map();
  const ask = (id, request) =>
    new Promise((resolve) => {
      pending.set(id, resolve);
      send({ type: "control_request", request_id: id, request });
    });
  let client;
  let transport;
  const complete = () => send({ type: "result", subtype: "success" });
  const user = async (packet) => {
    send({ type: "fixture", subtype: "input", message: packet.message });
    const action = packet.message.content.at(-1).text ?? "image";
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
    } else if (action === "message-stop")
      send({ type: "stream_event", event: { type: "message_stop" } });
    else if (action === "eof") process.exit(0);
    else if (action === "stdout-eof") {
      process.stdout.end();
      setTimeout(() => {}, 1000);
    } else if (action === "bad-json") process.stdout.write("{broken}\n");
    else if (action === "oversize")
      process.stdout.write("x".repeat(1024 * 1024 + 1));
    else if (action === "nonzero") {
      process.stderr.write("offline stderr\n" + (process.env.PCC_STDERR ?? ""));
      process.exit(7);
    } else if (action === "stdin-epipe") {
      process.stdin.destroy();
      send({ type: "stream_event", event: { type: "message_stop" } });
      setTimeout(() => {}, 500);
    } else if (action === "tree" || action === "exit-tree") {
      const grandchild = spawn(
        process.execPath,
        ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
        { stdio: action === "exit-tree" ? "inherit" : "ignore" },
      );
      await writeFile(process.env.PCC_TREE, String(grandchild.pid));
      if (action === "exit-tree") process.exit(0);
      complete();
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
            const permission = await ask(`permission-${id || "missing"}`, {
              subtype: "can_use_tool",
              tool_name: "mcp__host__edit",
              tool_use_id: id || "missing-meta-permission",
              input: { id },
            });
            if (permission.response?.behavior !== "allow")
              throw new Error("Host MCP permission was denied");
            const result = await client.callTool({
              name: "edit",
              arguments: permission.response.updatedInput,
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
      complete();
    } else if (
      action.startsWith("permission") ||
      action === "cancel-permission"
    ) {
      const name =
        action === "permission-native" || action === "cancel-permission"
          ? "Bash"
          : action === "permission-user"
            ? "mcp__external__query"
            : "mcp__host__inactive";
      const response = ask("permission-1", {
        subtype: "can_use_tool",
        tool_name: name,
        tool_use_id: "native-call-1",
        input: { command: "original" },
        title: "Offline permission",
      });
      if (action === "cancel-permission") {
        await new Promise((resolve) => setTimeout(resolve, 30));
        send({ type: "control_cancel_request", request_id: "permission-1" });
        complete();
      } else {
        await response;
        complete();
      }
    } else if (action.startsWith("elicitation")) {
      await ask("elicitation-1", {
        subtype: "elicitation",
        mcp_server_name:
          action === "elicitation-unknown" ? "undeclared" : "external",
        message: "Offline form",
        mode: action === "elicitation-url" ? "url" : "form",
        ...(action === "elicitation-url"
          ? { url: "https://example.invalid/auth" }
          : {
              requested_schema: {
                type: "object",
                properties: { choice: { enum: ["one", "two"] } },
              },
            }),
      });
      complete();
    } else if (action === "dialog") {
      await ask("dialog-1", {
        subtype: "request_user_dialog",
        dialog_kind: "refusal_fallback_prompt",
        payload: { question: "Choose?" },
      });
      complete();
    } else if (action === "control-unsupported") {
      await ask("unknown-1", { subtype: "future_control", payload: {} });
      complete();
    } else if (action === "control-malformed")
      send({ type: "control_request", request: { subtype: "can_use_tool" } });
    else if (action === "forwarded") {
      send({
        type: "assistant",
        parent_tool_use_id: "parent-native-call",
        message: {
          id: "child-message",
          model: "served-child-model",
          content: [
            { type: "text", text: "child output" },
            {
              type: "tool_use",
              id: "child-call",
              name: "mcp__host__edit",
              input: {},
            },
          ],
        },
      });
      send({
        type: "user",
        parent_tool_use_id: "parent-native-call",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "child-call",
              content: "child result",
            },
          ],
        },
      });
      complete();
    } else if (action === "result-error")
      send({
        type: "result",
        subtype: "error_max_budget_usd",
        is_error: true,
        errors: ["Offline budget exhausted"],
        modelUsage: { "served-model": { inputTokens: 2, outputTokens: 3 } },
      });
    else {
      send({ type: "assistant", text: action });
      complete();
    }
  };
  rl.on("line", (line) => {
    const packet = JSON.parse(line);
    if (packet.type === "control_response") {
      send({
        type: "fixture",
        subtype: "control-reply",
        id: packet.response?.request_id,
        response: packet.response,
      });
      const resolve = pending.get(packet.response?.request_id);
      if (resolve) {
        pending.delete(packet.response.request_id);
        resolve(packet.response);
      }
    } else if (packet.type === "control_request") {
      if (packet.request.subtype === "initialize") {
        if (process.env.PCC_INIT === "missing") return;
        if (process.env.PCC_INIT === "exit") process.exit(0);
        send({
          type: "fixture",
          subtype: "initialize-request",
          request: packet.request,
        });
        const response = {
          subtype: process.env.PCC_INIT === "error" ? "error" : "success",
          request_id: packet.request_id,
          response: {
            models: JSON.parse(
              process.env.PCC_MODELS ??
                '[{"value":"offline-model","supportsEffort":true,"supportedEffortLevels":["low","medium","high"]}]',
            ),
          },
        };
        if (process.env.PCC_INIT === "bad-nesting") {
          delete response.request_id;
          send({
            type: "control_response",
            request_id: packet.request_id,
            response,
          });
        } else send({ type: "control_response", response });
      } else
        send({
          type: "control_response",
          response: {
            subtype: "success",
            request_id: packet.request_id,
            response: {},
          },
        });
    } else if (packet.type === "user")
      void user(packet).catch((error) => {
        send({ type: "fixture", subtype: "child-error", error: error.message });
        process.exitCode = 1;
      });
  });
  rl.on("close", () => {
    void (async () => {
      await client?.close();
      await transport?.close();
    })();
  });
}
