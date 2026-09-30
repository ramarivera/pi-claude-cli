/** Private child endpoint. It advertises schemas and parks calls; it never executes host tools. */
import { readFile } from "node:fs/promises";
import { connect } from "node:net";
import { StringDecoder } from "node:string_decoder";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const config = JSON.parse(await readFile(process.argv[2], "utf8"));
const socket = connect(config.socket);
await new Promise((resolve, reject) => {
  socket.once("connect", resolve);
  socket.once("error", reject);
});
const parked = new Map();
const decoder = new StringDecoder("utf8");
let buffer = "";
// Only fixed phases and authoritative IDs cross this diagnostic seam. Never log
// arguments, results, schemas, environment values, or raw protocol errors.
const diagnostic = (phase, fields = {}) => {
  if (!socket.destroyed)
    socket.write(
      JSON.stringify({ type: "diagnostic", phase, ...fields }) + "\n",
    );
};
const fail = () => {
  for (const resolve of parked.values())
    resolve({
      content: [{ type: "text", text: "Host bridge closed" }],
      isError: true,
    });
  parked.clear();
  void server.close();
};
socket.on("data", (chunk) => {
  try {
    buffer += decoder.write(chunk);
    for (;;) {
      const index = buffer.indexOf("\n");
      if (index < 0) break;
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (Buffer.byteLength(line) > 1024 * 1024)
        throw new Error("Bridge frame limit");
      const reply = JSON.parse(line);
      const resolve = parked.get(reply.id);
      if (resolve) {
        parked.delete(reply.id);
        resolve(reply.result);
      }
    }
    if (Buffer.byteLength(buffer) > 1024 * 1024)
      throw new Error("Bridge frame limit");
  } catch {
    socket.destroy();
  }
});
socket.on("error", fail);
socket.on("close", fail);
const server = new Server(
  { name: config.name, version: "1.0.0" },
  { capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, () => {
  diagnostic("tools-listed");
  return { tools: config.tools };
});
server.setRequestHandler(CallToolRequestSchema, (request) => {
  const id = request.params._meta?.["claudecode/toolUseId"];
  if (typeof id !== "string" || !id) {
    diagnostic("missing-tool-use-id");
    throw new Error("tools/call requires _meta[claudecode/toolUseId]");
  }
  if (!config.tools.some((tool) => tool.name === request.params.name)) {
    diagnostic("unknown-tool");
    throw new Error("Unknown host tool");
  }
  const fields = { id, name: request.params.name };
  if (parked.has(id)) {
    diagnostic("duplicate-tool-use-id", fields);
    throw new Error("Duplicate parked tool ID");
  }
  diagnostic("call-received", fields);
  return new Promise((resolve) => {
    parked.set(id, resolve);
    const packet = JSON.stringify({
      type: "call",
      id,
      name: request.params.name,
      arguments: request.params.arguments ?? {},
    });
    if (Buffer.byteLength(packet) > 1024 * 1024) {
      diagnostic("call-frame-limit", fields);
      parked.delete(id);
      resolve({
        content: [{ type: "text", text: "Host call exceeds frame limit" }],
        isError: true,
      });
      return;
    }
    socket.write(packet + "\n", (error) => {
      if (error) fail();
    });
  }).then((result) => {
    if (!socket.destroyed)
      socket.write(JSON.stringify({ type: "settled", id }) + "\n", (error) => {
        if (error) fail();
      });
    return result;
  });
});
server.onerror = () => diagnostic("protocol-error");
server.onclose = () => {
  diagnostic("server-closed");
  socket.destroy();
};
await server.connect(new StdioServerTransport());
diagnostic("ready");
process.stdin.on("end", () => {
  diagnostic("stdin-ended");
  void server.close();
  socket.destroy();
});
