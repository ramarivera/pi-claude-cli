import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  CASES,
  MODEL,
  RpcHost,
  assertSocketCapacity,
  configureHostIsolation,
  executable,
  hostArgs,
  hostEnvironment,
  receiptDirectory,
  scratchDirectory,
} from "./rpc.mjs";

for (const name of CASES) {
  test(
    `no-inference actual ${name} extension and catalog loading`,
    {
      skip:
        process.env.PCC_E2E_HOST_LOADING !== "1"
          ? "Set PCC_E2E_HOST_LOADING=1 for actual host loading without inference"
          : false,
      timeout: 45000,
    },
    async () => {
      const [host, driver] = name.split("+");
      const sandbox = scratchDirectory("l-");
      const receipt = {
        schemaVersion: 1,
        provenance: "actual-host-rpc-no-inference",
        case: name,
        started: new Date().toISOString(),
      };
      let rpc;
      let failure;
      try {
        assertSocketCapacity(sandbox);
        mkdirSync(join(sandbox, "t"));
        configureHostIsolation(host, sandbox);
        const env = hostEnvironment(
          host,
          driver,
          sandbox,
          "loading-no-inference",
        );
        const binary = executable(
          host === "pi"
            ? (process.env.PI_E2E_BIN ?? "pi")
            : (process.env.OMP_E2E_BIN ??
                "/home/ramarivera/.local/share/mise/installs/github-can1357-oh-my-pi/latest/omp"),
        );
        rpc = new RpcHost(
          binary,
          hostArgs(host, sandbox, "Loading-only system marker"),
          env,
          sandbox,
        );
        const { models } = await rpc.command("get_available_models");
        assert.equal(
          models.filter(
            (model) => model.provider === "pi-claude-cli" && model.id === MODEL,
          ).length,
          1,
        );
        await rpc.command("set_model", {
          provider: "pi-claude-cli",
          modelId: MODEL,
        });
        await rpc.command("set_thinking_level", { level: "off" });
        await rpc.command("set_auto_retry", { enabled: false });
        await rpc.command("set_auto_compaction", { enabled: false });
        const state = await rpc.command("get_state");
        receipt.selection = {
          provider: state.model.provider,
          model: state.model.id,
          thinking: state.thinkingLevel,
        };
        assert.equal(state.model.provider, "pi-claude-cli");
        assert.equal(state.model.id, MODEL);
        assert.equal(state.thinkingLevel, "off");
        if (host === "omp") {
          assert.ok(
            state.dumpTools.some((tool) => tool.name === "pcc_sentinel"),
          );
          assert.ok(state.dumpTools.some((tool) => tool.name === "pcc_slow"));
          const edit = state.dumpTools.find((tool) => tool.name === "edit");
          assert.ok(edit);
          assert.deepEqual(Object.keys(edit.parameters.properties), ["input"]);
          assert.ok(edit.description.includes("Hashline"));
        }
        assert.equal(
          rpc.commands.filter((command) => command.type === "prompt").length,
          0,
        );
        receipt.status = "passed";
      } catch (error) {
        failure = error;
        receipt.status = "failed";
        receipt.failure = { name: error.name, message: error.message };
      } finally {
        try {
          if (rpc) {
            const cleanup = await rpc.close();
            receipt.cleanup = cleanup;
            assert.deepEqual(cleanup.forcedChildren, []);
            assert.equal(cleanup.hostRequiredKill, false);
          }
        } catch (error) {
          failure ??= error;
          receipt.status = "failed";
          receipt.cleanupFailure = { name: error.name, message: error.message };
        } finally {
          receipt.commands = rpc?.commands;
          receipt.finished = new Date().toISOString();
          try {
            const path = join(
              receiptDirectory(),
              `loading-${name.replace("+", "-")}-${Date.now()}.json`,
            );
            writeFileSync(path, JSON.stringify(receipt, null, 2) + "\n", {
              mode: 0o600,
            });
            console.log(
              `${name} no-inference ${receipt.status}; receipt: ${path}`,
            );
          } finally {
            rmSync(sandbox, { recursive: true, force: true });
          }
        }
      }
      if (failure) throw failure;
    },
  );
}
