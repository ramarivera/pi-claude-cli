import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { clampThinkingLevel } from "@earendil-works/pi-ai/compat";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { publicStats, textProof } from "./diagnostics.mjs";
import {
  CASES,
  ROOT,
  RpcHost,
  assertSocketCapacity,
  configureHostIsolation,
  hostArgs,
  hostEnvironment,
  managedPiStartupOutput,
  preflight,
  receiptDirectory,
  scratchDirectory,
} from "./rpc.mjs";

// This file has its own opt-in so running it never starts the larger live suite.
const enabled = process.env.PI_CLAUDE_BOUNDARY_E2E === "1";
const selected = process.env.PI_CLAUDE_BOUNDARY_CASE;
const installed = process.env.PI_CLAUDE_BOUNDARY_INSTALLED === "1";
const boundaryModel =
  process.env.PI_CLAUDE_BOUNDARY_MODEL ?? "claude-sonnet-5-5";
assert.ok(
  !installed || enabled,
  "PI_CLAUDE_BOUNDARY_INSTALLED=1 requires PI_CLAUDE_BOUNDARY_E2E=1",
);
if (enabled && selected)
  assert.ok(
    CASES.includes(selected),
    "Invalid PI_CLAUDE_BOUNDARY_CASE selection",
  );

function observations(path) {
  return existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
}

function assertNoSteeringWarning(events, hostKind) {
  if (hostKind !== "omp") return;
  assert.ok(
    events.some((event) => event.type === "steering-status-observer"),
    "Native OMP ctx.ui.setStatus observer wasn't installed",
  );
  assert.equal(
    events.filter(
      (event) => event.type === "steering-status" && event.data.hasText,
    ).length,
    0,
    "OMP emitted pi-claude-cli-steering status text without unsupported live input",
  );
}

function systemPromptProof(events) {
  const provider = events.flatMap((event, index) => {
    if (
      event.type !== "system-prompt" ||
      event.data.stage !== "before_provider_request"
    )
      return [];
    // observer.providerPrompt writes these two records synchronously. Other
    // managed extensions may issue auxiliary requests through another provider.
    const input = events[index + 1];
    return [
      {
        prompt: event,
        bridge:
          input?.type === "steering-input" &&
          input.data.callScope !== "auxiliary" &&
          ["prompt", "tool-results"].includes(input.data.kind),
      },
    ];
  });
  return {
    bridgeRequests: provider
      .filter((event) => event.bridge)
      .map((event) => event.prompt),
    auxiliaryRequests: provider.filter((event) => !event.bridge).length,
  };
}

function assertSystemPrompt(events) {
  const proof = systemPromptProof(events);
  for (const stage of ["before_agent_start", "before_provider_request"]) {
    const prompts =
      stage === "before_provider_request"
        ? proof.bridgeRequests
        : events.filter(
            (event) =>
              event.type === "system-prompt" && event.data.stage === stage,
          );
    assert.ok(
      prompts.length > 0,
      `Actual ${stage} system prompt wasn't observed`,
    );
    assert.ok(
      prompts.every(
        ({ data }) =>
          data.available && data.markerConfigured && data.markerIncluded,
      ),
      `Actual ${stage} lost the configured synthetic system prompt`,
    );
  }
  return {
    bridgeRequests: proof.bridgeRequests.length,
    auxiliaryRequests: proof.auxiliaryRequests,
  };
}

function errorClassifier(value, stopReason) {
  const text = typeof value === "string" ? value.slice(0, 65536) : "";
  if (
    /^Concurrent (Pi|OMP) provider rounds for one (session|logical agent) aren't supported$/.test(
      text,
    )
  )
    return "concurrent-session";
  if (
    /budget.{0,80}(exceed|maximum|limit)|exceed.{0,80}budget|max_budget_usd/i.test(
      text,
    )
  )
    return "budget";
  if (
    /authenticat|unauthoriz|invalid.{0,20}(api.?key|token)|not logged in|login required/i.test(
      text,
    )
  )
    return "authentication";
  if (/rate.?limit|too many requests|\b429\b/i.test(text)) return "rate-limit";
  if (
    /context.{0,40}(limit|length|window)|prompt.{0,30}too long|maximum.{0,20}tokens/i.test(
      text,
    )
  )
    return "context-limit";
  if (/timed? ?out|timeout/i.test(text)) return "timeout";
  if (/abort|cancel/i.test(text) || stopReason === "aborted")
    return "cancellation";
  if (
    /transport|broken pipe|econnreset|socket|process.{0,30}(exit|spawn)/i.test(
      text,
    )
  )
    return "transport";
  return text ? "unknown" : "none";
}

function assistantDiagnostics(messages, boundaryStart = messages.length) {
  const errors = messages.flatMap((message, index) => {
    if (
      message.role !== "assistant" ||
      !["error", "aborted"].includes(message.stopReason)
    )
      return [];
    return [
      {
        phase: index < boundaryStart ? "greeting" : "boundary",
        providerScope:
          message.provider === "pi-claude-cli" &&
          message.model === boundaryModel
            ? "main"
            : typeof message.provider === "string" &&
                typeof message.model === "string"
              ? "other"
              : "unattributed",
        stopReason: message.stopReason,
        classifier: errorClassifier(message.errorMessage, message.stopReason),
        errorPresent:
          typeof message.errorMessage === "string" &&
          message.errorMessage.length > 0,
        errorLength:
          typeof message.errorMessage === "string"
            ? Math.min(message.errorMessage.length, 65536)
            : 0,
      },
    ];
  });
  return {
    errorCount: errors.length,
    errors: errors.slice(0, 32),
    truncated: errors.length > 32,
  };
}

const mcpDiscoveryScript = `
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initializeWithSettings, loadCapability } from "@oh-my-pi/pi-coding-agent/discovery";
import { cfgDisabledExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/settings";
try {
  const {cwd, agentDir, configFile} = await Bun.stdin.json();
  const settings = await Settings.loadReadOnly({cwd, agentDir, configFiles:[configFile]});
  const release = initializeWithSettings(settings);
  try {
    const result = await loadCapability("mcps", {cwd, agentDir, filter: server => server._source.level !== "project"});
    const names = [...new Set(result.items.map(server => server.name))].sort();
    const disabledExtensions = cfgDisabledExtensions.get(settings);
    if (names.length > 128 || names.some(name => typeof name !== "string" || !/^[a-zA-Z0-9._:-]{1,128}$/.test(name))) throw new Error("Invalid MCP IDs");
    process.stdout.write(JSON.stringify({names, disabledExtensions, warningCount:result.warnings.length}));
  } finally { release(); }
} catch { process.stdout.write(JSON.stringify({failed:true})); process.exitCode=1; }
`;

function isolateOmpMcp(sandbox, env) {
  const configFile = join(sandbox, "host-isolation.yml");
  // Capability discovery only reads config; it never connects to a server or
  // imports extension factories. The actual host still discovers installed
  // packages and all managed extensions, including Remnic.
  const discovered = spawnSync("bun", ["-e", mcpDiscoveryScript], {
    cwd: ROOT,
    env,
    input: JSON.stringify({
      cwd: sandbox,
      agentDir: env.PI_CODING_AGENT_DIR,
      configFile,
    }),
    encoding: "utf8",
    timeout: 15000,
    maxBuffer: 65536,
  });
  assert.equal(discovered.status, 0, "Read-only native MCP discovery failed");
  const result = JSON.parse(discovered.stdout);
  const serverIds = result.names.map((name) => `mcp:${name}`);
  const disabledExtensions = [
    ...new Set([...result.disabledExtensions, ...serverIds]),
  ];
  writeFileSync(
    configFile,
    JSON.stringify({
      disabledProviders: ["claude", "claude-plugins"],
      disabledExtensions,
      mcp: { enableProjectConfig: false },
    }) + "\n",
    { mode: 0o600 },
  );
  return {
    serverIds,
    warningCount: result.warningCount,
    configScope: "owned-session-overlay",
    managedExtensionsPreserved: true,
  };
}

function steeringConsumption(events) {
  const admissions = events.filter(
    (event) => event.type === "steering-admission",
  );
  const queued = admissions.filter(({ data }) => data.state === "queued");
  const started = admissions.filter(({ data }) => data.state === "started");
  return {
    queuedCount: queued.length,
    startedCount: started.length,
    commandId: queued[0]?.data.commandId,
    matchingCommandIds:
      queued.length === 1 &&
      started.length === 1 &&
      queued[0].data.commandId === started[0].data.commandId,
    queuedBeforeStarted:
      admissions.length === 2 &&
      admissions[0].data.state === "queued" &&
      admissions[1].data.state === "started",
    events: admissions.map(({ data }) => data),
  };
}

