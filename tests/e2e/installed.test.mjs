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
  preflight,
  receiptDirectory,
  scratchDirectory,
} from "./rpc.mjs";

// This opt-in smoke uses the actual managed config and package discovery.
// Never substitute a source entrypoint or a mocked inference transport.
for (const kind of ["pi", "omp"])
  test(
    `${kind}: installed managed Claude package executes a real native tool`,
    { skip: process.env.PI_CLAUDE_INSTALLED_E2E !== "1", timeout: 180000 },
    async (context) => {
      const driver = process.env.PI_CLAUDE_DRIVER ?? "cli";
      assert.ok(["cli", "sdk"].includes(driver));
      const agentRoot = join(homedir(), `.${kind}`, "agent");
      const installRoot =
        kind === "pi"
          ? join(agentRoot, "npm")
          : join(homedir(), ".omp", "plugins");
      const packageRoot = join(
        installRoot,
        "node_modules/@ramarivera/pi-claude-cli",
      );
      const pkg = JSON.parse(
        readFileSync(join(packageRoot, "package.json"), "utf8"),
      );
      const expected = JSON.parse(
        readFileSync(join(ROOT, "package.json"), "utf8"),
      );
      assert.equal(pkg.name, "@ramarivera/pi-claude-cli");
      assert.equal(pkg.version, expected.version);
      if (kind === "pi") {
        const settings = JSON.parse(
          readFileSync(join(agentRoot, "settings.json"), "utf8"),
        );
        assert.ok(
          settings.packages.some(
            (item) =>
              (typeof item === "string" ? item : item.source) ===
              `npm:${pkg.name}@${pkg.version}`,
          ),
          "Managed Pi settings must pin the installed release",
        );
      } else {
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
      env.PI_CODING_AGENT_DIR = agentRoot;
      delete env.PI_CONFIG_DIR;
      env.PCC_E2E_SYSTEM_MARKER = "RELEASE_SMOKE";
      const versions = preflight(kind, env);
      const args = hostArgs(kind, sandbox, "Use native host tools when asked.");
      args.splice(args.indexOf("--no-extensions"), 1);
      const sourceIndex = args.indexOf(join(ROOT, `entrypoints/${kind}.ts`));
      assert.ok(sourceIndex > 0);
      args.splice(sourceIndex - 1, 2);
      // Tool observers are additional instrumentation; provider loads only
      // through the deployed host config and installed package manifest.
      const host = new RpcHost(versions.binary, args, env, sandbox, {
        signal: context.signal,
        deadline: Date.now() + 175000,
      });
      const receipt = {
        provenance: "actual-managed-installed-package-rpc",
        host: kind,
        driver,
        version: pkg.version,
        packageRoot,
        model: MODEL,
        versions,
        args,
        started: new Date().toISOString(),
      };
      try {
        const { models } = await host.command("get_available_models");
        assert.equal(
          models.filter(
            (model) => model.provider === "pi-claude-cli" && model.id === MODEL,
          ).length,
          1,
          "Installed package must register its model exactly once",
        );
        await host.command("set_model", {
          provider: "pi-claude-cli",
          modelId: MODEL,
        });
        await host.command("set_thinking_level", { level: "off" });
        await host.command("set_auto_retry", { enabled: false });
        await host.command("set_auto_compaction", { enabled: false });
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
        const calls = events.filter(
          (event) =>
            event.type === "tool-start" &&
            event.data.toolName === "pcc_sentinel",
        );
        assert.equal(calls.length, 1, "Sentinel must execute exactly once");
        const responses = events.filter((event) => event.type === "response");
        assert.ok(responses.length > 0);
        assert.ok(
          responses.every(
            (event) =>
              event.data.driver === driver && event.data.claudeSessionId,
          ),
          "Actual selected Claude transport and session identity missing",
        );
        receipt.result = { text, sentinelCalls: calls.length };
        await host.command("new_session");
        receipt.transportCleanup = await host.transportIdle(join(sandbox, "t"));
        receipt.status = "passed";
      } catch (error) {
        receipt.status = "failed";
        receipt.error = { name: error.name, message: error.message };
        throw error;
      } finally {
        receipt.cleanup = await host.close();
        receipt.finished = new Date().toISOString();
        const path = join(
          receiptDirectory(),
          `installed-${kind}-${driver}-${Date.now()}.json`,
        );
        writeFileSync(path, JSON.stringify(receipt, null, 2) + "\n", {
          mode: 0o600,
        });
        console.log(`Installed-package receipt: ${path}`);
      }
    },
  );
