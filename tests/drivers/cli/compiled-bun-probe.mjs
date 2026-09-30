/** Offline protocol probe inside an actual compiled Bun application, without inference. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createCliDriver } from "../../../src/drivers/cli/index.ts";

assert.equal(typeof process.versions.bun, "string");
// The parent needs this switch to run this probe; real OMP doesn't inherit it.
// Remove it to prove the driver sets it only on its private MCP child endpoint.
delete process.env.BUN_BE_BUN;
const directory = await mkdtemp(join(tmpdir(), "pcc-compiled-bun-test-"));
const receipt = join(directory, "receipt.json");
const schema = {
  type: "object",
  properties: {
    id: { enum: ["tool-a", "tool-b"] },
    edit: {
      anyOf: [
        { const: "replace" },
        { type: "object", properties: { line: { type: "integer" } } },
      ],
    },
  },
  required: ["id"],
  additionalProperties: false,
};
const request = {
  identity: {
    sessionId: "offline-bun-host",
    branchId: "main",
    historyRevision: "1",
    driver: "cli",
    cwd: process.cwd(),
    configurationDigest: "bun-probe",
    history: { messages: [], messageDigests: [], digest: "empty" },
  },
  resume: {
    mode: "fresh",
    restoration: "none",
    reason: "offline compiled Bun test",
  },
  model: "offline-model",
  systemPrompt: "Offline Bun MCP probe",
  tools: [
    {
      name: "edit",
      owner: "host",
      description: "Native schema",
      inputSchema: schema,
    },
  ],
  settings: { toolResultTimeoutMs: 3000, claudeTools: [], userMcpServers: [] },
  auth: { mode: "api-key", apiKey: "offline-bun-test-no-inference" },
};
let session;
try {
  const driver = createCliDriver({
    executable: process.argv[2],
    environment: { PCC_RECEIPT: receipt },
    shutdownTimeoutMs: 1000,
    normalizerFactory: () => ({
      normalize(packet) {
        return packet.type === "result"
          ? [
              {
                type: "turn_end",
                status: "success",
                subtype: "success",
                isError: false,
                attribution: {},
              },
            ]
          : [
              {
                type: "observation",
                family: "diagnostic",
                subtype: packet.subtype ?? packet.type,
                data: packet,
                attribution: {},
              },
            ];
      },
    }),
  });
  session = await driver.openSession(request);
  const capture = JSON.parse(await readFile(receipt, "utf8"));
  assert.equal(capture.config.mcpServers.host.command, process.execPath);
  assert.deepEqual(capture.config.mcpServers.host.env, { BUN_BE_BUN: "1" });
  assert.equal(capture.environment.bunBeBun, undefined);
  assert.equal(process.env.BUN_BE_BUN, undefined);
  await session.submitPrompt({
    turnId: "offline-bun-turn",
    content: [{ type: "text", text: "tools" }],
  });
  const ids = [];
  const results = [];
  let mcpPid;
  let advertised = false;
  let completed = false;
  for await (const event of session.events) {
    if (event.type === "session_error") throw new Error(event.error.message);
    if (event.type === "host_tool_request") {
      ids.push(event.call.id);
      assert.equal(event.call.name, "edit");
      if (!mcpPid)
        mcpPid = Number(
          (
            await readFile(
              `/proc/${capture.pid}/task/${capture.pid}/children`,
              "utf8",
            )
          )
            .trim()
            .split(/\s+/)[0],
        );
      await session.deliverToolResults([
        {
          toolCallId: event.call.id,
          toolName: "edit",
          content: [{ type: "text", text: `verified-${event.call.id}` }],
          isError: false,
          structuredContent: { id: event.call.id },
        },
      ]);
    } else if (event.type === "observation" && event.subtype === "tools") {
      assert.deepEqual(event.data.data.tools[0].inputSchema, schema);
      advertised = true;
    } else if (
      event.type === "observation" &&
      event.subtype === "tool-result"
    ) {
      assert.equal(event.data.result.isError, false);
      assert.deepEqual(event.data.result.content, [
        { type: "text", text: `verified-${event.data.id}` },
      ]);
      assert.equal(event.data.result.structuredContent.id, event.data.id);
      results.push(event.data.id);
    } else if (event.type === "turn_end") {
      completed = true;
      break;
    }
  }
  assert.equal(advertised, true);
  assert.equal(completed, true);
  assert.deepEqual(ids.sort(), ["tool-a", "tool-b"]);
  assert.deepEqual(results.sort(), ["tool-a", "tool-b"]);
  assert.ok(Number.isInteger(mcpPid) && mcpPid > 0);
  await session.close();
  assert.throws(() => process.kill(capture.pid, 0));
  try {
    assert.match(await readFile(`/proc/${mcpPid}/stat`, "utf8"), /\) Z /);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await assert.rejects(
    stat(
      dirname(capture.args[capture.args.indexOf("--system-prompt-file") + 1]),
    ),
    { code: "ENOENT" },
  );
  process.stdout.write(
    JSON.stringify({
      bunVersion: process.versions.bun,
      compiledExecutable: process.execPath,
      privateMcpMode: capture.config.mcpServers.host.env.BUN_BE_BUN,
      claudeInheritedBunMode: false,
      advertisedSchema: true,
      calls: ids,
      results,
      cleaned: true,
    }) + "\n",
  );
} finally {
  await session?.close();
  await rm(directory, { recursive: true, force: true });
}
