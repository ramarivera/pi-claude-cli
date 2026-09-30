import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { textProof } from "./diagnostics.mjs";
import {
  CASES,
  MODEL,
  ROOT,
  RpcHost,
  assertSocketCapacity,
  hostArgs,
  hostEnvironment,
  preflight,
  receiptDirectory,
  scratchDirectory,
} from "./rpc.mjs";

if (process.env.PI_CLAUDE_LIVE_E2E === "1" && process.env.PI_CLAUDE_LIVE_CASE)
  assert.ok(
    CASES.includes(process.env.PI_CLAUDE_LIVE_CASE),
    "Invalid PI_CLAUDE_LIVE_CASE selection",
  );

export function observations(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export async function select(host, kind) {
  const { models } = await host.command("get_available_models");
  const exact = models.filter(
    (model) => model.provider === "pi-claude-cli" && model.id === MODEL,
  );
  assert.equal(
    exact.length,
    1,
    `${kind}: supported model missing or ambiguous in the actual host catalog`,
  );
  await host.command("set_model", {
    provider: exact[0].provider,
    modelId: exact[0].id,
  });
  await host.command("set_thinking_level", { level: "off" });
  await host.command("set_auto_retry", { enabled: false });
  await host.command("set_auto_compaction", { enabled: false });
  const state = await host.command("get_state");
  assert.equal(state.model.provider, "pi-claude-cli");
  assert.equal(state.model.id, MODEL);
  assert.equal(
    state.thinkingLevel,
    "off",
    "Haiku must not request unsupported effort",
  );
  assert.equal(state.autoCompactionEnabled, false);
  return {
    provider: state.model.provider,
    model: state.model.id,
    thinking: state.thinkingLevel,
    autoCompaction: false,
    autoRetry: false,
    cacheWarming: "observer-stop",
  };
}

function responseIds(events, driver) {
  const responses = events.filter((item) => item.type === "response");
  assert.ok(
    responses.length > 0,
    "Actual provider response observation missing",
  );
  for (const { data } of responses) {
    assert.equal(data.driver, driver, "Host changed selected driver");
    assert.ok(
      typeof data.claudeSessionId === "string" &&
        data.claudeSessionId.length > 0,
      "Missing authoritative Claude session ID",
    );
  }
  return responses.map((item) => item.data.claudeSessionId);
}

function checkCorrelation(messages, sentinelCall, driver, hostKind, events) {
  const calls = messages.flatMap((message) =>
    message.role === "assistant"
      ? message.content.filter(
          (block) => block.type === "toolCall" && block.name === "pcc_sentinel",
        )
      : [],
  );
  assert.equal(
    calls.length,
    1,
    "Native assistant must propose the sentinel exactly once",
  );
  assert.equal(
    calls[0].id,
    sentinelCall.toolCallId,
    "Native execute ID differs from canonical proposal",
  );
  const results = messages.filter(
    (message) =>
      message.role === "toolResult" && message.toolCallId === calls[0].id,
  );
  assert.equal(
    results.length,
    1,
    "Canonical parked call must receive exactly one matching native result",
  );
  assert.equal(results[0].isError, false);
  assert.deepEqual(results[0].details.structuredContent, sentinelCall);
  assert.equal(results[0].details._meta.fixture, "native-live-sentinel");
  if (hostKind === "pi") {
    const canonical = events.filter(
      (item) =>
        item.type === "canonical-tool" &&
        item.data.call.name === "pcc_sentinel",
    );
    assert.equal(
      canonical.length,
      1,
      `${driver} canonical host request was not observed exactly once`,
    );
    assert.equal(canonical[0].data.call.id, calls[0].id);
  }
}

async function abortInference(rpc, hostKind) {
  const since = rpc.frames.length;
  const id = rpc.send("prompt", {
    message:
      "Do not use tools. Write 1000 numbered lines, each with 20 distinct words. Start immediately and keep going.",
  });
  await rpc.wait(
    () =>
      rpc.frames
        .slice(since)
        .find(
          (frame) =>
            frame.type === "message_update" &&
            frame.assistantMessageEvent?.type === "text_delta",
        ),
    "actual inference text delta",
    60000,
  );
  const active = await rpc.command("get_state");
  assert.equal(
    active.isStreaming,
    true,
    "Inference ended before the abort could be exercised",
  );
  await rpc.command("abort");
  const result = await rpc.settled(hostKind, id, since);
  if (hostKind === "omp") assert.equal(result.status, "aborted");
  const { messages } = await rpc.command("get_messages");
  const last = messages
    .filter((message) => message.role === "assistant")
    .at(-1);
  assert.equal(
    last.stopReason,
    "aborted",
    "Inference abort wasn't visible in native history",
  );
  return { stopReason: last.stopReason, observedStreaming: true };
}

async function abortTool(rpc, hostKind, path) {
  const count = observations(path).length;
  const since = rpc.frames.length;
  const id = rpc.send("prompt", {
    message:
      "Call pcc_slow exactly once now. Do not call any other tool; wait for its result.",
  });
  const started = await rpc.wait(
    () =>
      observations(path)
        .slice(count)
        .find((event) => event.type === "slow-start"),
    "native slow tool execute",
    60000,
  );
  await rpc.command("abort");
  await rpc.settled(hostKind, id, since);
  const aborted = await rpc.wait(
    () =>
      observations(path)
        .slice(count)
        .find((event) => event.type === "slow-abort"),
    "native tool AbortSignal",
  );
  assert.equal(aborted.data.toolCallId, started.data.toolCallId);
  assert.equal(
    observations(path).filter((event) => event.type === "slow-effect").length,
    0,
    "Cancelled tool performed its delayed effect",
  );
  return {
    toolCallId: started.data.toolCallId,
    signalObserved: true,
    effects: 0,
  };
}

for (const name of CASES) {
  const enabled = process.env.PI_CLAUDE_LIVE_E2E === "1";
  const selected = process.env.PI_CLAUDE_LIVE_CASE;
  test(
    `actual ${name}: text, native tools, resident session, restoration, aborts and cleanup`,
    {
      skip: !enabled
        ? "Authenticated E2E disabled; set PI_CLAUDE_LIVE_E2E=1"
        : selected && selected !== name
          ? `Not selected by PI_CLAUDE_LIVE_CASE=${selected}`
          : false,
      timeout: 210000,
    },
    async (context) => {
      const deadline = Date.now() + 180000;
      assert.ok(
        !selected || CASES.includes(selected),
        "Invalid PI_CLAUDE_LIVE_CASE selection",
      );
      const [hostKind, driver] = name.split("+");
      const sandbox = scratchDirectory("e-");
      const receipt = {
        schemaVersion: 1,
        provenance: "actual-authenticated-host-rpc",
        case: name,
        started: new Date().toISOString(),
        prompts: [],
        rpcSessions: [],
        cleanup: [],
        phases: {},
        billing:
          "not measured; reported USD estimates are not subscription billing",
      };
      const observationPath = join(sandbox, "observations.jsonl");
      let rpc;
      let failure;
      try {
        receipt.socketPathBytes = assertSocketCapacity(sandbox);
        mkdirSync(join(sandbox, "t"));
        writeFileSync(join(sandbox, "fixture.txt"), "before\n");
        const nonce = `nonce-${randomUUID()}`;
        const marker = `SYSTEM-${randomUUID()}`;
        const system = `For this synthetic sandbox E2E, begin every final answer with ${marker}. Obey the user's exact tool instructions. Never inspect other files, credentials, account settings, or network resources. Use only the offered host tools.`;
        const env = hostEnvironment(hostKind, driver, sandbox, nonce);
        env.PCC_E2E_SYSTEM_MARKER = marker;
        receipt.versions = preflight(hostKind, env);
        receipt.budgets = {
          maxTurns: 8,
          maxOutputTokens: 512,
          maxBudgetUsdPerQuery: 0.25,
          caseWallClockMs: 180000,
          toolTimeoutMs: 15000,
          shutdownTimeoutMs: 3000,
        };
        receipt.git = spawnSync("git", ["rev-parse", "HEAD"], {
          cwd: ROOT,
          encoding: "utf8",
        }).stdout.trim();
        const args = hostArgs(hostKind, sandbox, system);
        receipt.launch = {
          executable: receipt.versions.binary,
          args,
          cwd: sandbox,
          extraExtension: `tests/e2e/${hostKind}-tools.ts`,
        };
        rpc = new RpcHost(receipt.versions.binary, args, env, sandbox, {
          signal: context.signal,
          deadline,
        });
        receipt.selection = await select(rpc, name);
        rpc.rememberBaseline();
        const first =
          "No tools. Follow the system-required prefix, then reply with READY.";
        receipt.prompts.push(first);
        textProof(await rpc.prompt(hostKind, first), marker, "READY");
        const originalId = responseIds(
          observations(observationPath),
          driver,
        ).at(-1);
        const toolPrompt =
          hostKind === "omp"
            ? "Read fixture.txt with the native read tool. Use its current 4-hex snapshot tag to call the native edit tool with its documented hashline {input: patch} syntax, replacing line 1 with replacement. Do not use write or bash. Then call pcc_sentinel exactly once. Finish by reporting its exact nonce; don't call it again."
            : "Call pcc_sentinel exactly once. Finish by reporting its exact nonce; don't call any other tool.";
        receipt.prompts.push(toolPrompt);
        textProof(await rpc.prompt(hostKind, toolPrompt), marker, nonce);
        let events = observations(observationPath);
        const calls = events.filter((event) => event.type === "sentinel");
        assert.equal(
          calls.length,
          1,
          "Sentinel execute count isn't exactly one",
        );
        assert.equal(calls[0].data.calls, 1);
        const { messages } = await rpc.command("get_messages");
        checkCorrelation(messages, calls[0].data, driver, hostKind, events);
        receipt.phases.tool = {
          callId: calls[0].data.toolCallId,
          counter: 1,
          structuredContent: calls[0].data,
          canonicalResultMatched: true,
        };
        if (hostKind === "omp") {
          const edits = events.filter(
            (event) =>
              event.type === "tool-start" && event.data.toolName === "edit",
          );
          const reads = events.filter(
            (event) =>
              event.type === "tool-end" && event.data.toolName === "read",
          );
          assert.equal(
            edits.length,
            1,
            "Expected exactly one native hashline edit",
          );
          assert.deepEqual(Object.keys(edits[0].data.args), ["input"]);
          const patch = edits[0].data.args.input;
          assert.match(
            patch,
            /^\*\*\* Begin Patch\n\[(?:[^\]\n]*\/)?fixture\.txt#[a-fA-F0-9]{4}\]\nPUT 1\.=1:\n\+replacement\n\*\*\* End Patch\n?$/,
          );
          const tag = patch.match(/#([a-fA-F0-9]{4})\]/)[1];
          assert.ok(
            reads.some((event) =>
              JSON.stringify(event.data.result.content).includes(tag),
            ),
            "Edit tag wasn't taken from actual native read result",
          );
          assert.equal(
            readFileSync(join(sandbox, "fixture.txt"), "utf8"),
            "replacement\n",
          );
          receipt.phases.hashline = {
            args: edits[0].data.args,
            readTag: tag,
            fileBytes: "replacement\n",
          };
        }
        const resident =
          "No tools. Repeat the nonce returned by pcc_sentinel earlier in this conversation.";
        receipt.prompts.push(resident);
        textProof(await rpc.prompt(hostKind, resident), marker, nonce);
        events = observations(observationPath);
        assert.ok(
          responseIds(events, driver).every((id) => id === originalId),
          "Resident continuation changed authoritative Claude ID",
        );
        assert.equal(
          events.filter((event) => event.type === "sentinel").length,
          1,
        );
        receipt.phases.resident = {
          claudeSessionId: originalId,
          rememberedNonce: nonce,
        };
        const saved = await rpc.command("get_state");
        assert.ok(
          saved.sessionFile && existsSync(saved.sessionFile),
          "Native host session wasn't saved",
        );
        receipt.statsBeforeRestore = await rpc.command("get_session_stats");
        receipt.rpcSessions.push({
          phase: "resident",
          commands: rpc.commands,
          eventTypes: rpc.frames.map((frame) => frame.type),
          responses: rpc.responses,
          assistantMessages: rpc.assistantMessages(),
        });
        const closed = await rpc.close();
        receipt.cleanup.push(closed);
        assert.deepEqual(
          closed.forcedChildren,
          [],
          "Host shutdown leaked Claude children requiring harness fallback",
        );
        assert.equal(
          closed.hostRequiredKill,
          false,
          "Host required emergency SIGKILL instead of graceful shutdown",
        );
        rpc = undefined;
        const restoredAt = observations(observationPath).length;
        rpc = new RpcHost(receipt.versions.binary, args, env, sandbox, {
          signal: context.signal,
          deadline,
        });
        await select(rpc, name);
        rpc.rememberBaseline();
        const switched = await rpc.command("switch_session", {
          sessionPath: saved.sessionFile,
        });
        assert.equal(
          switched.cancelled,
          false,
          "Native host restoration was cancelled",
        );
        await rpc.command("set_thinking_level", { level: "off" });
        const restoredPrompt =
          "No tools. After restoring this saved conversation, repeat the nonce that pcc_sentinel returned earlier.";
        receipt.prompts.push(restoredPrompt);
        textProof(await rpc.prompt(hostKind, restoredPrompt), marker, nonce);
        const restoredId = responseIds(
          observations(observationPath).slice(restoredAt),
          driver,
        ).at(-1);
        assert.notEqual(
          restoredId,
          originalId,
          "New host process didn't establish a fresh replay session",
        );
        receipt.phases.restoration = {
          mode: "fresh-runtime-history-replay",
          originalClaudeId: originalId,
          restoredClaudeId: restoredId,
          rememberedNonce: nonce,
        };
        receipt.phases.inferenceAbort = await abortInference(rpc, hostKind);
        receipt.phases.inferenceAbort.cleanup = await rpc.transportIdle(
          join(sandbox, "t"),
        );
        receipt.phases.toolAbort = await abortTool(
          rpc,
          hostKind,
          observationPath,
        );
        receipt.phases.toolAbort.cleanup = await rpc.transportIdle(
          join(sandbox, "t"),
        );
        const proof =
          "No tools. Follow the system-required prefix, then reply with AFTER_ABORT.";
        receipt.prompts.push(proof);
        textProof(await rpc.prompt(hostKind, proof), marker, "AFTER_ABORT");
        receipt.phases.afterAbort = { completed: true };
        receipt.stats = await rpc.command("get_session_stats");
        await rpc.command("new_session");
        receipt.phases.finalCleanup = await rpc.transportIdle(
          join(sandbox, "t"),
        );
        assert.equal(
          observations(observationPath).filter(
            (event) => event.type === "sentinel",
          ).length,
          1,
          "Restoration or later prompts repeated the sentinel",
        );
        assert.equal(
          observations(observationPath).filter(
            (event) => event.type === "slow-start",
          ).length,
          1,
          "Slow tool must execute exactly once",
        );
        receipt.observations = observations(observationPath);
        receipt.status = "passed";
      } catch (error) {
        failure = error;
        receipt.status = "failed";
        receipt.failure = { name: error.name, message: error.message };
        receipt.lastResponse = rpc?.responses.at(-1);
        receipt.stats ??= receipt.lastResponse?.stats;
      } finally {
        try {
          if (rpc) {
            receipt.rpcSessions.push({
              phase: receipt.phases.restoration ? "restored" : "interrupted",
              commands: rpc.commands,
              eventTypes: rpc.frames.map((frame) => frame.type),
              responses: rpc.responses,
              assistantMessages: rpc.assistantMessages(),
            });
            const closed = await rpc.close();
            receipt.cleanup.push(closed);
            assert.deepEqual(
              closed.forcedChildren,
              [],
              "Claude children required harness fallback cleanup",
            );
            assert.equal(
              closed.hostRequiredKill,
              false,
              "Host required emergency SIGKILL instead of graceful shutdown",
            );
          }
          const privateFiles = existsSync(join(sandbox, "t"))
            ? readdirSync(join(sandbox, "t")).filter((file) =>
                file.startsWith("pcc-cli-"),
              )
            : [];
          assert.deepEqual(
            privateFiles,
            [],
            "CLI private transport directories leaked",
          );
          assert.equal(
            observations(observationPath).filter(
              (event) => event.type === "slow-effect",
            ).length,
            0,
          );
          receipt.privateTransportFiles = privateFiles;
        } catch (error) {
          failure ??= error;
          receipt.status = "failed";
          receipt.cleanupFailure = error.message;
        }
        receipt.finished = new Date().toISOString();
        receipt.prompts = receipt.rpcSessions.flatMap((session) =>
          session.commands
            .filter((command) => command.type === "prompt")
            .map((command) => command.message),
        );
        receipt.observations = observations(observationPath);
        let path;
        try {
          const directory = receiptDirectory();
          path = join(
            directory,
            `${name.replace("+", "-")}-${Date.now()}.json`,
          );
          writeFileSync(path, JSON.stringify(receipt, null, 2) + "\n", {
            mode: 0o600,
          });
        } finally {
          rmSync(sandbox, { recursive: true, force: true });
        }
        console.log(`${name} ${receipt.status}; sanitized receipt: ${path}`);
      }
      if (failure) throw failure;
    },
  );
}
