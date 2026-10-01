import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  MODEL,
  ROOT,
  RpcHost,
  configureHostIsolation,
  hostArgs,
  hostEnvironment,
  managedPiStartupOutput,
  preflight,
  productionFingerprint,
  receiptDirectory,
  scratchDirectory,
} from "./rpc.mjs";

// Installation and source pre-release checks use distinct, explicit provenance.
const sourceSmoke = process.env.PI_CLAUDE_SOURCE_SMOKE_E2E === "1";
assert.ok(
  !(sourceSmoke && process.env.PI_CLAUDE_INSTALLED_E2E === "1"),
  "Select source or installed smoke explicitly, not both",
);
const smokeHost = process.env.PI_CLAUDE_SMOKE_HOST;
assert.ok(
  !smokeHost || ["pi", "omp"].includes(smokeHost),
  "Invalid smoke host selection",
);
for (const kind of ["pi", "omp"])
  test(
    `${kind}: ${sourceSmoke ? "source" : "installed managed"} Claude package executes real native tools and OMP background completion`,
    {
      skip:
        (!sourceSmoke && process.env.PI_CLAUDE_INSTALLED_E2E !== "1") ||
        (Boolean(smokeHost) && smokeHost !== kind),
      timeout: 180000,
    },
    async (context) => {
      const driver = process.env.PI_CLAUDE_DRIVER ?? "cli";
      assert.ok(["cli", "sdk"].includes(driver));
      const agentRoot = join(homedir(), `.${kind}`, "agent");
      const installRoot =
        kind === "pi"
          ? join(agentRoot, "npm")
          : join(homedir(), ".omp", "plugins");
      const packageRoot = sourceSmoke
        ? ROOT
        : join(installRoot, "node_modules/@ramarivera/pi-claude-cli");
      const pkg = JSON.parse(
        readFileSync(join(packageRoot, "package.json"), "utf8"),
      );
      const expected = JSON.parse(
        readFileSync(join(ROOT, "package.json"), "utf8"),
      );
      assert.equal(pkg.name, "@ramarivera/pi-claude-cli");
      assert.equal(pkg.version, expected.version);
      const sourceFingerprint = productionFingerprint(packageRoot);
      assert.equal(
        sourceFingerprint,
        productionFingerprint(ROOT),
        "Smoke package differs from reviewed production source",
      );
      let savedPiSettings;
      const piSettingsPath = join(agentRoot, "settings.json");
      if (!sourceSmoke && kind === "pi") {
        const settings = JSON.parse(readFileSync(piSettingsPath, "utf8"));
        savedPiSettings = settings;
        assert.ok(
          settings.packages.some(
            (item) =>
              (typeof item === "string" ? item : item.source) ===
              `npm:${pkg.name}@${pkg.version}`,
          ),
          "Managed Pi settings must pin the installed release",
        );
      } else if (!sourceSmoke) {
        const manifest = JSON.parse(
          readFileSync(join(installRoot, "package.json"), "utf8"),
        );
        assert.equal(manifest.dependencies[pkg.name], pkg.version);
      }
      const sandbox = scratchDirectory("i-");
      mkdirSync(join(sandbox, "t"), { mode: 0o700 });
      const fixture = `release-${randomUUID()}`;
      writeFileSync(join(sandbox, "release-fixture.txt"), fixture + "\n");
      configureHostIsolation(kind, sandbox);
      const nonce = `nonce-${randomUUID()}`;
      const env = hostEnvironment(kind, driver, sandbox, nonce);
      if (!sourceSmoke) {
        env.PI_CODING_AGENT_DIR = agentRoot;
        delete env.PI_CONFIG_DIR;
      }
      // Pi's offline package resolver still discovers installed packages and
      // leaves model inference online; avoid updating unrelated home packages.
      if (kind === "pi") env.PI_OFFLINE = "1";
      env.PCC_E2E_SYSTEM_MARKER = "RELEASE_SMOKE";
      // Observe native status calls: RPC normally hides the footer that exposed
      // the user's thinking_tokens regression in the interactive host.
      env.PCC_E2E_BOUNDARY = "1";
      const versions = preflight(kind, env);
      const args = hostArgs(kind, sandbox, "Use native host tools when asked.");
      if (!sourceSmoke) {
        args.splice(args.indexOf("--no-extensions"), 1);
        const sourceIndex = args.indexOf(join(ROOT, `entrypoints/${kind}.ts`));
        assert.ok(sourceIndex > 0);
        args.splice(sourceIndex - 1, 2);
      }
      // Tool observers are additional instrumentation; provider loads only
      // through the deployed host config and installed package manifest.
      const host = new RpcHost(versions.binary, args, env, sandbox, {
        signal: context.signal,
        deadline: Date.now() + 175000,
        ...(kind === "pi"
          ? { allowNonJsonOutput: managedPiStartupOutput }
          : {}),
      });
      const receipt = {
        provenance: sourceSmoke
          ? "actual-source-package-rpc"
          : "actual-managed-installed-package-rpc",
        host: kind,
        driver,
        version: pkg.version,
        packageRoot,
        sourceFingerprint,
        model: MODEL,
        versions,
        args,
        ...(kind === "pi" ? { packageResolution: { PI_OFFLINE: "1" } } : {}),
        started: new Date().toISOString(),
      };
      try {
        const { models } = await host.command("get_available_models");
        const registered = models.filter(
          (model) => model.provider === "pi-claude-cli",
        );
        assert.ok(
          registered.length > 0,
          "Installed provider must appear in the managed model picker",
        );
        assert.equal(
          new Set(registered.map((model) => model.id)).size,
          registered.length,
          "Installed provider must register unique model IDs",
        );
        // OMP's RPC picker filters enabledModels; the CLI can select Haiku
        // from the complete registry even when the managed picker excludes it.
        const selected = (await host.command("get_state")).model;
        assert.equal(selected.provider, "pi-claude-cli");
        assert.equal(selected.id, MODEL);
        receipt.registeredClaudeModels = registered.map((model) => model.id);
        await host.command("set_auto_retry", { enabled: false });
        await host.command("set_auto_compaction", { enabled: false });
        host.rememberBaseline();
        await host.prompt(
          kind,
          "Use the native read tool to read release-fixture.txt. Then call pcc_sentinel exactly once. Report the exact file contents and the exact nonce from that tool. Don't use any other tools.",
        );
        const { text } = await host.command("get_last_assistant_text");
        assert.ok(
          text.includes(fixture),
          "Actual native read contents missing",
        );
        assert.ok(text.includes(nonce), "Actual native tool nonce missing");
        const events = readFileSync(env.PCC_E2E_OBSERVATIONS, "utf8")
          .trim()
          .split("\n")
          .map(JSON.parse);
        if (kind === "omp") {
          assert.ok(
            events.some((event) => event.type === "steering-status-observer"),
            "Native status observer wasn't installed",
          );
          const footerRows = events.filter(
            (event) =>
              ["runtime-status", "steering-status"].includes(event.type) &&
              event.data.hasText,
          );
          assert.equal(
            footerRows.length,
            0,
            "Installed Claude runtime wrote status logs below the prompt bar",
          );
          receipt.runtimeStatusRows = footerRows.length;
        }
        const nativeCalls = events
          .filter((event) => event.type === "tool-start")
          .map((event) => event.data.toolName);
        assert.equal(nativeCalls.filter((name) => name === "read").length, 1);
        assert.deepEqual(
          nativeCalls.filter(
            (name) => !["read", "pcc_sentinel"].includes(name),
          ),
          [],
          "Smoke must execute only the requested native tools",
        );
        const calls = events.filter(
          (event) =>
            event.type === "tool-start" &&
            event.data.toolName === "pcc_sentinel",
        );
        assert.equal(calls.length, 1, "Sentinel must execute exactly once");
        const responses = events.filter(
          (event) =>
            event.type === "response" && event.data.driver !== undefined,
        );
        assert.ok(responses.length > 0);
        assert.ok(
          responses.every(
            (event) =>
              event.data.driver === driver && event.data.claudeSessionId,
          ),
          "Actual selected Claude transport and session identity missing",
        );
        receipt.result = { text, sentinelCalls: calls.length, nativeCalls };
        if (kind === "omp") {
          const sessionIds = new Set(
            responses.map((event) => event.data.claudeSessionId),
          );
          assert.equal(sessionIds.size, 1);
          const backgroundMarker = `BACKGROUND_${randomUUID().replaceAll("-", "")}`;
          const command = `while [ ! -f background-release.signal ]; do sleep 0.1; done; printf '%s\\n' '${backgroundMarker}'`;
          const since = host.frames.length;
          const backgroundPromptId = host.send("prompt", {
            message: `Use the native bash tool exactly once with async:true, timeout:30 and command ${JSON.stringify(command)}. Don't poll or call any other tools. Briefly acknowledge starting the job. When its completion is delivered, report the exact output marker from that notification.`,
          });
          await host.wait(
            () =>
              host.frames
                .slice(since)
                .find(
                  (frame) =>
                    frame.type === "message_end" &&
                    frame.message?.role === "assistant" &&
                    frame.message.stopReason === "stop",
                ),
            "foreground answer before background completion",
            90000,
          );
          writeFileSync(
            join(sandbox, "background-release.signal"),
            "release\n",
            { mode: 0o600 },
          );
          await host.settled(kind, backgroundPromptId, since);
          const messages = (await host.command("get_messages")).messages;
          const notifications = messages.filter(
            (message) =>
              message.role === "custom" &&
              message.customType === "async-result",
          );
          assert.equal(
            notifications.length,
            1,
            "Native background job must deliver one real async-result notification",
          );
          const { text: backgroundText } = await host.command(
            "get_last_assistant_text",
          );
          assert.ok(
            backgroundText.includes(backgroundMarker),
            "Native background completion wasn't answered",
          );
          const afterBackground = readFileSync(env.PCC_E2E_OBSERVATIONS, "utf8")
            .trim()
            .split("\n")
            .map(JSON.parse);
          assert.equal(
            afterBackground.filter(
              (event) =>
                event.type === "tool-start" && event.data.toolName === "bash",
            ).length,
            1,
          );
          assert.equal(
            afterBackground.filter(
              (event) =>
                event.type === "tool-start" &&
                !["read", "pcc_sentinel", "bash"].includes(event.data.toolName),
            ).length,
            0,
          );
          assert.ok(
            afterBackground
              .filter(
                (event) =>
                  event.type === "response" && event.data.driver === driver,
              )
              .every((event) => sessionIds.has(event.data.claudeSessionId)),
            "Background completion rebuilt the resident Claude query",
          );
          assert.equal(
            host.frames
              .slice(since)
              .filter(
                (frame) =>
                  frame.type === "message_end" &&
                  frame.message?.role === "assistant" &&
                  frame.message.stopReason === "error",
              ).length,
            0,
            "Background completion produced a native assistant error",
          );
          const recalled = await host.prompt(
            kind,
            "No tools. Repeat only the background job's exact output marker from the last notification.",
          );
          assert.ok(
            recalled.includes(backgroundMarker),
            "Follow-up lost native background notification history",
          );
          const finalEvents = readFileSync(env.PCC_E2E_OBSERVATIONS, "utf8")
            .trim()
            .split("\n")
            .map(JSON.parse);
          assert.equal(
            finalEvents.filter(
              (event) =>
                ["runtime-status", "steering-status"].includes(event.type) &&
                event.data.hasText,
            ).length,
            0,
          );
          assert.ok(
            finalEvents
              .filter(
                (event) =>
                  event.type === "response" && event.data.driver === driver,
              )
              .every((event) => sessionIds.has(event.data.claudeSessionId)),
            "Follow-up rebuilt the resident Claude query",
          );
          receipt.backgroundCompletion = {
            nativeNotifications: notifications.length,
            nativeBashCalls: 1,
            answered: true,
            remembered: true,
            resident: true,
            runtimeStatusRows: 0,
          };
        }
        await host.command("new_session");
        receipt.transportCleanup = await host.transportIdle(join(sandbox, "t"));
        receipt.status = "passed";
      } catch (error) {
        receipt.status = "failed";
        receipt.error = { name: error.name, message: error.message };
        throw error;
      } finally {
        receipt.responses = host.responses;
        receipt.cleanup = await host.close();
        receipt.startupOutputCounts = host.startupOutputCounts;
        if (savedPiSettings) {
          const current = JSON.parse(readFileSync(piSettingsPath, "utf8"));
          // Restore only flags this smoke set to false; preserve other live
          // settings and any concurrent change to these flags.
          for (const name of ["retry", "compaction"]) {
            if (current[name]?.enabled !== false) continue;
            if (Object.hasOwn(savedPiSettings[name] ?? {}, "enabled"))
              current[name].enabled = savedPiSettings[name].enabled;
            else {
              delete current[name].enabled;
              if (Object.keys(current[name]).length === 0) delete current[name];
            }
          }
          writeFileSync(
            piSettingsPath,
            JSON.stringify(current, null, 2) + "\n",
          );
          receipt.piTestSettingsCleanup = "owned flags restored";
        }
        receipt.finished = new Date().toISOString();
        const path = join(
          receiptDirectory(),
          `${sourceSmoke ? "source-smoke" : "installed"}-${kind}-${driver}-${Date.now()}.json`,
        );
        writeFileSync(path, JSON.stringify(receipt, null, 2) + "\n", {
          mode: 0o600,
        });
        console.log(
          `${sourceSmoke ? "Source" : "Installed"}-package receipt: ${path}`,
        );
      }
    },
  );
