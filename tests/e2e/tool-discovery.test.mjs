import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CASES,
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

const enabled = process.env.PI_CLAUDE_TOOL_DISCOVERY_E2E === "1";
const installed = process.env.PI_CLAUDE_TOOL_DISCOVERY_INSTALLED === "1";
const selected = process.env.PI_CLAUDE_TOOL_DISCOVERY_CASE;
assert.ok(!selected || CASES.includes(selected), "Invalid tool discovery case");

for (const name of CASES)
  test(
    `${name}: native default prompt discovers read, edit and write without shell fallback`,
    {
      skip: !enabled || (Boolean(selected) && selected !== name),
      timeout: 180000,
    },
    async (context) => {
      const [kind, driver] = name.split("+");
      const packageRoot = installed
        ? join(
            homedir(),
            kind === "pi" ? ".pi/agent/npm" : ".omp/plugins",
            "node_modules/@ramarivera/pi-claude-cli",
          )
        : ROOT;
      const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json")));
      const sourcePkg = JSON.parse(readFileSync(join(ROOT, "package.json")));
      assert.equal(pkg.name, sourcePkg.name);
      assert.equal(pkg.version, sourcePkg.version);
      const fingerprint = productionFingerprint(packageRoot);
      assert.equal(fingerprint, productionFingerprint(ROOT));
      const sandbox = scratchDirectory("d-");
      mkdirSync(join(sandbox, "t"), { mode: 0o700 });
      configureHostIsolation(kind, sandbox);
      writeFileSync(join(sandbox, "fixture.txt"), "before\n");
      const created = `created-${randomUUID()}`;
      const env = hostEnvironment(kind, driver, sandbox, created);
      env.PCC_E2E_BOUNDARY = "1";
      const versions = preflight(kind, env);
      const args = hostArgs(kind, sandbox, "unused");
      // Use the real native system prompt and its editing instructions. Earlier
      // tests replaced it and supplied hashline syntax in the user's request.
      args.splice(args.indexOf("--system-prompt"), 2);
      if (installed)
        args[args.indexOf(join(ROOT, `entrypoints/${kind}.ts`))] = join(
          packageRoot,
          `entrypoints/${kind}.ts`,
        );
      const host = new RpcHost(versions.binary, args, env, sandbox, {
        signal: context.signal,
        deadline: Date.now() + 175000,
      });
      const receipt = {
        provenance: installed
          ? "installed-entrypoint-native-default-prompt"
          : "source-native-default-prompt",
        case: name,
        version: pkg.version,
        packageRoot,
        productionSha256: fingerprint,
        versions,
        started: new Date().toISOString(),
      };
      let failure;
      try {
        await host.command("set_auto_retry", { enabled: false });
        await host.command("set_auto_compaction", { enabled: false });
        host.rememberBaseline();
        await host.prompt(
          kind,
          `Read fixture.txt using the native read tool. Replace its first line with replacement using the native edit tool. Create created.txt containing exactly ${created} and a trailing newline using the native write tool. Use each of those tools once. Don't use bash or any other tool. Reply DONE when both files are correct.`,
        );
        const { messages } = await host.command("get_messages");
        const assistant = messages.filter((m) => m.role === "assistant");
        assert.ok(assistant.length > 0);
        for (const message of assistant)
          assert.ok(
            !["error", "aborted"].includes(message.stopReason),
            message.errorMessage ?? "Native assistant failed",
          );
        assert.equal(
          readFileSync(join(sandbox, "fixture.txt"), "utf8"),
          "replacement\n",
        );
        assert.equal(
          readFileSync(join(sandbox, "created.txt"), "utf8"),
          `${created}\n`,
        );
        const events = readFileSync(env.PCC_E2E_OBSERVATIONS, "utf8")
          .trim()
          .split("\n")
          .map(JSON.parse);
        const calls = events.filter((e) => e.type === "tool-start");
        assert.deepEqual(calls.map((e) => e.data.toolName).sort(), [
          "edit",
          "read",
          "write",
        ]);
        for (const call of calls) {
          const ends = events.filter(
            (e) =>
              e.type === "tool-end" &&
              e.data.toolCallId === call.data.toolCallId,
          );
          assert.equal(ends.length, 1);
          assert.equal(ends[0].data.isError, false);
        }
        const texts = assistant
          .flatMap((m) =>
            m.content.filter((b) => b.type === "text").map((b) => b.text),
          )
          .join("\n");
        assert.doesNotMatch(
          texts,
          /(?:no\s+[`'"]?(?:edit|write)[`'"]?\s+tool|(?:edit|write)[`'"]?\s+(?:isn't|is not|unavailable)|wrong tool names)/i,
        );
        const ids = events.filter((e) => e.type === "response");
        assert.ok(ids.length > 0);
        assert.ok(
          ids.every((e) => e.data.driver === driver && e.data.claudeSessionId),
        );
        assert.equal(new Set(ids.map((e) => e.data.claudeSessionId)).size, 1);
        assert.equal(
          events.filter(
            (e) =>
              ["runtime-status", "steering-status"].includes(e.type) &&
              e.data.hasText,
          ).length,
          0,
        );
        receipt.result = {
          nativeCalls: calls.map((e) => e.data.toolName),
          successfulResults: 3,
          editedBytes: "replacement\n",
          createdBytes: `${created}\n`,
          shellFallbackCalls: 0,
          unavailableToolClaims: 0,
          resident: true,
        };
        await host.command("new_session");
        receipt.transportCleanup = await host.transportIdle(join(sandbox, "t"));
        receipt.status = "passed";
      } catch (error) {
        failure = error;
        receipt.status = "failed";
        receipt.error = { name: error.name, message: error.message };
      } finally {
        receipt.cleanup = await host.close();
        receipt.responses = host.responses;
        receipt.finished = new Date().toISOString();
        if (
          receipt.cleanup.hostRequiredKill ||
          receipt.cleanup.forcedChildren.length ||
          receipt.cleanup.survivors.length
        ) {
          receipt.status = "failed";
          failure ??= new Error(
            "Native discovery test required forced cleanup",
          );
        }
        const path = join(
          receiptDirectory(),
          `${installed ? "installed" : "source"}-discovery-${kind}-${driver}-${Date.now()}.json`,
        );
        writeFileSync(path, JSON.stringify(receipt, null, 2) + "\n", {
          mode: 0o600,
        });
        console.log(`Tool discovery receipt: ${path}`);
      }
      if (failure) throw failure;
    },
  );
