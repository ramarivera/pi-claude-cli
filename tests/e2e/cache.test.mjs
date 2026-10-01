import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
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

const enabled = process.env.PI_CLAUDE_CACHE_E2E === "1";
const installed = process.env.PI_CLAUDE_CACHE_INSTALLED === "1";
const selected = process.env.PI_CLAUDE_CACHE_CASE;
assert.ok(!selected || CASES.includes(selected), "Invalid cache case");

for (const name of CASES)
  test(
    `${name}: native cache survives warm turns and a tool-hook argument revision`,
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
      assert.equal(
        pkg.version,
        JSON.parse(readFileSync(join(ROOT, "package.json"))).version,
      );
      const fingerprint = productionFingerprint(packageRoot);
      assert.equal(fingerprint, productionFingerprint(ROOT));
      const sandbox = scratchDirectory("c-");
      mkdirSync(join(sandbox, "t"), { mode: 0o700 });
      configureHostIsolation(kind, sandbox);
      const marker = `CACHE_${randomUUID().replaceAll("-", "")}`;
      const env = hostEnvironment(kind, driver, sandbox, marker);
      env.PCC_E2E_BOUNDARY = "1";
      const originalCommand = `echo ORIGINAL_${marker}`;
      const revisedMarker = `REWRITTEN_${marker}`;
      env.PCC_E2E_REWRITE_FROM = originalCommand;
      env.PCC_E2E_REWRITE_TO = `echo ${revisedMarker}`;
      const versions = preflight(kind, env);
      const args = hostArgs(kind, sandbox, "unused");
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
      // Distinct synthetic hex records put the prefix above Haiku's 4096-token
      // cache minimum without depending on native prompt length or tool count.
      const seed = Array.from(
        { length: 768 },
        (_, i) =>
          `${i}:${createHash("sha256").update(`${marker}:${i}`).digest("hex")}`,
      ).join("\n");
      const receipt = {
        provenance: installed
          ? "installed-entrypoint-cache-measurement"
          : "source-cache-measurement",
        case: name,
        version: pkg.version,
        packageRoot,
        productionSha256: fingerprint,
        versions,
        seedSha256: createHash("sha256").update(seed).digest("hex"),
        seedBytes: Buffer.byteLength(seed),
        started: new Date().toISOString(),
      };
      let failure;
      try {
        await host.command("set_auto_retry", { enabled: false });
        await host.command("set_auto_compaction", { enabled: false });
        host.rememberBaseline();
        const measurements = [];
        for (const [phase, prompt] of [
          [
            "cold",
            `No tools. Retain this synthetic reference block and its marker ${marker}. Reply READY without echoing the block.\n${seed}`,
          ],
          [
            "warm",
            "No tools. Reply with only the exact CACHE_ marker from my first message.",
          ],
          [
            "native-hook",
            `Call the native bash tool exactly once with the command ${JSON.stringify(originalCommand)}. Don't call any other tool. Report its actual output and the exact CACHE_ marker from my first message.`,
          ],
          [
            "warm-after-hook",
            "No tools. Repeat that exact CACHE_ marker once more.",
          ],
        ]) {
          const text = await host.prompt(kind, prompt);
          if (measurements.length) assert.ok(text.includes(marker));
          if (phase === "native-hook") assert.ok(text.includes(revisedMarker));
          const { messages } = await host.command("get_messages");
          const last = messages.filter((m) => m.role === "assistant").at(-1);
          assert.equal(
            last.stopReason,
            "stop",
            last.errorMessage ?? "Native cache turn failed",
          );
          const usage = last.usage;
          assert.ok(
            usage &&
              [usage.input, usage.cacheRead, usage.cacheWrite].every(
                (v) => Number.isFinite(v) && v >= 0,
              ),
          );
          measurements.push({
            phase,
            input: usage.input,
            cacheRead: usage.cacheRead,
            cacheWrite: usage.cacheWrite,
            output: usage.output,
          });
        }
        assert.ok(
          [measurements[1], measurements[3]].every(
            (m) => m.cacheRead >= 4096 && m.cacheWrite < m.cacheRead / 4,
          ),
          "Warm native follow-ups didn't reuse the large prefix with a small write suffix",
        );
        assert.ok(
          measurements[3].cacheRead >= measurements[1].cacheRead,
          "The warm cached prefix shrank after native tool-hook execution",
        );
        const events = readFileSync(env.PCC_E2E_OBSERVATIONS, "utf8")
          .trim()
          .split("\n")
          .map(JSON.parse);
        const calls = events.filter((e) => e.type === "tool-start");
        const results = events.filter((e) => e.type === "tool-end");
        const rewrites = events.filter((e) => e.type === "native-hook-rewrite");
        assert.equal(calls.length, 1);
        assert.equal(calls[0].data.toolName, "bash");
        assert.equal(results.length, 1);
        assert.equal(results[0].data.toolCallId, calls[0].data.toolCallId);
        assert.equal(results[0].data.isError, false);
        assert.equal(rewrites.length, 1);
        assert.equal(rewrites[0].data.toolCallId, calls[0].data.toolCallId);
        const responses = events.filter((e) => e.type === "response");
        assert.ok(responses.length >= 5);
        assert.ok(
          responses.every(
            (e) => e.data.driver === driver && e.data.claudeSessionId,
          ),
        );
        assert.equal(
          new Set(responses.map((e) => e.data.claudeSessionId)).size,
          1,
          "Unchanged native turns rebuilt the Claude session",
        );
        receipt.result = {
          measurements,
          warmTurnsWithCacheReads: 2,
          resident: true,
          nativeToolCalls: 1,
          nativeHookArgumentRevisions: 1,
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
          failure ??= new Error("Cache test required forced cleanup");
        }
        const path = join(
          receiptDirectory(),
          `${installed ? "installed" : "source"}-cache-${kind}-${driver}-${Date.now()}.json`,
        );
        writeFileSync(path, JSON.stringify(receipt, null, 2) + "\n", {
          mode: 0o600,
        });
        console.log(`Cache receipt: ${path}`);
      }
      if (failure) throw failure;
    },
  );
