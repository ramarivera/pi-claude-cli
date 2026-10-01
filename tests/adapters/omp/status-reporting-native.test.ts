import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const compiledBunExecutable = process.env.PCC_COMPILED_BUN_EXECUTABLE;

/** Native footer and file logger, driven by the production observation path. */
it.skipIf(!compiledBunExecutable)(
  "keeps routine Claude metadata out of OMP's native footer and preserves file logs and error reporting (offline)",
  async () => {
    const scratch = join(
      homedir(),
      "dev/agentic-scratchpads/pi-claude-cli/main",
      `status-reporting-${process.pid}-${Date.now()}`,
    );
    await mkdir(scratch, { recursive: true });
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const packageRoot = await realpath(
      process.env.PCC_OMP_STATUS_PACKAGE_ROOT ?? root,
    );
    const expectedPackage = JSON.parse(
      await readFile(join(root, "package.json"), "utf8"),
    );
    const probe = join(scratch, "status-reporting-probe.ts");
    await writeFile(
      probe,
      String.raw`
import { EventEmitter } from "node:events";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
const [root, logDir, packageRoot] = process.argv.slice(2);
const expectedPackage = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const testedPackage = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
if (testedPackage.name !== expectedPackage.name || testedPackage.version !== expectedPackage.version)
  throw new Error("Native status probe requires " + expectedPackage.name + "@" + expectedPackage.version + "; selected " + testedPackage.name + "@" + testedPackage.version);
const lifecyclePath = join(packageRoot, "src/adapters/omp/lifecycle.ts");
const { FooterComponent } = await import(join(root, "node_modules/@oh-my-pi/pi-tui/src/status-line/footer.ts"));
const logger = await import(join(root, "node_modules/@oh-my-pi/pi-utils/src/logger.ts"));
const { OmpLifecycle } = await import(lifecyclePath);
logger.setTransports({ file: logDir, console: false });
const { initTheme } = await import(join(root, "node_modules/@oh-my-pi/pi-tui/src/theme/index.ts"));
await initTheme(false);
const footer = new FooterComponent({
  state: {}, isAutoThinking: false,
  autoResolvedThinkingLevel: () => undefined,
  getContextUsage: () => undefined,
  modelRegistry: { isUsingOAuth: () => false },
  sessionManager: { getEntries: () => [] },
}, { gitEnabled: () => false });
footer.setExtensionStatus("old-reporting-proof", "Claude status: thinking_tokens [turnId=synthetic-turn]");
const baseline = footer.describe();
const baselineLines = footer.render(160);
footer.setExtensionStatus("old-reporting-proof", undefined);
const notifications = [];
const ctx = {
  cwd: root,
  agent: { kind: "main", id: "Main", name: "main", depth: 0 },
  sessionManager: { getSessionId: () => "synthetic-status-host" },
  ui: {
    setStatus: (key, text) => footer.setExtensionStatus(key, text),
    notify: (message, level) => notifications.push({ message, level }),
  },
};
const events = new EventEmitter();
const observed = [];
events.on("pi-claude-cli:observation", (value) => observed.push(value));
const handlers = new Map();
const api = { logger, events, on: (name, handler) => handlers.set(name, handler) };
const lifecycle = new OmpLifecycle(async () => ({
  invalidate: async () => {},
  close: async () => { throw new Error("synthetic cleanup fault"); },
  closeAll: async () => {},
}));
lifecycle.register(api);
await handlers.get("session_start")({}, ctx);
const state = lifecycle.session({ sessionId: "synthetic-status-host" });
const families = ["task", "tool-progress", "status", "retry", "rate-limit", "compaction"];
for (const [index, family] of families.entries()) {
  lifecycle.observe(api, state, {
    type: "observation", family, subtype: "synthetic-" + family,
    sequence: index + 1,
    attribution: {
      claudeSessionId: "synthetic-claude-session", taskId: "synthetic-task",
      unknownId: "UNKNOWN_ATTRIBUTION_MARKER",
      messageId: "CONTROL_ATTRIBUTION_MARKER\u001b[31m",
      toolUseId: "OVERSIZED_ATTRIBUTION_MARKER" + "x".repeat(300),
    },
    data: { status: "RAW_SYNTHETIC_OBSERVATION_DATA_MARKER" },
  });
}
lifecycle.observe(api, state, {
  type: "observation", family: "status", subtype: "thinking_tokens",
  sequence: 7, attribution: { turnId: "synthetic-turn" }, data: {},
});
const afterObservations = footer.describe();
const linesAfterObservations = footer.render(160);
await lifecycle.runtime(state);
await lifecycle.closeState(state).catch(() => {});
await Promise.resolve();
const files = readdirSync(logDir).filter((name) => name.endsWith(".log"));
const logs = files.flatMap((name) => readFileSync(join(logDir, name), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)));
logger.setTransports({ file: false, console: false });
footer.dispose();
const nativeVersion = JSON.parse(readFileSync(join(root, "node_modules/@oh-my-pi/pi-tui/package.json"), "utf8")).version;
console.log(JSON.stringify({ compiledExecutable: process.execPath, nativeVersion, testedPackage: { name: testedPackage.name, version: testedPackage.version, root: packageRoot, lifecyclePath }, baseline, baselineLines, afterObservations, linesAfterObservations, observed, notifications, logs }));
`,
    );
    const logDir = join(scratch, "logs");
    const { stdout, stderr } = await new Promise<{
      stdout: string;
      stderr: string;
    }>((resolve, reject) => {
      execFile(
        compiledBunExecutable!,
        [probe, root, logDir, packageRoot],
        {
          cwd: root,
          env: { ...process.env, BUN_BE_BUN: "1" },
          timeout: 10000,
          maxBuffer: 65536,
        },
        (error, stdout, stderr) =>
          error
            ? reject(new Error(`${error.message}\n${stderr}`))
            : resolve({ stdout, stderr }),
      );
    });
    await writeFile(join(scratch, "fixed-evidence.json"), stdout);
    const evidence = JSON.parse(stdout);
    expect(evidence.compiledExecutable).toBe(
      await realpath(compiledBunExecutable!),
    );
    expect(evidence.nativeVersion).toBe("18.4.4");
    expect(evidence.testedPackage).toEqual({
      name: expectedPackage.name,
      version: expectedPackage.version,
      root: packageRoot,
      lifecyclePath: join(packageRoot, "src/adapters/omp/lifecycle.ts"),
    });
    expect(stderr).toBe("");
    expect(JSON.stringify(evidence.baseline)).toContain(
      "omp.footer.extensions",
    );
    expect(evidence.baseline.c[0].p.role).toBe("omp.footer");
    expect(evidence.baseline.c[1].p.role).toBe("omp.footer.extensions");
    expect(evidence.baselineLines.at(-1)).toContain(
      "Claude status: thinking_tokens [turnId=synthetic-turn]",
    );
    expect(JSON.stringify(evidence.afterObservations)).not.toContain(
      "omp.footer.extensions",
    );
    expect(evidence.linesAfterObservations.join("\n")).not.toContain("Claude");
    expect(JSON.stringify(evidence.logs)).toContain("thinking_tokens");
    const debugLogs = evidence.logs.filter(
      (record: { level: string }) => record.level === "debug",
    );
    expect(debugLogs).toHaveLength(7);
    expect(evidence.observed).toHaveLength(7);
    for (const marker of [
      "RAW_SYNTHETIC_OBSERVATION_DATA_MARKER",
      "UNKNOWN_ATTRIBUTION_MARKER",
      "CONTROL_ATTRIBUTION_MARKER",
      "OVERSIZED_ATTRIBUTION_MARKER",
    ]) {
      expect(JSON.stringify(evidence.logs)).not.toContain(marker);
      expect(JSON.stringify(evidence.observed)).toContain(marker);
    }
    expect(debugLogs[0].attribution).toEqual({
      claudeSessionId: "synthetic-claude-session",
      taskId: "synthetic-task",
    });
    for (const family of [
      "task",
      "tool-progress",
      "status",
      "retry",
      "rate-limit",
      "compaction",
    ]) {
      expect(evidence.observed).toContainEqual(
        expect.objectContaining({
          event: expect.objectContaining({
            family,
            subtype: `synthetic-${family}`,
          }),
        }),
      );
      expect(JSON.stringify(evidence.logs)).toContain(`synthetic-${family}`);
    }
    expect(evidence.notifications).toContainEqual({
      message: "Claude cleanup failed: synthetic cleanup fault",
      level: "error",
    });
    expect(evidence.logs).toContainEqual(
      expect.objectContaining({
        level: "error",
        message: "Claude cleanup failed: synthetic cleanup fault",
      }),
    );
  },
  15000,
);