function nativeOutputProof(events) {
  const output = events.filter((event) => event.type === "native-output");
  const snapshots = output.filter(
    ({ data }) => data.eventType === "assistant_snapshot",
  );
  const results = output.filter(({ data }) => data.eventType === "turn_end");
  return {
    outputEventCount: output.length,
    snapshotCount: snapshots.length,
    resultCount: results.length,
    nativeSnapshotMarkerIncluded: snapshots.some(
      ({ data }) => data.markerIncluded,
    ),
    nativeResultMarkerIncluded: results.some(({ data }) => data.markerIncluded),
    nativeStreamMarkerIncluded: output.some(({ data }) => data.markerIncluded),
    events: output.map(({ data }) => data),
  };
}

function managedPiHelperCommand(name, executable, argv, root) {
  const broker = join(root, "pi-intercom/broker/broker.ts");
  const cli = join(root, "tsx/dist/cli.mjs");
  const preflight = join(root, "tsx/dist/preflight.cjs");
  const loader = pathToFileURL(join(root, "tsx/dist/loader.mjs")).href;
  const node = name === "node-MainThread" && /\/node(?:js)?$/.test(executable);
  if (node && argv.length === 3 && argv[1] === cli && argv[2] === broker)
    return "pi-intercom";
  if (
    node &&
    argv.length === 6 &&
    argv[1] === "--require" &&
    argv[2] === preflight &&
    ["--import", "--loader"].includes(argv[3]) &&
    argv[4] === loader &&
    argv[5] === broker
  )
    return "pi-intercom";
  const compiler = join(root, "@esbuild/linux-x64/bin/esbuild");
  if (
    name === "esbuild" &&
    executable === compiler &&
    argv.length === 3 &&
    argv[0] === compiler &&
    /^--service=\d+\.\d+\.\d+$/.test(argv[1]) &&
    argv[2] === "--ping"
  )
    return "intercom-compiler";
}

function managedPiHelper(process) {
  if (!["node-MainThread", "esbuild"].includes(process.name)) return;
  try {
    const argv = readFileSync(`/proc/${process.pid}/cmdline`, "utf8")
      .split("\0")
      .filter(Boolean);
    const executable = realpathSync(`/proc/${process.pid}/exe`);
    const stat = readFileSync(`/proc/${process.pid}/stat`, "utf8");
    if (stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] !== process.start)
      return;
    const root = join(homedir(), ".pi/agent/npm/node_modules");
    return managedPiHelperCommand(process.name, executable, argv, root);
  } catch {
    /* A process can exit before classification; unknown children stay strict. */
  }
}

function nativeHelperCleanup(
  cleanup,
  baseline,
  hostPid,
  baselineProcesses,
  allowIntercom = false,
) {
  const observed = new Map(
    cleanup.observedProcesses.map((process) => [process.pid, process]),
  );
  const original = new Map(
    baselineProcesses.map((process) => [process.pid, process]),
  );
  const helpers = [],
    rejected = [];
  for (const pid of cleanup.forcedChildren) {
    const process = observed.get(pid);
    const before = original.get(pid);
    let reason;
    const ancestors = [];
    const postBaselineIntercom =
      !baseline.has(pid) &&
      allowIntercom &&
      ["pi-intercom", "intercom-compiler"].includes(before?.helperOwner) &&
      process?.helperOwner === before.helperOwner;
    if (!baseline.has(pid) && !postBaselineIntercom)
      reason = "after-inference-baseline";
    else if (!process || !before) reason = "missing-process-evidence";
    else if (
      !["node-MainThread", "esbuild"].includes(process.name) ||
      process.name !== before.name
    )
      reason = "unknown-helper-name";
    else if (process.start !== before.start)
      reason = "changed-process-identity";
    else {
      // The initial ancestry is captured before any inference. Require a full
      // chain to the owned host, then check current recorded ancestry too.
      for (const graph of [original, observed]) {
        const visited = new Set();
        let cursor = pid;
        let brokerSeen = false;
        while (cursor !== hostPid) {
          if (visited.has(cursor) || visited.size >= 32) {
            reason = "unbounded-or-cyclic-ancestry";
            break;
          }
          visited.add(cursor);
          const ancestor = graph.get(cursor);
          if (!ancestor) {
            reason = "unknown-ancestry";
            break;
          }
          if (/claude/i.test(ancestor.name)) {
            reason = "claude-transport-ancestry";
            break;
          }
          if (postBaselineIntercom) {
            const anchor = original.get(cursor),
              current = observed.get(cursor);
            if (
              !anchor ||
              !current ||
              anchor.start !== current.start ||
              anchor.name !== current.name ||
              anchor.helperOwner !== current.helperOwner
            ) {
              reason = "changed-ancestor-identity";
              break;
            }
            if (current.parent !== anchor.parent && current.parent !== 1) {
              reason = "changed-ancestor-parent";
              break;
            }
            if (
              !["pi-intercom", "intercom-compiler"].includes(
                ancestor.helperOwner,
              )
            ) {
              reason = "unverified-intercom-ancestry";
              break;
            }
            brokerSeen ||= ancestor.helperOwner === "pi-intercom";
          }
          if (graph === original) ancestors.push(cursor);
          // A host exit can reparent a proven startup helper to Linux init.
          if (graph === observed && ancestor.parent === 1) break;
          cursor = ancestor.parent;
        }
        if (
          !reason &&
          postBaselineIntercom &&
          graph === original &&
          !brokerSeen
        )
          reason = "missing-intercom-broker";
        if (reason) break;
      }
      if (!reason && postBaselineIntercom) {
        const anchor = original.get(hostPid),
          current = observed.get(hostPid);
        if (
          !anchor ||
          !current ||
          anchor.start !== current.start ||
          anchor.name !== current.name
        )
          reason = "changed-host-identity";
      }
    }
    if (reason) rejected.push({ pid, reason });
    else
      helpers.push({
        pid,
        name: process.name,
        parent: before.parent,
        start: process.start,
        ancestors,
        ...(postBaselineIntercom ? { helperOwner: before.helperOwner } : {}),
      });
  }
  return {
    allowedHelperCount: helpers.length,
    allowedHelpers: helpers.slice(0, 32),
    rejectedCount: rejected.length,
    rejectedChildren: rejected.slice(0, 32),
  };
}

function responseIds(events, driver) {
  const responses = events.filter(
    (event) =>
      event.type === "response" && event.data.callScope !== "auxiliary",
  );
  assert.ok(
    responses.length > 0,
    "Actual provider response observation missing",
  );
  return responses.map(({ data }) => {
    assert.ok(
      data.callScope === undefined || data.callScope === "session",
      "Provider response has unknown ownership",
    );
    assert.equal(
      data.driver,
      driver,
      "Actual host changed its selected driver",
    );
    assert.ok(
      typeof data.claudeSessionId === "string" &&
        data.claudeSessionId.length > 0,
      "Actual response has no authoritative Claude session ID",
    );
    return data.claudeSessionId;
  });
}

function assertGateHistory(messages, gateStart, nonce) {
  const calls = messages.flatMap((message) =>
    message.role === "assistant"
      ? message.content.filter((block) => block.type === "toolCall")
      : [],
  );
  assert.equal(
    calls.length,
    1,
    "Steering reran the gate or called another tool",
  );
  assert.equal(calls[0].name, "pcc_gate");
  assert.equal(calls[0].id, gateStart.data.toolCallId);
  const results = messages.filter((message) => message.role === "toolResult");
  assert.equal(
    results.length,
    1,
    "Original parked result was lost or duplicated",
  );
  assert.equal(results[0].toolCallId, calls[0].id);
  assert.equal(
    results[0].isError,
    false,
    "Boundary steering cancelled the gate",
  );
  assert.equal(results[0].details._meta.fixture, "native-boundary-gate");
  assert.deepEqual(results[0].details.structuredContent, {
    ...gateStart.data,
    nonce,
  });
  return { toolCallId: calls[0].id, retainedResults: results.length };
}

function userText(message) {
  return typeof message.content === "string"
    ? message.content
    : (message.content ?? [])
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
}

