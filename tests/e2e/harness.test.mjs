import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { publicAssistant, publicStats, textProof } from "./diagnostics.mjs";
import { hashlineProof } from "./hashline-proof.mjs";
import {
  ROOT,
  RpcHost,
  assertSocketCapacity,
  configureHostIsolation,
  executable,
  hostArgs,
  hostEnvironment,
  managedPiStartupOutput,
  scratchDirectory,
  scratchRoot,
} from "./rpc.mjs";

function runnerEnvironment(overrides) {
  const env = { ...process.env, ...overrides };
  // Node's child-v8 test context suppresses a nested runner's normal execution.
  delete env.NODE_TEST_CONTEXT;
  return env;
}

function hashlineEvents(input) {
  return [
    {
      type: "tool-end",
      data: {
        toolName: "read",
        isError: false,
        result: {
          content: [{ type: "text", text: "[fixture.txt#F27C]\n1:before" }],
        },
      },
    },
    {
      type: "tool-start",
      data: { toolName: "edit", toolCallId: "synthetic-edit", args: { input } },
    },
    {
      type: "tool-end",
      data: { toolName: "edit", toolCallId: "synthetic-edit", isError: false },
    },
  ];
}

test("managed startup accepts only observed footer diagnostics and records categories without raw output", async () => {
  const lines = [
    '[powerline-footer] Shortcut conflict for jumpChatBottom: "ctrl+shift+g" replaced with "super+up"',
    '[powerline-footer] Shortcut conflict for scrollChatUp: "super+up" replaced with "super+down"',
    '[powerline-footer] Shortcut conflict for scrollChatDown: "super+down" replaced with "super+shift+up"',
    '[powerline-footer] Shortcut conflict for editorStart: "super+shift+up" replaced with "super+shift+down"',
    '[powerline-footer] Shortcut conflict for editorEnd: "super+shift+down" is already in use',
  ];
  const script = `const diagnostics=${JSON.stringify(lines.join("\n") + "\n")};process.stdout.write(diagnostics);process.stdin.on('data',chunk=>{const command=JSON.parse(chunk);if(command.type==='new_session')process.stdout.write(diagnostics);process.stdout.write(JSON.stringify({type:'response',id:command.id,success:true,data:{models:[]}})+'\\n')});process.stdin.on('end',()=>process.exit(0));`;
  const rpc = new RpcHost(
    process.execPath,
    ["-e", script],
    process.env,
    scratchRoot(),
    { allowNonJsonOutput: managedPiStartupOutput },
  );
  try {
    assert.deepEqual(await rpc.command("get_available_models"), { models: [] });
    assert.deepEqual(rpc.startupOutputCounts, {
      "powerline-shortcut-conflict": 5,
    });
    // The deployed footer repeats the same diagnostics on new_session.
    await rpc.command("new_session");
    assert.deepEqual(rpc.startupOutputCounts, {
      "powerline-shortcut-conflict": 10,
    });
    assert.equal(
      JSON.stringify(rpc.frames).includes("powerline-footer"),
      false,
    );
    assert.equal(rpc.parseError, undefined);
  } finally {
    await rpc.close();
  }
});

for (const [name, line, opts] of [
  [
    "strict default rejects even known footer output",
    '[powerline-footer] Shortcut conflict for editorEnd: "super+shift+down" is already in use',
    {},
  ],
  [
    "managed opt-in rejects unknown footer output",
    '[powerline-footer] Shortcut conflict for editorEnd: "unknown" is already in use',
    { allowNonJsonOutput: managedPiStartupOutput },
  ],
  [
    "managed opt-in rejects malformed JSON",
    '{"type":"response",',
    { allowNonJsonOutput: managedPiStartupOutput },
  ],
  [
    "managed opt-in rejects unrelated non-JSON output",
    "unrelated startup diagnostics",
    { allowNonJsonOutput: managedPiStartupOutput },
  ],
])
  test(name, async () => {
    const output = `${line}\n`;
    const rpc = new RpcHost(
      process.execPath,
      [
        "-e",
        `process.stdout.write(${JSON.stringify(output)});process.stdin.resume();process.stdin.on('end',()=>process.exit(0));`,
      ],
      process.env,
      scratchRoot(),
      opts,
    );
    try {
      await assert.rejects(
        rpc.wait(() => false, "synthetic startup parsing", 1000),
        /Host emitted non-JSON RPC stdout/,
      );
      assert.deepEqual(rpc.startupOutputCounts, {});
    } finally {
      await rpc.close();
    }
  });

