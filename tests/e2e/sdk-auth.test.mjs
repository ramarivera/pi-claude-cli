import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  ROOT,
  RpcHost,
  configureHostIsolation,
  hostArgs,
  hostEnvironment,
  preflight,
  productionFingerprint,
  receiptDirectory,
  scratchDirectory,
} from "./rpc.mjs";

// Paid, explicit diagnostic. Both request shapes must succeed; an upstream
// rejection remains a failed test, never an expected-error pass or fallback.
const enabled = process.env.PI_CLAUDE_SDK_AUTH_E2E === "1";
const kind = process.env.PI_CLAUDE_SDK_AUTH_HOST ?? "pi";
assert.ok(["pi", "omp"].includes(kind), "Invalid SDK auth host");

for (const promptShape of ["custom", "native"])
  test(
    `${kind}+sdk: official login accepts the ${promptShape} host prompt`,
    { skip: !enabled, timeout: 100000 },
    async (context) => {
      const sandbox = scratchDirectory("a-");
      mkdirSync(join(sandbox, "t"), { mode: 0o700 });
      configureHostIsolation(kind, sandbox);
      const env = hostEnvironment(kind, "sdk", sandbox, "AUTH_DIFFERENTIAL");
      assert.equal(env.PI_CLAUDE_AUTH, "claude-login");
      env.PCC_E2E_BOUNDARY = "1";
      const versions = preflight(kind, env);
      const args = hostArgs(kind, sandbox, "Use native host tools when asked.");
      if (promptShape === "native")
        args.splice(args.indexOf("--system-prompt"), 2);
      const host = new RpcHost(versions.binary, args, env, sandbox, {
        signal: context.signal,
        deadline: Date.now() + 95000,
      });
      const receipt = {
        provenance: "source-official-sdk-login-prompt-differential",
        host: kind,
        driver: "sdk",
        promptShape,
        productionSha256: productionFingerprint(ROOT),
        versions,
        args,
        started: new Date().toISOString(),
      };
      let failure;
      try {
        await host.command("set_auto_retry", { enabled: false });
        await host.command("set_auto_compaction", { enabled: false });
        host.rememberBaseline();
        await host.prompt(
          kind,
          "Do not use tools. Reply exactly AUTH_PROBE_OK.",
        );
        const { messages } = await host.command("get_messages");
        const last = messages.filter((m) => m.role === "assistant").at(-1);
        assert.equal(last?.stopReason, "stop", last?.errorMessage);
        assert.equal(host.responses.at(-1)?.text.trim(), "AUTH_PROBE_OK");
        assert.equal(messages.filter((m) => m.role === "toolResult").length, 0);
        receipt.status = "passed";
      } catch (error) {
        failure = error;
        receipt.status = "failed";
        receipt.error = { name: error.name, message: error.message };
      } finally {
        try {
          // Test cleanup independently of inference success, including rejected
          // requests. No managed helper exclusions apply in this isolated host.
          await host.command("new_session");
          receipt.transportCleanup = await host.transportIdle(
            join(sandbox, "t"),
          );
        } catch (error) {
          failure ??= error;
          receipt.status = "failed";
          receipt.cleanupError = { name: error.name, message: error.message };
        }
        receipt.cleanup = await host.close();
        if (
          receipt.cleanup.hostRequiredKill ||
          receipt.cleanup.forcedChildren.length ||
          receipt.cleanup.survivors.length
        ) {
          failure ??= new Error("SDK auth probe required forced cleanup");
          receipt.status = "failed";
        }
        receipt.responses = host.responses;
        receipt.finished = new Date().toISOString();
        const path = join(
          receiptDirectory(),
          `sdk-auth-${kind}-${promptShape}-${Date.now()}.json`,
        );
        writeFileSync(path, JSON.stringify(receipt, null, 2), { mode: 0o600 });
        console.log(`SDK auth receipt: ${path}`);
      }
      if (failure) throw failure;
    },
  );
