import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CASES,
  MODEL,
  RpcHost,
  executable,
  hostArgs,
  hostEnvironment,
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
      const sandbox = mkdtempSync(join(tmpdir(), "pcc-host-loading-"));
      let rpc;
      try {
        mkdirSync(join(sandbox, "temp"));
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
      } finally {
        try {
          if (rpc) {
            const cleanup = await rpc.close();
            assert.deepEqual(cleanup.forcedChildren, []);
          }
        } finally {
          rmSync(sandbox, { recursive: true, force: true });
        }
      }
    },
  );
}