test("native fixture hashline proof accepts paired wrappers and unwrapped successful edits", () => {
  const body = "[fixture.txt#F27C]\nPUT 1.=1:\n+replacement";
  for (const input of [
    body,
    body + "\n",
    "*** Begin Patch\n" + body + "\n*** End Patch\n",
  ])
    assert.deepEqual(hashlineProof(hashlineEvents(input), "replacement\n"), {
      args: { input },
      readTag: "F27C",
      fileBytes: "replacement\n",
    });
});

test("hashline proof rejects mismatched tags, invalid syntax and Pi-style arguments", () => {
  for (const input of [
    "[fixture.txt#FFFF]\nPUT 1.=1:\n+replacement",
    "[fixture.txt#F27C]\nPUT 0.=1:\n+replacement",
    "[fixture.txt#F27C]\nPUT 1.=1:\nreplacement",
    "[fixture.txt#F27C]\nPUT 1.=1:\n+replacement\nREM",
    "*** Begin Patch\n[fixture.txt#F27C]\nPUT 1.=1:\n+replacement",
    "[fixture.txt#F27C]\nPUT 1.=1:\n+replacement\n*** End Patch",
    "*** Begin Patch\n*** Update File: fixture.txt\n@@\n-before\n+replacement\n*** End Patch",
  ])
    assert.throws(() => hashlineProof(hashlineEvents(input), "replacement\n"));
  const events = hashlineEvents("[fixture.txt#F27C]\nPUT 1.=1:\n+replacement");
  events[1].data.args = {
    path: "fixture.txt",
    oldText: "before",
    newText: "replacement",
  };
  assert.throws(() => hashlineProof(events, "replacement\n"));
});

test("hashline proof requires one successful correlated native execution and changed bytes", () => {
  const fixture = () =>
    hashlineEvents("[fixture.txt#F27C]\nPUT 1.=1:\n+replacement");
  for (const mutate of [
    (events) => events.pop(),
    (events) => events.push(events[0]),
    (events) => events.push(events[1]),
    (events) => {
      events[2].data.isError = true;
    },
    (events) => {
      events[2].data.toolCallId = "wrong-id";
    },
  ]) {
    const events = fixture();
    mutate(events);
    assert.throws(() => hashlineProof(events, "replacement\n"));
  }
  assert.throws(() => hashlineProof(fixture(), "before\n"));
});

test("semantic marker failure retains synthetic text, final usage/error and stats", async () => {
  const script = `
    const assistant = {role:'assistant',content:[{type:'text',text:'READY'}],stopReason:'stop',usage:{input:12,output:2,totalTokens:14,cost:{total:0.00003}},privateAccount:'never-record'};
    let buffer='';process.stdin.setEncoding('utf8');
    process.stdin.on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\\n'))!==-1){const command=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);const emit=value=>process.stdout.write(JSON.stringify(value)+'\\n');let data={isStreaming:false};if(command.type==='get_last_assistant_text')data={text:'READY'};if(command.type==='get_messages')data={messages:[assistant]};if(command.type==='get_session_stats')data={assistantMessages:1,tokens:{input:12,output:2,total:14},cost:0.00003,privateAccount:'never-record'};emit({type:'response',id:command.id,success:true,data});if(command.type==='prompt'){emit({type:'message_end',message:assistant});emit({type:'agent_settled'});}}});process.stdin.on('end',()=>process.exit(0));
  `;
  const rpc = new RpcHost(
    process.execPath,
    ["--input-type=module", "-e", script],
    process.env,
    scratchRoot(),
  );
  try {
    const text = await rpc.prompt("pi", "synthetic diagnostic fixture");
    assert.throws(
      () => textProof(text, "SYSTEM-synthetic", "READY"),
      /system prompt wasn't honored/,
    );
    assert.equal(rpc.responses[0].text, "READY");
    assert.equal(rpc.responses[0].assistant.stopReason, "stop");
    assert.deepEqual(rpc.responses[0].assistant.usage, {
      input: 12,
      output: 2,
      totalTokens: 14,
      cost: { total: 0.00003 },
    });
    assert.deepEqual(rpc.responses[0].stats, {
      assistantMessages: 1,
      cost: 0.00003,
      tokens: { input: 12, output: 2, total: 14 },
    });
    assert.equal(JSON.stringify(rpc.responses).includes("never-record"), false);
  } finally {
    await rpc.close();
  }
});