function boundaryThinking(hostKind) {
  if (hostKind === "omp") return "off";
  const model = getBuiltinModels("anthropic").find(
    (model) => model.id === boundaryModel,
  );
  assert.ok(model, "Boundary model must exist in the pinned native Pi catalog");
  return clampThinkingLevel(model, "off");
}

async function select(rpc, hostKind, installedPackage = false) {
  const thinking = boundaryThinking(hostKind);
  const { models } = await rpc.command("get_available_models");
  const registered = models.filter(
    (model) => model.provider === "pi-claude-cli",
  );
  if (installedPackage) {
    assert.ok(
      registered.length > 0,
      "Installed provider is missing from the managed model picker",
    );
    assert.equal(
      new Set(registered.map((model) => model.id)).size,
      registered.length,
      "Installed provider registered duplicate model IDs",
    );
    // The managed OMP picker filters enabledModels; CLI model selection still
    // uses the complete registry. Avoid persisting model/thinking preferences.
    const initial = await rpc.command("get_state");
    assert.equal(initial.model.provider, "pi-claude-cli");
    assert.equal(initial.model.id, boundaryModel);
    assert.equal(initial.thinkingLevel, thinking);
  } else {
    assert.equal(
      models.filter(
        (model) =>
          model.provider === "pi-claude-cli" && model.id === boundaryModel,
      ).length,
      1,
      "Supported model missing or ambiguous in the actual native catalog",
    );
    await rpc.command("set_model", {
      provider: "pi-claude-cli",
      modelId: boundaryModel,
    });
    await rpc.command("set_thinking_level", { level: thinking });
  }
  await rpc.command("set_auto_retry", { enabled: false });
  await rpc.command("set_auto_compaction", { enabled: false });
  const state = await rpc.command("get_state");
  assert.equal(state.model.provider, "pi-claude-cli");
  assert.equal(state.model.id, boundaryModel);
  assert.equal(state.thinkingLevel, thinking);
  assert.equal(state.autoCompactionEnabled, false);
  return state;
}

function boundaryArgs(hostKind, sandbox, system, installedPackage = false) {
  const args = hostArgs(hostKind, sandbox, system);
  const modelIndex = args.indexOf("--model");
  assert.ok(modelIndex >= 0);
  args[modelIndex + 1] =
    hostKind === "omp" ? `pi-claude-cli/${boundaryModel}` : boundaryModel;
  args[args.indexOf("--thinking") + 1] = boundaryThinking(hostKind);
  if (!installedPackage) return args;
  const disabled = args.indexOf("--no-extensions");
  assert.ok(disabled >= 0);
  args.splice(disabled, 1);
  const source = args.indexOf(join(ROOT, `entrypoints/${hostKind}.ts`));
  assert.ok(
    source > 0 && args[source - 1] === "-e",
    "Source provider entrypoint isn't independently selected",
  );
  args.splice(source - 1, 2);
  return args;
}

function restorePiFlags(saved, current) {
  // Restore only flags this test set to false, preserving concurrent changes.
  for (const name of ["retry", "compaction"]) {
    if (current[name]?.enabled !== false) continue;
    if (Object.hasOwn(saved[name] ?? {}, "enabled"))
      current[name].enabled = saved[name].enabled;
    else {
      delete current[name].enabled;
      if (Object.keys(current[name]).length === 0) delete current[name];
    }
  }
  return current;
}

function withEnvironment(values, work) {
  const original = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, values);
  return Promise.resolve()
    .then(work)
    .finally(() => {
      for (const [key, value] of Object.entries(original))
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    });
}

