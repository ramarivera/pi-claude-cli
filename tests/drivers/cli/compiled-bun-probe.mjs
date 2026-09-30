/** Offline protocol probe inside an actual compiled Bun application, without inference. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createCliDriver } from "../../../src/drivers/cli/index.ts";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { EditTool } from "@oh-my-pi/pi-coding-agent/edit/index";
import { normalizeTools } from "@oh-my-pi/pi-agent-core/agent-loop";

assert.equal(typeof process.versions.bun, "string");
// The parent needs this switch to run this probe; real OMP doesn't inherit it.
// Remove it to prove the driver sets it only on its private MCP child endpoint.
delete process.env.BUN_BE_BUN;
const directory = await mkdtemp(join(tmpdir(), "pcc-compiled-bun-test-"));
const receipt = join(directory, "receipt.json");
const nativeSequence = process.argv[3] === "native-sequence";
const nativeSession = { settings: Settings.isolated(), cwd: process.cwd() };
const nativeTools = normalizeTools(
  [new ReadTool(nativeSession), new EditTool(nativeSession, "hashline")],
  { injectIntent: true },
).map((tool) => ({
  name: tool.name,
  owner: "host",
  description: tool.description,
  inputSchema: tool.parameters,
  _meta: { omp: { strict: tool.strict ?? false } },
}));
const expectedIds = nativeSequence
  ? ["toolu_019MQnr1hrXbz88TbmDn9End", "toolu_01Qb5GdCWMM4CvQefY4YJrGw"]
  : ["tool-a", "tool-b"];
const resultText = (id) =>
  nativeSequence
    ? id === expectedIds[0]
      ? "[fixture.txt#F27C]\n1:before"
      : "Edited"
    : `verified-${id}`;
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
  tools: nativeSequence
    ? nativeTools
    : [
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
    content: [
      { type: "text", text: nativeSequence ? "native-sequence" : "tools" },
    ],
  });
  const ids = [];
  const results = [];
  let mcpPid;
  let advertised = false;
  let completed = false;
  const diagnostics = [];
  for await (const event of session.events) {
    if (event.type === "session_error") throw new Error(event.error.message);
    if (event.type === "host_tool_request") {
      ids.push(event.call.id);
      assert.equal(
        event.call.name,
        nativeSequence && ids.length === 1 ? "read" : "edit",
      );
      if (nativeSequence) {
        assert.equal(event.call.id, expectedIds[ids.length - 1]);
        assert.deepEqual(
          event.call.arguments,
          event.call.name === "read"
            ? { path: "fixture.txt", i: "read fixture.txt to get snapshot tag" }
            : {
                input: "[fixture.txt#F27C]\nPUT 1.=1:\n+replacement",
                i: "replace line 1 with replacement using hashline syntax",
              },
        );
      }
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
          toolName: event.call.name,
          content: [{ type: "text", text: resultText(event.call.id) }],
          isError: false,
          structuredContent: { id: event.call.id },
        },
      ]);
    } else if (event.type === "observation" && event.subtype === "tools") {
      assert.deepEqual(
        event.data.data.tools,
        request.tools.map(({ owner, ...tool }) => {
          assert.equal(owner, "host");
          return tool;
        }),
      );
      advertised = true;
    } else if (
      event.type === "observation" &&
      event.subtype === "host-mcp-transport"
    ) {
      diagnostics.push(event.data);
    } else if (
      event.type === "observation" &&
      event.subtype === "tool-result"
    ) {
      assert.equal(event.data.result.isError, false);
      assert.deepEqual(event.data.result.content, [
        { type: "text", text: resultText(event.data.id) },
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
  assert.deepEqual(nativeSequence ? ids : ids.sort(), expectedIds);
  assert.deepEqual(nativeSequence ? results : results.sort(), expectedIds);
  assert.deepEqual(
    diagnostics
      .filter((entry) => entry.phase === "call-received")
      .map((entry) => entry.id)
      .sort(),
    [...expectedIds].sort(),
  );
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
      nativeSequence,
      cleaned: true,
    }) + "\n",
  );
} finally {
  await session?.close();
  await rm(directory, { recursive: true, force: true });
}