test("cancelled diagnostics retain local final assistant even when RPC reads are unavailable", async () => {
  const controller = new AbortController();
  const rpc = new RpcHost(
    process.execPath,
    [
      "-e",
      "process.stdin.resume();process.stdin.on('end',()=>process.exit(0));",
    ],
    process.env,
    scratchRoot(),
    { signal: controller.signal },
  );
  try {
    rpc.frames.push({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "synthetic partial" }],
        stopReason: "aborted",
        errorMessage: "synthetic aborted",
        usage: { input: 3, output: 1, totalTokens: 4 },
      },
    });
    controller.abort(new Error("synthetic deadline"));
    const captured = await rpc.captureResponse(
      "synthetic-prompt",
      0,
      undefined,
      new Error("synthetic original failure"),
    );
    assert.equal(captured.text, "synthetic partial");
    assert.equal(captured.assistant.stopReason, "aborted");
    assert.equal(captured.assistant.errorMessage, "synthetic aborted");
    assert.equal(captured.assistant.usage.output, 1);
    assert.deepEqual(
      captured.unavailable.map((item) => item.command),
      ["get_messages", "get_session_stats"],
    );
    assert.equal(rpc.assistantMessages()[0].text, "synthetic partial");
    assert.equal(captured.error.message, "synthetic original failure");
  } finally {
    await rpc.close();
  }
});

test("public diagnostic projections exclude private payload fields", () => {
  assert.equal(publicAssistant({ role: "user", content: [] }), undefined);
  assert.deepEqual(
    publicStats({ tokens: { input: 4, auth: "secret" }, credential: "secret" }),
    { tokens: { input: 4 } },
  );
});