test("boundary fixture waits for its marker and retains the native result", async () => {
  const { gate } = await import("./observer.ts");
  const sandbox = scratchDirectory("g-");
  const path = join(sandbox, "observations.jsonl");
  const release = join(sandbox, "gate-release");
  try {
    await withEnvironment(
      {
        PCC_E2E_NONCE: "synthetic-gate-nonce",
        PCC_E2E_OBSERVATIONS: path,
        PCC_E2E_GATE_RELEASE: release,
        TMPDIR: join(sandbox, "t"),
      },
      async () => {
        let finished = false;
        const pending = gate("synthetic-gate", undefined).then((result) => {
          finished = true;
          return result;
        });
        await new Promise((resolve) => setTimeout(resolve, 75));
        assert.equal(
          finished,
          false,
          "Gate returned before controller release",
        );
        assert.deepEqual(
          observations(path).map((event) => event.type),
          ["gate-start"],
        );
        writeFileSync(release, "release\n", { mode: 0o600 });
        const result = await pending;
        assert.equal(
          result.details.structuredContent.nonce,
          "synthetic-gate-nonce",
        );
        assert.equal(
          result.details.structuredContent.toolCallId,
          "synthetic-gate",
        );
        assert.deepEqual(
          observations(path).map((event) => event.type),
          ["gate-start", "gate-release"],
        );
      },
    );
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("boundary fixture abort rejects without returning or leaking a polling timer", async () => {
  const { gate } = await import("./observer.ts");
  const sandbox = scratchDirectory("g-");
  const path = join(sandbox, "observations.jsonl");
  try {
    await withEnvironment(
      {
        PCC_E2E_NONCE: "synthetic-gate-nonce",
        PCC_E2E_OBSERVATIONS: path,
        PCC_E2E_GATE_RELEASE: join(sandbox, "gate-release"),
        TMPDIR: join(sandbox, "t"),
      },
      async () => {
        const controller = new AbortController();
        const pending = gate("synthetic-abort", controller.signal);
        controller.abort();
        await assert.rejects(pending, /Native E2E gate was aborted/);
        assert.deepEqual(
          observations(path).map((event) => event.type),
          ["gate-start", "gate-abort"],
        );
      },
    );
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("native status observer captures only steering metadata and delegates once", async () => {
  const { observeSteeringStatus } = await import("./observer.ts");
  const sandbox = scratchDirectory("g-");
  const path = join(sandbox, "observations.jsonl");
  try {
    await withEnvironment(
      { PCC_E2E_BOUNDARY: "1", PCC_E2E_OBSERVATIONS: path },
      async () => {
        const forwarded = [];
        const ui = {
          setStatus(key, text) {
            assert.equal(this, ui);
            forwarded.push({ key, text });
          },
        };
        observeSteeringStatus({ ui }, "session_start");
        observeSteeringStatus({ ui }, "context");
        ui.setStatus("unrelated", "never-record");
        ui.setStatus("pi-claude-cli-steering", "never-record");
        ui.setStatus("pi-claude-cli-steering", undefined);
        assert.equal(forwarded.length, 3);
        assert.deepEqual(observations(path), [
          {
            type: "steering-status-observer",
            data: { stage: "session_start" },
          },
          {
            type: "steering-status",
            data: { key: "pi-claude-cli-steering", hasText: true, length: 12 },
          },
          {
            type: "steering-status",
            data: { key: "pi-claude-cli-steering", hasText: false, length: 0 },
          },
        ]);
        assert.equal(
          readFileSync(path, "utf8").includes("never-record"),
          false,
        );
        assert.throws(() => assertNoSteeringWarning(observations(path), "omp"));
      },
    );
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("boundary observations omit arbitrary tool arguments, results and initialization fields", async () => {
  const { record } = await import("./observer.ts");
  const sandbox = scratchDirectory("g-");
  const path = join(sandbox, "observations.jsonl");
  try {
    await withEnvironment(
      { PCC_E2E_BOUNDARY: "1", PCC_E2E_OBSERVATIONS: path },
      async () => {
        record("tool-start", {
          toolCallId: "synthetic-call",
          toolName: "pcc_gate",
          args: { message: "never-record" },
        });
        record("tool-end", {
          toolCallId: "synthetic-call",
          toolName: "pcc_gate",
          isError: false,
          result: { content: [{ type: "text", text: "never-record" }] },
        });
        record("canonical-tool", {
          call: {
            id: "synthetic-call",
            name: "pcc_gate",
            arguments: { message: "never-record" },
          },
          privatePayload: "never-record",
        });
        record("initialized", {
          claudeSessionId: "synthetic-session",
          model: "synthetic-model",
          runtimeVersion: "synthetic-version",
          privatePayload: "never-record",
        });
        assert.deepEqual(observations(path), [
          {
            type: "tool-start",
            data: { toolCallId: "synthetic-call", toolName: "pcc_gate" },
          },
          {
            type: "tool-end",
            data: {
              toolCallId: "synthetic-call",
              toolName: "pcc_gate",
              isError: false,
            },
          },
          {
            type: "canonical-tool",
            data: { call: { id: "synthetic-call", name: "pcc_gate" } },
          },
          {
            type: "initialized",
            data: {
              claudeSessionId: "synthetic-session",
              model: "synthetic-model",
              runtimeVersion: "synthetic-version",
            },
          },
        ]);
        assert.equal(
          readFileSync(path, "utf8").includes("never-record"),
          false,
        );
      },
    );
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("provider steering proof records bounded marker presence without prompt text", async () => {
  const { providerPrompt } = await import("./observer.ts");
  const sandbox = scratchDirectory("g-");
  const path = join(sandbox, "observations.jsonl");
  const marker = "STEER-synthetic";
  const supplemental = `never-record ${marker}`;
  try {
    await withEnvironment(
      {
        PCC_E2E_BOUNDARY: "1",
        PCC_E2E_OBSERVATIONS: path,
        PCC_E2E_STEER_MARKER: marker,
      },
      async () => {
        providerPrompt({
          input: {
            kind: "tool-results",
            steering: [{ type: "text", text: supplemental }],
          },
          auth: { apiKey: "never-record" },
        });
        providerPrompt({
          input: {
            kind: "prompt",
            content: [{ type: "text", text: supplemental }],
          },
        });
        providerPrompt({
          input: {
            kind: "tool-results",
            steering: Array.from({ length: 33 }, () => ({
              type: "text",
              text: "x".repeat(65537),
            })),
          },
        });
        providerPrompt({ input: { kind: { privatePayload: "never-record" } } });
        const proof = observations(path).filter(
          (event) => event.type === "steering-input",
        );
        assert.deepEqual(
          proof.map(({ data }) => data),
          [
            {
              kind: "tool-results",
              markerConfigured: true,
              markerIncluded: true,
              parts: 1,
              length: supplemental.length,
              truncated: false,
            },
            {
              kind: "prompt",
              markerConfigured: true,
              markerIncluded: false,
              parts: 0,
              length: 0,
              truncated: false,
            },
            {
              kind: "tool-results",
              markerConfigured: true,
              markerIncluded: false,
              parts: 32,
              length: 65536,
              truncated: true,
            },
            {
              kind: "unknown",
              markerConfigured: true,
              markerIncluded: false,
              parts: 0,
              length: 0,
              truncated: false,
            },
          ],
        );
        const raw = readFileSync(path, "utf8");
        assert.equal(raw.includes("never-record"), false);
        assert.equal(raw.includes(marker), false);
      },
    );
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("Pi stream and OMP diagnostic admission observations retain only matching queue and consumption metadata", async () => {
  const { nativeDiagnostic, steeringAdmission } = await import("./observer.ts");
  const sandbox = scratchDirectory("g-");
  const path = join(sandbox, "observations.jsonl");
  const event = {
    type: "observation",
    family: "diagnostic",
    subtype: "steering-admission",
    sequence: 1,
    attribution: {},
    data: {
      commandId: "synthetic-command",
      state: "queued",
      text: "never-record",
    },
  };
  try {
    await withEnvironment({ PCC_E2E_OBSERVATIONS: path }, async () => {
      steeringAdmission(event);
      nativeDiagnostic({
        owner: "claude",
        hostSession: {},
        hostAgent: {},
        event: {
          ...event,
          sequence: 2,
          data: { ...event.data, state: "started" },
        },
        privatePayload: "never-record",
      });
      for (const invalid of [
        { ...event, type: "user" },
        { ...event, family: "status" },
        { ...event, sequence: -1 },
        { ...event, data: { ...event.data, state: "completed" } },
        { ...event, data: { ...event.data, commandId: "bad\nidentifier" } },
        { ...event, data: { ...event.data, commandId: "x".repeat(129) } },
      ])
        steeringAdmission(invalid);
      assert.deepEqual(steeringConsumption(observations(path)), {
        queuedCount: 1,
        startedCount: 1,
        commandId: "synthetic-command",
        matchingCommandIds: true,
        queuedBeforeStarted: true,
        events: [
          { commandId: "synthetic-command", state: "queued", sequence: 1 },
          { commandId: "synthetic-command", state: "started", sequence: 2 },
        ],
      });
      const diagnostic = observations(path).find(
        (entry) => entry.type === "native-diagnostic",
      );
      assert.deepEqual(diagnostic.data.event.data, {
        commandId: "synthetic-command",
        state: "started",
      });
      assert.equal(readFileSync(path, "utf8").includes("never-record"), false);
      assert.equal(
        steeringConsumption(observations(path).reverse()).queuedBeforeStarted,
        false,
      );
    });
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("native output proof captures split markers, snapshots and result presence without secret text", async () => {
  const { nativeOutput } = await import("./observer.ts");
  const sandbox = scratchDirectory("g-");
  const path = join(sandbox, "observations.jsonl");
  const marker = "STEER-synthetic";
  try {
    await withEnvironment(
      {
        PCC_E2E_BOUNDARY: "1",
        PCC_E2E_OBSERVATIONS: path,
        PCC_E2E_STEER_MARKER: marker,
      },
      async () => {
        nativeOutput({
          type: "content_start",
          messageId: "synthetic-message",
          sequence: 1,
          index: 0,
          content: { type: "text", text: "never-record STEER-" },
        });
        nativeOutput({
          type: "content_delta",
          messageId: "synthetic-message",
          sequence: 2,
          index: 0,
          delta: { kind: "text", text: "synthetic" },
        });
        nativeOutput({
          type: "content_delta",
          messageId: "different-message",
          sequence: 3,
          index: 0,
          delta: { kind: "text", text: "synthetic" },
        });
        nativeOutput({
          type: "assistant_snapshot",
          messageId: "synthetic-message",
          sequence: 4,
          content: [
            { type: "text", text: `${marker} never-record` },
            { type: "thinking", thinking: "never-record" },
            { type: "tool_call", arguments: { secret: "never-record" } },
          ],
        });
        nativeOutput({
          type: "turn_end",
          sequence: 5,
          resultText: `${marker} never-record`,
          attribution: { messageId: "synthetic-message" },
          error: { message: "never-record" },
        });
        nativeOutput({
          type: "assistant_snapshot",
          messageId: "long-message",
          sequence: 6,
          content: [{ type: "text", text: "x".repeat(65537) }],
        });
        nativeOutput({
          type: "content_delta",
          messageId: "synthetic-message",
          sequence: -1,
          delta: { kind: "text", text: "never-record" },
        });
        nativeOutput({
          type: "observation",
          sequence: 7,
          data: { text: "never-record" },
        });
        const proof = nativeOutputProof(observations(path));
        assert.equal(proof.outputEventCount, 6);
        assert.equal(proof.snapshotCount, 2);
        assert.equal(proof.resultCount, 1);
        assert.equal(proof.nativeSnapshotMarkerIncluded, true);
        assert.equal(proof.nativeResultMarkerIncluded, true);
        assert.equal(proof.nativeStreamMarkerIncluded, true);
        assert.deepEqual(
          proof.events.slice(0, 3).map(({ markerIncluded }) => markerIncluded),
          [false, true, false],
        );
        assert.equal(proof.events.at(-1).length, 65536);
        assert.deepEqual(
          proof.events.find(({ eventType }) => eventType === "turn_end"),
          {
            eventType: "turn_end",
            messageId: "synthetic-message",
            sequence: 5,
            length: `${marker} never-record`.length,
            markerIncluded: true,
          },
        );
        const raw = readFileSync(path, "utf8");
        assert.equal(raw.includes("never-record"), false);
        assert.equal(raw.includes(marker), false);
        assert.equal(raw.includes("secret"), false);
      },
    );
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("installed boundary discovery keeps owned observers and OMP isolation while removing source provider loading", () => {
  for (const kind of ["pi", "omp"]) {
    const source = boundaryArgs(
      kind,
      "/synthetic-owned-sandbox",
      "synthetic-system",
    );
    assert.ok(source.includes("--no-extensions"));
    assert.ok(source.includes(join(ROOT, `entrypoints/${kind}.ts`)));
    assert.equal(
      source[source.indexOf("--model") + 1],
      kind === "omp" ? `pi-claude-cli/${boundaryModel}` : boundaryModel,
    );
    const args = boundaryArgs(
      kind,
      "/synthetic-owned-sandbox",
      "synthetic-system",
      true,
    );
    assert.equal(args.includes("--no-extensions"), false);
    assert.equal(args.includes(join(ROOT, `entrypoints/${kind}.ts`)), false);
    assert.ok(args.includes(join(ROOT, `tests/e2e/${kind}-tools.ts`)));
    assert.equal(
      args[args.indexOf("--model") + 1],
      kind === "omp" ? `pi-claude-cli/${boundaryModel}` : boundaryModel,
    );
    if (kind === "omp")
      assert.equal(
        args[args.indexOf("--config") + 1],
        "/synthetic-owned-sandbox/host-isolation.yml",
      );
  }
});

test("installed boundary mode requires the explicit inference opt-in before package discovery", () => {
  const env = {
    ...process.env,
    PI_CLAUDE_BOUNDARY_E2E: "0",
    PI_CLAUDE_BOUNDARY_INSTALLED: "1",
  };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(
    process.execPath,
    ["--test", join(ROOT, "tests/e2e/boundary-steering.test.mjs")],
    {
      env,
      encoding: "utf8",
      timeout: 10000,
    },
  );
  assert.equal(result.status, 1);
  assert.match(
    result.stdout + result.stderr,
    /PI_CLAUDE_BOUNDARY_INSTALLED=1 requires PI_CLAUDE_BOUNDARY_E2E=1/,
  );
});

test("installed Pi flag restoration preserves other settings and concurrent flag changes", () => {
  const saved = { retry: { enabled: true }, unrelated: "old" };
  const current = {
    retry: { enabled: false, custom: "kept" },
    compaction: { enabled: false },
    unrelated: "concurrent",
  };
  assert.deepEqual(restorePiFlags(saved, current), {
    retry: { enabled: true, custom: "kept" },
    unrelated: "concurrent",
  });
  assert.deepEqual(
    restorePiFlags(saved, {
      retry: { enabled: true },
      compaction: { enabled: true },
    }),
    {
      retry: { enabled: true },
      compaction: { enabled: true },
    },
  );
});

test("system prompt proof ignores auxiliary provider calls but rejects every missing bridge marker", () => {
  const prompt = (stage, included = true) => ({
    type: "system-prompt",
    data: {
      stage,
      available: true,
      markerConfigured: true,
      markerIncluded: included,
    },
  });
  const input = (kind) => ({ type: "steering-input", data: { kind } });
  const main = [
    prompt("before_agent_start"),
    prompt("before_provider_request"),
    input("prompt"),
  ];
  const auxiliary = [
    {
      type: "system-prompt",
      data: {
        stage: "before_provider_request",
        available: false,
        markerConfigured: true,
        markerIncluded: false,
      },
    },
    input("unknown"),
  ];
  assert.deepEqual(assertSystemPrompt([...main, ...auxiliary]), {
    bridgeRequests: 1,
    auxiliaryRequests: 1,
  });
  const scopedAuxiliary = [
    prompt("before_provider_request", false),
    {
      ...input("prompt"),
      data: { ...input("prompt").data, callScope: "auxiliary" },
    },
  ];
  assert.deepEqual(assertSystemPrompt([...main, ...scopedAuxiliary]), {
    bridgeRequests: 1,
    auxiliaryRequests: 1,
  });
  assert.deepEqual(
    responseIds(
      [
        {
          type: "response",
          data: {
            driver: "sdk",
            callScope: "auxiliary",
            claudeSessionId: "other",
          },
        },
        {
          type: "response",
          data: {
            driver: "cli",
            callScope: "session",
            claudeSessionId: "main",
          },
        },
      ],
      "cli",
    ),
    ["main"],
  );
  assert.throws(
    () =>
      responseIds(
        [
          {
            type: "response",
            data: {
              driver: "cli",
              callScope: "unknown",
              claudeSessionId: "main",
            },
          },
        ],
        "cli",
      ),
    /unknown ownership/,
  );
  assert.throws(
    () =>
      assertSystemPrompt([
        ...main,
        prompt("before_provider_request", false),
        input("tool-results"),
        ...auxiliary,
      ]),
    /lost the configured/,
  );
  assert.throws(
    () => assertSystemPrompt([prompt("before_agent_start"), ...auxiliary]),
    /wasn't observed/,
  );
});

test("assistant error evidence classifies all history errors without raw text or provider credentials", () => {
  assert.equal(
    errorClassifier(
      "Concurrent OMP provider rounds for one logical agent aren't supported",
    ),
    "concurrent-session",
  );
  assert.equal(
    errorClassifier(
      "Concurrent Pi provider rounds for one session aren't supported",
    ),
    "concurrent-session",
  );
  const secret = "secret-token-unrelated";
  const messages = [
    {
      role: "assistant",
      provider: "pi-claude-cli",
      model: boundaryModel,
      stopReason: "error",
      errorMessage: `Budget exceeded ${secret}`,
    },
    { role: "user", content: [{ type: "text", text: secret }] },
    {
      role: "assistant",
      provider: secret,
      model: secret,
      stopReason: "error",
      errorMessage: `Authentication failed ${secret}`,
    },
    { role: "assistant", stopReason: "aborted" },
  ];
  assert.deepEqual(assistantDiagnostics(messages, 2), {
    errorCount: 3,
    truncated: false,
    errors: [
      {
        phase: "greeting",
        providerScope: "main",
        stopReason: "error",
        classifier: "budget",
        errorPresent: true,
        errorLength: messages[0].errorMessage.length,
      },
      {
        phase: "boundary",
        providerScope: "other",
        stopReason: "error",
        classifier: "authentication",
        errorPresent: true,
        errorLength: messages[2].errorMessage.length,
      },
      {
        phase: "boundary",
        providerScope: "unattributed",
        stopReason: "aborted",
        classifier: "cancellation",
        errorPresent: false,
        errorLength: 0,
      },
    ],
  });
  assert.equal(
    JSON.stringify(assistantDiagnostics(messages, 2)).includes(secret),
    false,
  );
  assert.equal(
    errorClassifier("Timed out waiting for natural Claude child cleanup"),
    "timeout",
  );
  assert.equal(errorClassifier(`Failure ${secret}`), "unknown");
  assert.equal(
    assistantDiagnostics(Array(40).fill(messages[0])).errors.length,
    32,
  );
  assert.equal(
    assistantDiagnostics(Array(40).fill(messages[0])).truncated,
    true,
  );
});

test("native per-server MCP isolation preserves managed extensions and never starts configured commands", () => {
  const sandbox = scratchDirectory("m-");
  try {
    const agentDir = join(sandbox, "agent");
    mkdirSync(agentDir);
    const poison = join(sandbox, "command-must-not-run");
    writeFileSync(
      join(agentDir, "config.yml"),
      JSON.stringify({
        disabledExtensions: ["extension-module:keep-disabled"],
      }),
    );
    writeFileSync(
      join(agentDir, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          synthetic: {
            command: "touch",
            args: [poison],
            env: { SECRET: "never-persist-this" },
          },
        },
      }),
    );
    configureHostIsolation("omp", sandbox);
    const env = hostEnvironment("omp", "cli", sandbox, "synthetic");
    env.PI_CODING_AGENT_DIR = agentDir;
    const proof = isolateOmpMcp(sandbox, env);
    assert.ok(proof.serverIds.includes("mcp:synthetic"));
    const config = JSON.parse(
      readFileSync(join(sandbox, "host-isolation.yml"), "utf8"),
    );
    assert.deepEqual(config.disabledProviders, ["claude", "claude-plugins"]);
    assert.ok(config.disabledExtensions.includes("mcp:synthetic"));
    assert.ok(
      config.disabledExtensions.includes("extension-module:keep-disabled"),
    );
    assert.equal(
      config.disabledExtensions.includes("extension-module:dist-bundle"),
      false,
    );
    assert.equal(existsSync(poison), false);
    assert.equal(JSON.stringify(proof).includes("never-persist-this"), false);
    const check = spawnSync("bun", ["-e", mcpDiscoveryScript], {
      cwd: ROOT,
      env,
      input: JSON.stringify({
        cwd: sandbox,
        agentDir,
        configFile: join(sandbox, "host-isolation.yml"),
      }),
      encoding: "utf8",
      timeout: 15000,
    });
    assert.equal(check.status, 0);
    assert.deepEqual(JSON.parse(check.stdout).names, []);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("forced helper cleanup accepts only identified startup helpers outside Claude ancestry", () => {
  const processes = [
    { pid: 100, name: "pi", parent: 1, start: "host-start" },
    { pid: 101, name: "node-MainThread", parent: 100, start: "node-start" },
    { pid: 102, name: "esbuild", parent: 101, start: "esbuild-start" },
    { pid: 103, name: "claude", parent: 100, start: "claude-start" },
    { pid: 104, name: "esbuild", parent: 103, start: "claude-helper-start" },
    { pid: 105, name: "unknown", parent: 100, start: "unknown-start" },
    { pid: 106, name: "node-MainThread", parent: 999, start: "orphan-start" },
  ];
  const baseline = new Set(processes.map(({ pid }) => pid));
  const cleanup = { observedProcesses: processes, forcedChildren: [101, 102] };
  const accepted = nativeHelperCleanup(cleanup, baseline, 100, processes);
  assert.equal(accepted.allowedHelperCount, 2);
  assert.equal(accepted.rejectedCount, 0);
  assert.deepEqual(
    accepted.allowedHelpers.map(({ ancestors }) => ancestors),
    [[101], [102, 101]],
  );
  const cases = [
    {
      pid: 102,
      baseline: new Set([100, 101]),
      observed: processes,
      reason: "after-inference-baseline",
    },
    {
      pid: 104,
      baseline,
      observed: processes,
      reason: "claude-transport-ancestry",
    },
    { pid: 103, baseline, observed: processes, reason: "unknown-helper-name" },
    { pid: 105, baseline, observed: processes, reason: "unknown-helper-name" },
    { pid: 106, baseline, observed: processes, reason: "unknown-ancestry" },
    {
      pid: 102,
      baseline,
      observed: processes.filter(({ pid }) => pid !== 102),
      reason: "missing-process-evidence",
    },
    {
      pid: 102,
      baseline,
      observed: processes.map((process) =>
        process.pid === 102 ? { ...process, start: "reused-pid" } : process,
      ),
      reason: "changed-process-identity",
    },
    {
      pid: 102,
      baseline,
      observed: processes.map((process) =>
        process.pid === 102 ? { ...process, parent: 103 } : process,
      ),
      reason: "claude-transport-ancestry",
    },
  ];
  for (const example of cases) {
    const proof = nativeHelperCleanup(
      { observedProcesses: example.observed, forcedChildren: [example.pid] },
      example.baseline,
      100,
      processes,
    );
    assert.equal(proof.allowedHelperCount, 0);
    assert.deepEqual(proof.rejectedChildren, [
      { pid: example.pid, reason: example.reason },
    ]);
  }
  assert.equal(
    nativeHelperCleanup(
      {
        observedProcesses: processes.map((process) =>
          process.pid === 102 ? { ...process, parent: 1 } : process,
        ),
        forcedChildren: [102],
      },
      baseline,
      100,
      processes,
    ).rejectedCount,
    0,
  );
});

test("managed helper signatures reject scripts that merely carry trusted paths as arguments", () => {
  const root = "/synthetic/node_modules",
    broker = join(root, "pi-intercom/broker/broker.ts");
  const cli = join(root, "tsx/dist/cli.mjs"),
    preflight = join(root, "tsx/dist/preflight.cjs");
  const loader = pathToFileURL(join(root, "tsx/dist/loader.mjs")).href;
  const compiler = join(root, "@esbuild/linux-x64/bin/esbuild");
  assert.equal(
    managedPiHelperCommand(
      "node-MainThread",
      "/bin/node",
      ["node", cli, broker],
      root,
    ),
    "pi-intercom",
  );
  assert.equal(
    managedPiHelperCommand(
      "node-MainThread",
      "/bin/node",
      ["node", "--require", preflight, "--import", loader, broker],
      root,
    ),
    "pi-intercom",
  );
  assert.equal(
    managedPiHelperCommand(
      "esbuild",
      compiler,
      [compiler, "--service=0.28.2", "--ping"],
      root,
    ),
    "intercom-compiler",
  );
  for (const argv of [
    ["node", "/other.js", broker, cli],
    ["node", "--eval", cli, broker],
    ["node", cli, "/other.ts"],
    ["node", "--require", preflight, "--import", "file:///other.mjs", broker],
  ])
    assert.equal(
      managedPiHelperCommand("node-MainThread", "/bin/node", argv, root),
      undefined,
    );
  assert.equal(
    managedPiHelperCommand(
      "node-MainThread",
      "/bin/claude",
      ["node", cli, broker],
      root,
    ),
    undefined,
  );
});

test("post-baseline broker allowance requires exact current ancestor identities and a trusted launch chain", () => {
  const initial = [
    { pid: 100, name: "pi", parent: 1, start: "host" },
    {
      pid: 101,
      name: "node-MainThread",
      parent: 100,
      start: "broker",
      helperOwner: "pi-intercom",
    },
    {
      pid: 102,
      name: "esbuild",
      parent: 101,
      start: "compiler",
      helperOwner: "intercom-compiler",
    },
  ];
  const proof = (current) =>
    nativeHelperCleanup(
      { observedProcesses: current, forcedChildren: [102] },
      new Set([100]),
      100,
      initial,
      true,
    );
  assert.equal(proof(initial).allowedHelperCount, 1);
  for (const change of [
    { start: "reused" },
    { helperOwner: undefined },
    { helperOwner: "other" },
    { name: "claude" },
    { parent: 999 },
  ])
    assert.equal(
      proof(initial.map((p) => (p.pid === 101 ? { ...p, ...change } : p)))
        .rejectedCount,
      1,
    );
  assert.equal(
    proof(
      initial.map((p) => (p.pid === 100 ? { ...p, start: "reused-host" } : p)),
    ).rejectedCount,
    1,
  );
  assert.equal(
    proof(initial.map((p) => (p.pid === 101 ? { ...p, parent: 1 } : p)))
      .allowedHelperCount,
    1,
  );
  assert.equal(
    nativeHelperCleanup(
      { observedProcesses: initial, forcedChildren: [102] },
      new Set([100]),
      100,
      initial,
      false,
    ).rejectedCount,
    1,
  );
});

for (const name of CASES) {
  test(
    `actual ${name}: queued boundary steering retains a running native tool and omits false warning`,
    {
      skip: !enabled
        ? "Authenticated boundary E2E disabled; set PI_CLAUDE_BOUNDARY_E2E=1"
        : selected && selected !== name
          ? `Not selected by PI_CLAUDE_BOUNDARY_CASE=${selected}`
          : false,
      timeout: 210000,
    },
    async (context) => {
      const deadline = Date.now() + 180000;
      const [hostKind, driver] = name.split("+");
      const sandbox = scratchDirectory("g-");
      const path = join(sandbox, "observations.jsonl");
      const release = join(sandbox, "gate-release");
      const nonce = `nonce-${randomUUID()}`;
      const marker = `SYSTEM-${randomUUID()}`;
      const supplementalMarker = `STEER-${randomUUID()}`;
      const receipt = {
        schemaVersion: 1,
        provenance: installed
          ? "actual-installed-boundary"
          : "actual-authenticated-boundary-host-rpc",
        case: name,
        model: boundaryModel,
        started: new Date().toISOString(),
        budgets: {
          maxTurns: 8,
          maxOutputTokens: 512,
          maxBudgetUsdPerResidentSession: 0.25,
          caseWallClockMs: 180000,
          gateWaitMs: 12000,
          toolTimeoutMs: 15000,
          shutdownTimeoutMs: 3000,
        },
        billing: "reported USD estimates are not subscription billing",
        phases: {},
      };
      let rpc;
      let failure;
      let savedPiSettings;
      let piSettingsPath;
      let preInferenceProcesses = [];
      let failureStage = "setup";
      let boundaryStart = 0;
      try {
        receipt.socketPathBytes = assertSocketCapacity(sandbox);
        mkdirSync(join(sandbox, "t"));
        configureHostIsolation(hostKind, sandbox);
        const env = hostEnvironment(hostKind, driver, sandbox, nonce);
        if (installed) {
          const agentRoot = realpathSync(
            join(homedir(), `.${hostKind}`, "agent"),
          );
          const installRoot =
            hostKind === "pi"
              ? join(agentRoot, "npm")
              : join(homedir(), ".omp", "plugins");
          const packageRoot = realpathSync(
            join(installRoot, "node_modules/@ramarivera/pi-claude-cli"),
          );
          const pkg = JSON.parse(
            readFileSync(join(packageRoot, "package.json"), "utf8"),
          );
          const expected = JSON.parse(
            readFileSync(join(ROOT, "package.json"), "utf8"),
          );
          receipt.packageVersion = pkg.version;
          receipt.packageRoot = packageRoot;
          receipt.sourcePackageVersion = expected.version;
          receipt.agentRoot = agentRoot;
          assert.equal(pkg.name, "@ramarivera/pi-claude-cli");
          assert.equal(
            pkg.version,
            expected.version,
            "Installed boundary package doesn't match the source release",
          );
          if (hostKind === "pi") {
            piSettingsPath = join(agentRoot, "settings.json");
            savedPiSettings = JSON.parse(readFileSync(piSettingsPath, "utf8"));
            assert.ok(
              savedPiSettings.packages.some(
                (item) =>
                  (typeof item === "string" ? item : item.source) ===
                  `npm:${pkg.name}@${pkg.version}`,
              ),
              "Managed Pi settings must pin the installed release exactly",
            );
            env.PI_OFFLINE = "1";
            env.PI_INTERCOM_SCOPE_ID = `pcc-e2e-${randomUUID()}`;
            receipt.packageResolution = { PI_OFFLINE: "1" };
            receipt.intercomSessionScoped = true;
          } else {
            const manifest = JSON.parse(
              readFileSync(join(installRoot, "package.json"), "utf8"),
            );
            assert.equal(
              manifest.dependencies[pkg.name],
              pkg.version,
              "Managed OMP manifest must pin the installed release exactly",
            );
          }
          env.PI_CODING_AGENT_DIR = agentRoot;
          delete env.PI_CONFIG_DIR;
          receipt.packagePinVerified = true;
        }
        if (hostKind === "omp")
          receipt.externalMcpIsolation = isolateOmpMcp(sandbox, env);
        Object.assign(env, {
          PCC_E2E_BOUNDARY: "1",
          PCC_E2E_GATE_RELEASE: release,
          PCC_E2E_SYSTEM_MARKER: marker,
          PCC_E2E_STEER_MARKER: supplementalMarker,
        });
        receipt.versions = preflight(hostKind, env);
        receipt.git = spawnSync("git", ["rev-parse", "HEAD"], {
          cwd: ROOT,
          encoding: "utf8",
        }).stdout.trim();
        const system = `For this synthetic sandbox E2E, every assistant answer, including a greeting in response to hello, must begin with ${marker}. This prefix is mandatory. Obey the user's exact tool and supplemental instructions. Never inspect files, credentials, account settings, or network resources. Use only pcc_gate when requested.`;
        const args = boundaryArgs(hostKind, sandbox, system, installed);
        // The shared live harness keeps its original tool selection.
        if (hostKind === "omp") args[args.indexOf("--tools") + 1] = "pcc_gate";
        rpc = new RpcHost(receipt.versions.binary, args, env, sandbox, {
          signal: context.signal,
          ...(installed && hostKind === "pi"
            ? { classifyProcess: managedPiHelper, childExitGraceMs: 7000 }
            : {}),
          deadline,
          ...(installed && hostKind === "pi"
            ? { allowNonJsonOutput: managedPiStartupOutput }
            : {}),
        });
        const originalState = await select(rpc, hostKind, installed);
        rpc.rememberBaseline();
        preInferenceProcesses = [...rpc.baseline].flatMap((pid) => {
          const process = rpc.identities.get(pid);
          return process
            ? [
                {
                  pid,
                  name: process.name,
                  parent: process.parent,
                  start: process.start,
                },
              ]
            : [];
        });

        failureStage = "greeting";
        const hello = await rpc.prompt(hostKind, "hello");
        const helloEvents = observations(path);
        assertNoSteeringWarning(helloEvents, hostKind);
        receipt.phases.hello = {
          completed: true,
          steeringWarning: false,
          answerLength: hello.length,
          answerMarkerIncluded: hello.includes(marker),
        };
        receipt.phases.hello.systemPrompt = assertSystemPrompt(helloEvents);
        receipt.phases.hello.systemPromptPreserved = true;
        textProof(hello, marker, marker);
        const helloHistory = await rpc.command("get_messages");
        boundaryStart = helloHistory.messages.length;
        receipt.phases.hello.assistantDiagnostics = assistantDiagnostics(
          helloHistory.messages,
          boundaryStart,
        );
        const originalClaudeId = responseIds(observations(path), driver).at(-1);

        failureStage = "boundary-execution";
        const before = rpc.frames.length;
        const promptId = rpc.send("prompt", {
          message:
            "Call pcc_gate exactly once and wait for its result. Don't call any other tools. Report the exact nonce from that result in your final answer.",
        });
        const started = await rpc.wait(
          () => observations(path).find((event) => event.type === "gate-start"),
          "actual native gate execution",
          60000,
        );
        assert.equal(started.data.calls, 1);
        assert.equal(existsSync(release), false);
        assert.equal((await rpc.command("get_state")).isStreaming, true);
        const supplemental = `Update the final answer: include the exact line ${supplementalMarker} along with the original nonce from pcc_gate. Don't rerun or cancel the tool or call any other tools.`;
        const ack = await rpc.command("steer", { message: supplemental }, 4000);
        const queued = await rpc.command("get_state", {}, 4000);
        assert.equal(
          queued.isStreaming,
          true,
          "Steering ended the original native run",
        );
        if (hostKind === "pi") {
          assert.equal(
            ack.disposition,
            "queued",
            "Pi didn't acknowledge queued steering",
          );
          assert.equal(queued.pendingMessageCount, 1);
        } else {
          assert.equal(queued.queuedMessageCount, 1);
          assert.ok(
            queued.queuedMessages.steering.length === 1 &&
              queued.queuedMessages.steering[0] === supplemental,
            "OMP didn't retain the exact supplemental instruction in its native queue",
          );
        }
        assert.equal(
          existsSync(release),
          false,
          "Gate released before the queue acknowledgement",
        );
        assert.deepEqual(
          observations(path).filter((event) => event.type === "gate-release"),
          [],
        );
        assertNoSteeringWarning(observations(path), hostKind);
        receipt.phases.queued = {
          acknowledgedWhileNativeToolRunning: true,
          queuedInputCount: 1,
          toolCallId: started.data.toolCallId,
          inputLength: supplemental.length,
          steeringWarning: false,
        };

        writeFileSync(release, "release\n", { mode: 0o600 });
        const result = await rpc.settled(hostKind, promptId, before);
        if (hostKind === "omp") assert.equal(result.status, "completed");
        const { text } = await rpc.command("get_last_assistant_text");
        receipt.phases.finalAnswer = {
          available: typeof text === "string",
          length: typeof text === "string" ? text.length : 0,
          systemMarkerIncluded:
            typeof text === "string" && text.includes(marker),
          originalNonceIncluded:
            typeof text === "string" && text.includes(nonce),
          supplementalMarkerIncluded:
            typeof text === "string" && text.includes(supplementalMarker),
        };
        const { messages } = await rpc.command("get_messages");
        receipt.assistantDiagnostics = assistantDiagnostics(
          messages,
          boundaryStart,
        );
        const supplementalHistoryCount = messages.filter(
          (message) =>
            message.role === "user" && userText(message) === supplemental,
        ).length;
        const inputProof = observations(path).filter(
          (event) =>
            event.type === "steering-input" &&
            event.data.kind === "tool-results",
        );
        receipt.phases.providerSteering = {
          toolResultsRequests: inputProof.length,
          markerIncluded:
            inputProof.length > 0 &&
            inputProof.every(
              ({ data }) => data.markerConfigured && data.markerIncluded,
            ),
          inputs: inputProof.map(({ data }) => data),
        };
        receipt.phases.transportSteering = steeringConsumption(
          observations(path),
        );
        if (hostKind === "pi")
          receipt.phases.nativeOutput = nativeOutputProof(observations(path));
        receipt.phases.history = {
          supplementalHistoryCount,
          toolCalls: messages.reduce(
            (count, message) =>
              count +
              (message.role === "assistant"
                ? message.content.filter((block) => block.type === "toolCall")
                    .length
                : 0),
            0,
          ),
          toolResults: messages.filter(
            (message) => message.role === "toolResult",
          ).length,
          assistantErrors: messages.filter(
            (message) =>
              message.role === "assistant" &&
              ["error", "aborted"].includes(message.stopReason),
          ).length,
        };
        // Do not persist prompt text, model text, or arbitrary native RPC frames.
        const gateMessages = messages.filter(
          (message) => message.role !== "system",
        );
        const proof = assertGateHistory(gateMessages, started, nonce);
        assert.equal(
          supplementalHistoryCount,
          1,
          "Native history lost or duplicated the exact supplemental instruction",
        );
        for (const message of messages.filter(
          (message) => message.role === "assistant",
        ))
          assert.ok(
            !["error", "aborted"].includes(message.stopReason),
            "Native history contains cancellation or an error",
          );
        const finalState = await rpc.command("get_state");
        assert.equal(finalState.sessionId, originalState.sessionId);
        assert.equal(finalState.model.provider, originalState.model.provider);
        assert.equal(finalState.model.id, originalState.model.id);
        assert.equal(
          hostKind === "pi"
            ? finalState.pendingMessageCount
            : finalState.queuedMessageCount,
          0,
        );
        assert.ok(
          responseIds(observations(path), driver).every(
            (id) => id === originalClaudeId,
          ),
          "Boundary steering restarted the authoritative Claude session",
        );
        const events = observations(path);
        receipt.phases.systemPrompt = assertSystemPrompt(events);
        assertNoSteeringWarning(events, hostKind);
        assert.equal(
          events.filter((event) => event.type === "gate-start").length,
          1,
        );
        assert.equal(
          events.filter((event) => event.type === "gate-release").length,
          1,
        );
        assert.equal(
          events.filter((event) =>
            ["gate-abort", "gate-timeout"].includes(event.type),
          ).length,
          0,
        );
        const ends = events.filter(
          (event) =>
            event.type === "tool-end" &&
            event.data.toolCallId === started.data.toolCallId,
        );
        assert.equal(ends.length, 1);
        assert.equal(ends[0].data.isError, false);
        receipt.phases.boundary = {
          ...proof,
          gateCalls: 1,
          supplementalHonored:
            receipt.phases.finalAnswer.supplementalMarkerIncluded,
          originalNonceRetained:
            receipt.phases.finalAnswer.originalNonceIncluded,
          supplementalHistoryCount,
          hostSessionId: finalState.sessionId,
          claudeSessionId: originalClaudeId,
          driver,
          steeringWarning: false,
        };
        assert.ok(
          inputProof.length > 0,
          "Actual tool-results provider request wasn't observed",
        );
        assert.ok(
          inputProof.every(
            ({ data }) =>
              data.markerConfigured &&
              data.markerIncluded &&
              data.parts > 0 &&
              !data.truncated,
          ),
          "Actual tool-results provider request lost the exact supplemental marker",
        );
        assert.equal(
          receipt.phases.transportSteering.queuedCount,
          1,
          "Native transport didn't acknowledge steering admission exactly once",
        );
        assert.equal(
          receipt.phases.transportSteering.startedCount,
          1,
          "Native transport didn't consume the admitted steering exactly once",
        );
        assert.equal(
          receipt.phases.transportSteering.matchingCommandIds,
          true,
          "Native transport consumed a different command than the admitted steering",
        );
        assert.equal(
          receipt.phases.transportSteering.queuedBeforeStarted,
          true,
          "Native transport consumption didn't follow admission",
        );
        textProof(text, marker, nonce);
        textProof(text, marker, supplementalMarker);
        receipt.stats = publicStats(await rpc.command("get_session_stats"));
        failureStage = "transport-cleanup";
        await rpc.command("new_session");
        receipt.phases.transportCleanup = await rpc.transportIdle(
          join(sandbox, "t"),
          installed && hostKind === "pi"
            ? {
                allowOwnedHelper: (pid) =>
                  nativeHelperCleanup(
                    {
                      observedProcesses: [...rpc.identities.values()],
                      forcedChildren: [pid],
                    },
                    rpc.baseline,
                    rpc.child.pid,
                    [...rpc.initialIdentities.values()],
                    true,
                  ).rejectedCount === 0,
              }
            : {},
        );
        receipt.status = "passed";
      } catch (error) {
        failure = error;
        receipt.status = "failed";
        // Assertion diagnostics may contain synthetic prompts; store only the name.
        receipt.failure = {
          name: error.name,
          stage: failureStage,
          classifier: errorClassifier(error.message),
        };
        if (rpc && !receipt.assistantDiagnostics)
          receipt.assistantDiagnostics = assistantDiagnostics(
            rpc.frames
              .filter((frame) => frame.type === "message_end")
              .map((frame) => frame.message)
              .filter(Boolean),
            failureStage === "greeting"
              ? Number.MAX_SAFE_INTEGER
              : boundaryStart,
          );
        if (rpc)
          receipt.promptDiagnostics = rpc.responses
            .slice(-8)
            .map((response) => ({
              stopReason: [
                "stop",
                "length",
                "toolUse",
                "error",
                "aborted",
              ].includes(response.assistant?.stopReason)
                ? response.assistant.stopReason
                : "unknown",
              classifier: errorClassifier(
                response.assistant?.errorMessage,
                response.assistant?.stopReason,
              ),
              errorPresent:
                typeof response.assistant?.errorMessage === "string" &&
                response.assistant.errorMessage.length > 0,
            }));
      } finally {
        try {
          if (rpc) {
            receipt.eventTypes = rpc.frames.map((frame) => frame.type);
            receipt.commands = rpc.commands.map(({ id, type }) => ({
              id,
              type,
            }));
            receipt.cleanup = await rpc.close();
            if (installed && hostKind === "pi")
              receipt.startupOutputCounts = rpc.startupOutputCounts;
            assert.deepEqual(receipt.cleanup.survivors, []);
            receipt.nativeHelperCleanup = nativeHelperCleanup(
              receipt.cleanup,
              rpc.baseline ?? new Set(),
              rpc.child.pid,
              installed && hostKind === "pi"
                ? [...rpc.initialIdentities.values()]
                : preInferenceProcesses,
              installed && hostKind === "pi",
            );
            assert.equal(
              receipt.nativeHelperCleanup.rejectedCount,
              0,
              "Claude transport or unverified child required forced harness cleanup",
            );
            assert.equal(receipt.cleanup.hostRequiredKill, false);
          }
          receipt.privateTransportFiles = existsSync(join(sandbox, "t"))
            ? readdirSync(join(sandbox, "t")).filter((file) =>
                file.startsWith("pcc-cli-"),
              )
            : [];
          assert.deepEqual(receipt.privateTransportFiles, []);
        } catch (error) {
          failure ??= error;
          receipt.status = "failed";
          receipt.cleanupFailure = { name: error.name };
        }
        if (savedPiSettings && rpc) {
          try {
            const current = JSON.parse(readFileSync(piSettingsPath, "utf8"));
            const beforeRestore = JSON.stringify(current);
            const restored = restorePiFlags(savedPiSettings, current);
            if (JSON.stringify(restored) !== beforeRestore)
              writeFileSync(
                piSettingsPath,
                JSON.stringify(restored, null, 2) + "\n",
              );
            receipt.piTestSettingsCleanup =
              "owned retry/compaction flags restored";
          } catch (error) {
            failure ??= error;
            receipt.status = "failed";
            receipt.piTestSettingsCleanup = "failed";
          }
        }
        receipt.finished = new Date().toISOString();
        receipt.phases.transportSteering = steeringConsumption(
          observations(path),
        );
        if (hostKind === "pi")
          receipt.phases.nativeOutput = nativeOutputProof(observations(path));
        receipt.observations = observations(path).filter((event) =>
          [
            "response",
            "system-prompt",
            "steering-input",
            "steering-admission",
            "native-output",
            "gate-start",
            "gate-release",
            "gate-abort",
            "gate-timeout",
            "steering-status-observer",
            "steering-status",
          ].includes(event.type),
        );
        let receiptPath;
        try {
          receiptPath = join(
            receiptDirectory(),
            `${installed ? "installed-boundary" : "boundary"}-${name.replace("+", "-")}-${Date.now()}.json`,
          );
          writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n", {
            mode: 0o600,
          });
        } finally {
          rmSync(sandbox, { recursive: true, force: true });
        }
        console.log(
          `${name} boundary ${receipt.status}; sanitized receipt: ${receiptPath}`,
        );
      }
      if (failure) throw failure;
    },
  );
}