test("OMP normalized observations whitelist synthetic event metadata without payload values", async () => {
  const { normalizedObservation } = await import("./observer.ts");
  const sandbox = scratchDirectory("observer-");
  const previous = process.env.PCC_E2E_OBSERVATIONS;
  const path = join(sandbox, "observations.jsonl");
  try {
    process.env.PCC_E2E_OBSERVATIONS = path;
    normalizedObservation({ owner: "other", event: { type: "observation" } });
    normalizedObservation({
      owner: "claude",
      event: { type: "assistant_snapshot", content: "never-record" },
    });
    normalizedObservation({
      owner: "claude",
      privateAccount: "never-record",
      event: {
        type: "host_tool_request",
        sequence: 7,
        attribution: { toolUseId: "synthetic-id", apiKey: "never-record" },
        call: {
          id: "synthetic-id",
          name: "edit",
          arguments: { input: "never-record" },
        },
        data: { auth: "never-record" },
      },
    });
    normalizedObservation({
      owner: "claude",
      event: {
        type: "observation",
        family: "user-input",
        subtype: "user",
        data: { text: "never-record" },
      },
    });
    normalizedObservation({
      owner: "claude",
      event: {
        type: "session_error",
        error: {
          code: "protocol",
          message: "never-record",
          details: { auth: "never-record" },
        },
      },
    });
    const raw = readFileSync(path, "utf8");
    const events = raw
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(events.length, 3);
    assert.deepEqual(events[0], {
      type: "normalized-observation",
      data: {
        type: "host_tool_request",
        sequence: 7,
        attribution: { toolUseId: "synthetic-id" },
        call: { id: "synthetic-id", name: "edit", inputKeys: ["input"] },
      },
    });
    assert.equal(events[1].data.family, "user-input");
    assert.equal(events[2].data.errorCode, "protocol");
    assert.equal(raw.includes("never-record"), false);
  } finally {
    if (previous === undefined) delete process.env.PCC_E2E_OBSERVATIONS;
    else process.env.PCC_E2E_OBSERVATIONS = previous;
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("dedicated OMP diagnostic timeline retains nested boundary IDs and state without payloads", async () => {
  const { nativeDiagnostic } = await import("./observer.ts");
  const sandbox = scratchDirectory("observer-");
  const previous = process.env.PCC_E2E_OBSERVATIONS;
  const path = join(sandbox, "observations.jsonl");
  try {
    process.env.PCC_E2E_OBSERVATIONS = path;
    const attribution = {
      messageId: "synthetic-message",
      parentToolUseId: null,
    };
    const runtimeBoundary = {
      roundDone: false,
      messageCount: 1,
      proposalCount: 1,
      parkedCount: 1,
      deliveredCount: 0,
      messages: [
        {
          messageId: "synthetic-message",
          ended: false,
          blockCount: 1,
          toolCallIds: ["synthetic-edit"],
        },
      ],
      unendedMessageIds: ["synthetic-message"],
      proposalIds: ["synthetic-edit"],
      unparkedProposalIds: [],
      parkedIds: ["synthetic-edit"],
      deliveredIds: [],
    };
    nativeDiagnostic({
      owner: "claude",
      hostSession: { sessionId: "synthetic-session", auth: "never-record" },
      hostAgent: { kind: "main", id: "synthetic-agent", name: "never-record" },
      event: {
        type: "observation",
        family: "diagnostic",
        subtype: "core-assistant-snapshot",
        sequence: 12,
        attribution: { ...attribution, auth: "never-record" },
        data: {
          messageId: "synthetic-message",
          previousActiveMessageId: null,
          activeMessageId: "synthetic-message",
          ended: false,
          stopReasonPresent: true,
          blockCount: 1,
          blocks: [
            {
              index: 0,
              type: "tool_call",
              ended: true,
              toolCallId: "synthetic-edit",
              arguments: { input: "never-record" },
              text: "never-record",
            },
          ],
          snapshotId: "synthetic-snapshot",
          snapshotKnownMessage: true,
          snapshotFull: false,
          snapshotStopReasonPresent: true,
          runtimeBoundary: {
            ...runtimeBoundary,
            messages: [
              { ...runtimeBoundary.messages[0], content: "never-record" },
            ],
            auth: "never-record",
          },
          text: "never-record",
          args: "never-record",
        },
      },
    });
    nativeDiagnostic({
      owner: "claude",
      event: {
        type: "observation",
        family: "diagnostic",
        subtype: "host-mcp-park",
        sequence: 13,
        attribution: { toolUseId: "synthetic-edit" },
        data: {
          toolUseId: "synthetic-edit",
          toolName: "edit",
          serverName: "host",
          arguments: { input: "never-record" },
          auth: "never-record",
        },
      },
    });
    const raw = readFileSync(path, "utf8");
    const timeline = raw
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(timeline, [
      {
        type: "native-diagnostic",
        data: {
          owner: "claude",
          hostSession: { sessionId: "synthetic-session" },
          hostAgent: { kind: "main", id: "synthetic-agent" },
          event: {
            type: "observation",
            family: "diagnostic",
            subtype: "core-assistant-snapshot",
            sequence: 12,
            attribution,
            data: {
              messageId: "synthetic-message",
              previousActiveMessageId: null,
              activeMessageId: "synthetic-message",
              ended: false,
              stopReasonPresent: true,
              blockCount: 1,
              blocks: [
                {
                  index: 0,
                  type: "tool_call",
                  ended: true,
                  toolCallId: "synthetic-edit",
                },
              ],
              snapshotId: "synthetic-snapshot",
              snapshotKnownMessage: true,
              snapshotFull: false,
              snapshotStopReasonPresent: true,
              runtimeBoundary,
            },
          },
        },
      },
      {
        type: "native-diagnostic",
        data: {
          owner: "claude",
          hostSession: {},
          hostAgent: {},
          event: {
            type: "observation",
            family: "diagnostic",
            subtype: "host-mcp-park",
            sequence: 13,
            attribution: { toolUseId: "synthetic-edit" },
            data: {
              toolUseId: "synthetic-edit",
              toolName: "edit",
              serverName: "host",
            },
          },
        },
      },
    ]);
    assert.equal(raw.includes("never-record"), false);
  } finally {
    if (previous === undefined) delete process.env.PCC_E2E_OBSERVATIONS;
    else process.env.PCC_E2E_OBSERVATIONS = previous;
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("dedicated OMP diagnostics reject unsupported events and bound identifiers and nested arrays", async () => {
  const { nativeDiagnostic } = await import("./observer.ts");
  const sandbox = scratchDirectory("observer-");
  const previous = process.env.PCC_E2E_OBSERVATIONS;
  const path = join(sandbox, "observations.jsonl");
  const event = {
    type: "observation",
    family: "diagnostic",
    subtype: "core-message-start",
    sequence: 0,
    attribution: {},
    data: {},
  };
  try {
    process.env.PCC_E2E_OBSERVATIONS = path;
    for (const invalid of [
      { owner: "other", event },
      { owner: "claude", event: { ...event, sequence: -1 } },
      { owner: "claude", event: { ...event, sequence: 1.2 } },
      { owner: "claude", event: { ...event, subtype: "unknown" } },
      { owner: "claude", event: { ...event, family: "user-input" } },
    ])
      nativeDiagnostic(invalid);
    assert.equal(existsSync(path), false);
    const ids = Array.from({ length: 40 }, (_, i) => `synthetic-${i}`);
    nativeDiagnostic({
      owner: "claude",
      hostSession: { sessionId: "x".repeat(129), branchId: "bad\nidentifier" },
      event: {
        ...event,
        data: {
          messageId: "",
          ended: "false",
          blockCount: -1,
          blocks: ids.map((id) => ({
            index: 0,
            type: "tool_call",
            toolCallId: id,
            ended: true,
          })),
          runtimeBoundary: {
            roundDone: false,
            messages: ids.map((id) => ({
              messageId: id,
              ended: false,
              toolCallIds: ids,
            })),
            proposalIds: ids,
            parkedIds: ["", "x".repeat(129), "bad\nidentifier", "valid-id"],
          },
        },
      },
    });
    const captured = JSON.parse(readFileSync(path, "utf8"));
    assert.deepEqual(captured.data.hostSession, {});
    const data = captured.data.event.data;
    assert.equal(data.messageId, undefined);
    assert.equal(data.ended, undefined);
    assert.equal(data.blockCount, undefined);
    assert.equal(data.blocks.length, 32);
    assert.equal(data.runtimeBoundary.messages.length, 32);
    assert.equal(data.runtimeBoundary.messages[0].toolCallIds.length, 32);
    assert.deepEqual(data.runtimeBoundary.proposalIds, ids.slice(0, 32));
    assert.deepEqual(data.runtimeBoundary.parkedIds, ["valid-id"]);
    assert.equal(data.runtimeBoundary.roundDone, false);
  } finally {
    if (previous === undefined) delete process.env.PCC_E2E_OBSERVATIONS;
    else process.env.PCC_E2E_OBSERVATIONS = previous;
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("native prompt observations retain only marker presence and effective length", async () => {
  const { providerPrompt, systemPrompt } = await import("./observer.ts");
  const sandbox = scratchDirectory("observer-");
  const previousPath = process.env.PCC_E2E_OBSERVATIONS;
  const previousMarker = process.env.PCC_E2E_SYSTEM_MARKER;
  const path = join(sandbox, "observations.jsonl");
  try {
    process.env.PCC_E2E_OBSERVATIONS = path;
    process.env.PCC_E2E_SYSTEM_MARKER = "SYSTEM-synthetic";
    const prompt = "SYSTEM-synthetic private instructions never-record";
    providerPrompt({
      systemPrompt: prompt,
      auth: { apiKey: "never-record" },
      privatePayload: "never-record",
    });
    systemPrompt("before_agent_start", ["prefix", "SYSTEM-synthetic"]);
    const events = readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(events[0], {
      type: "system-prompt",
      data: {
        stage: "before_provider_request",
        available: true,
        markerConfigured: true,
        markerIncluded: true,
        length: prompt.length,
        parts: 1,
      },
    });
    assert.equal(events[1].data.parts, 2);
    assert.equal(events[1].data.markerIncluded, true);
    assert.equal(readFileSync(path, "utf8").includes("never-record"), false);
    assert.equal(
      readFileSync(path, "utf8").includes("SYSTEM-synthetic"),
      false,
    );
  } finally {
    if (previousPath === undefined) delete process.env.PCC_E2E_OBSERVATIONS;
    else process.env.PCC_E2E_OBSERVATIONS = previousPath;
    if (previousMarker === undefined) delete process.env.PCC_E2E_SYSTEM_MARKER;
    else process.env.PCC_E2E_SYSTEM_MARKER = previousMarker;
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("disabled direct runner explicitly skips all four authenticated cases", () => {
  const env = runnerEnvironment({ PI_CLAUDE_LIVE_E2E: "0" });
  const result = spawnSync(
    process.execPath,
    ["--test", "--test-reporter=tap", join(ROOT, "tests/e2e/live.test.mjs")],
    { env, encoding: "utf8", timeout: 10000 },
  );
  assert.equal(result.status, 0);
  assert.match(result.stdout, /skipped 4/);
  for (const name of ["pi+cli", "pi+sdk", "omp+cli", "omp+sdk"])
    assert.ok(result.stdout.includes(`actual ${name}:`));
});

test("opt-in with a missing host prerequisite fails without starting inference", () => {
  const receipts = scratchDirectory("prerequisite-receipts-");
  try {
    const env = runnerEnvironment({
      PI_CLAUDE_LIVE_E2E: "1",
      PI_CLAUDE_LIVE_CASE: "pi+cli",
      PI_E2E_BIN: "/pcc-missing-host",
      PI_CLAUDE_E2E_RECEIPT_DIR: receipts,
    });
    const result = spawnSync(
      process.execPath,
      ["--test", "--test-reporter=tap", join(ROOT, "tests/e2e/live.test.mjs")],
      { env, encoding: "utf8", timeout: 10000 },
    );
    assert.equal(result.status, 1);
    assert.match(
      result.stdout,
      /Missing executable prerequisite: \/pcc-missing-host/,
    );
    assert.match(result.stdout, /fail 1/);
    assert.match(result.stdout, /skipped 3/);
  } finally {
    rmSync(receipts, { recursive: true, force: true });
  }
});

test("invalid selected case is a failure even when no matrix case matches", () => {
  const result = spawnSync(
    process.execPath,
    ["--test", "--test-reporter=tap", join(ROOT, "tests/e2e/live.test.mjs")],
    {
      env: runnerEnvironment({
        PI_CLAUDE_LIVE_E2E: "1",
        PI_CLAUDE_LIVE_CASE: "invented",
      }),
      encoding: "utf8",
      timeout: 10000,
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Invalid PI_CLAUDE_LIVE_CASE/);
});

test("login isolation retains official config location and clears alternative auth", () => {
  const env = hostEnvironment("pi", "sdk", "/tmp/synthetic-host", "nonce", {
    PATH: process.env.PATH,
    CLAUDE_CONFIG_DIR: "/official-config",
    ANTHROPIC_API_KEY: "synthetic-secret",
    ANTHROPIC_AUTH_TOKEN: "synthetic-token",
    ANTHROPIC_BASE_URL: "https://alternative.invalid",
    CLAUDE_CODE_OAUTH_TOKEN: "synthetic-oauth",
    CLAUDE_CODE_USE_BEDROCK: "1",
    AWS_PROFILE: "other",
    BUN_BE_BUN: "1",
    PI_CLAUDE_EFFORT: "high",
    PI_CLAUDE_MCP_CONFIG: "/unrelated-config",
    PI_CONFIG_FILES: "/unrelated-host-config",
  });
  assert.equal(env.CLAUDE_CONFIG_DIR, "/official-config");
  for (const name of [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "AWS_PROFILE",
    "BUN_BE_BUN",
    "PI_CLAUDE_EFFORT",
    "PI_CLAUDE_MCP_CONFIG",
    "PI_CONFIG_FILES",
  ])
    assert.equal(env[name], undefined, name);
  assert.equal(env.PI_CLAUDE_DRIVER, "sdk");
  assert.equal(env.PI_CLAUDE_AUTH, "claude-login");
  assert.equal(env.PI_CLAUDE_MAX_OUTPUT_TOKENS, "512");
  assert.equal(env.PI_CLAUDE_MAX_TURNS, "8");
});

test("api-key mode requires explicit key and preserves only selected API auth", () => {
  assert.throws(
    () =>
      hostEnvironment("omp", "cli", "/tmp/synthetic", "nonce", {
        PI_CLAUDE_AUTH: "api-key",
      }),
    /requires ANTHROPIC_API_KEY/,
  );
  const env = hostEnvironment("omp", "cli", "/tmp/synthetic", "nonce", {
    PI_CLAUDE_AUTH: "api-key",
    ANTHROPIC_API_KEY: "synthetic-key",
    ANTHROPIC_BASE_URL: "https://api.invalid",
    ANTHROPIC_AUTH_TOKEN: "other",
  });
  assert.equal(env.ANTHROPIC_API_KEY, "synthetic-key");
  assert.equal(env.ANTHROPIC_BASE_URL, "https://api.invalid");
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
});

test("executable prerequisite rejects missing paths", () => {
  assert.throws(
    () => executable("/pcc-missing-executable"),
    /Missing executable prerequisite/,
  );
});

test("OMP native discovery isolation preserves explicit extensions and native tools", () => {
  const sandbox = scratchDirectory("l-");
  const path = join(sandbox, "host-isolation.yml");
  try {
    configureHostIsolation("pi", sandbox);
    assert.equal(existsSync(path), false);
    configureHostIsolation("omp", sandbox);
    assert.equal(
      readFileSync(path, "utf8"),
      'disabledProviders: ["claude", "claude-plugins"]\nmcp:\n  enableProjectConfig: false\n',
    );
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const args = hostArgs("omp", sandbox, "synthetic system marker");
    assert.equal(args[args.indexOf("--config") + 1], path);
    assert.ok(args.includes(join(ROOT, "entrypoints/omp.ts")));
    assert.ok(args.includes(join(ROOT, "tests/e2e/omp-tools.ts")));
    assert.equal(
      args[args.indexOf("--tools") + 1],
      "read,write,bash,edit,pcc_sentinel,pcc_slow",
    );
    assert.equal(hostArgs("pi", sandbox, "marker").includes("--config"), false);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("scratch defaults and Linux socket capacity obey the project storage rule", () => {
  const root = scratchRoot();
  assert.ok(root.includes("/dev/agentic-scratchpads/pi-claude-cli/"));
  const sandbox = scratchDirectory("e-");
  try {
    assert.ok(assertSocketCapacity(sandbox) <= 107);
    assert.throws(
      () => assertSocketCapacity(join(root, "x".repeat(108))),
      /exceeds Linux Unix socket capacity/,
    );
    assert.throws(
      () =>
        scratchRoot({
          PI_CLAUDE_E2E_SCRATCH_DIR: "/tmp/not-authorized-storage",
        }),
      /must be under the project scratchpads/,
    );
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("test-context cancellation rejects an active RPC wait and permits awaited cleanup", async () => {
  const controller = new AbortController();
  const rpc = new RpcHost(
    process.execPath,
    [
      "-e",
      "process.stdin.resume(); process.stdin.on('end',()=>process.exit(0));",
    ],
    process.env,
    scratchRoot(),
    { signal: controller.signal },
  );
  try {
    const pending = rpc.wait(() => false, "synthetic timeout", 10000);
    controller.abort(new Error("synthetic test timeout"));
    await assert.rejects(pending, /synthetic test timeout/);
    assert.throws(() => rpc.send("prompt"), /synthetic test timeout/);
  } finally {
    const cleanup = await rpc.close();
    assert.deepEqual(cleanup.survivors, []);
    assert.deepEqual(cleanup.forcedChildren, []);
  }
});

for (const host of ["pi", "omp"]) {
  test(`synthetic RPC parser ${host}: command acceptance doesn't complete the prompt`, async () => {
    // This is a parser test, not a live host or inference substitute.
    const script = `
      let buffer = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', chunk => {
        buffer += chunk;
        let end;
        while ((end = buffer.indexOf('\\n')) !== -1) {
          const command = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
          const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
          emit({type:'response',id:command.id,success:true,data:{isStreaming:false,isSettled:true}});
          if (command.type === 'prompt') setTimeout(() => {
            ${host === "omp" ? "emit({type:'prompt_result',id:command.id,status:'completed'}); emit({type:'session_settled'});" : "emit({type:'agent_settled'});"}
          }, 150);
        }
      });
      process.stdin.on('end', () => process.exit(0));
    `;
    const rpc = new RpcHost(
      process.execPath,
      ["--input-type=module", "-e", script],
      process.env,
      scratchRoot(),
    );
    try {
      const since = rpc.frames.length;
      const id = rpc.send("prompt", { message: "synthetic-parser-only" });
      const before = Date.now();
      await rpc.settled(host, id, since);
      assert.ok(
        Date.now() - before >= 100,
        "Parser treated prompt acceptance as completion",
      );
      assert.ok(
        rpc.frames.some(
          (frame) =>
            frame.type === (host === "pi" ? "agent_settled" : "prompt_result"),
        ),
      );
    } finally {
      const cleanup = await rpc.close();
      assert.deepEqual(cleanup.forcedChildren, []);
      assert.deepEqual(cleanup.survivors, []);
    }
  });
}

for (const mode of ["graceful", "leak", "ignore"]) {
  test(`synthetic child ownership ${mode}: host SIGTERM precedes fallback`, async () => {
    const sandbox = scratchDirectory("cleanup-fixture-");
    const log = join(sandbox, "child-signals.log");
    const rpc = new RpcHost(
      process.execPath,
      [join(ROOT, "tests/e2e/cleanup-host.mjs"), mode, log],
      process.env,
      sandbox,
    );
    let cleanup;
    try {
      const ready = await rpc.wait(
        () => rpc.frames.find((frame) => frame.type === "fixture_ready"),
        "synthetic owned child ready",
      );
      rpc.track();
      cleanup = await rpc.close();
      assert.deepEqual(cleanup.survivors, []);
      assert.ok(cleanup.observedPids.includes(ready.childPid));
      if (mode === "graceful") {
        assert.equal(
          readFileSync(log, "utf8"),
          "owner-shutdown\n",
          "Harness signalled the child instead of letting its host close it",
        );
        assert.deepEqual(cleanup.forcedChildren, []);
        assert.equal(cleanup.hostRequiredKill, false);
      } else {
        assert.deepEqual(
          cleanup.forcedChildren,
          [ready.childPid],
          "Fallback must identify the actual leaked child",
        );
        assert.equal(cleanup.hostRequiredKill, mode === "ignore");
        if (mode === "leak")
          assert.equal(readFileSync(log, "utf8"), "direct-child-sigterm\n");
        else
          assert.equal(
            existsSync(log),
            false,
            "Emergency group SIGKILL must not masquerade as owner cleanup",
          );
      }
    } finally {
      try {
        if (!cleanup) await rpc.close();
      } finally {
        rmSync(sandbox, { recursive: true, force: true });
      }
    }
  });
}
