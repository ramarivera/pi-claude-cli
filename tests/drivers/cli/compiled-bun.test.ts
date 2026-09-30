import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

/** Optional local integration target: the installed compiled OMP executable, not inference. */
const compiledBunExecutable = process.env.PCC_COMPILED_BUN_EXECUTABLE;
it.skipIf(!compiledBunExecutable)(
  "runs the private MCP endpoint with actual compiled Bun and keeps Claude's environment unchanged (offline)",
  async () => {
    const probe = fileURLToPath(
      new URL("./compiled-bun-probe.mjs", import.meta.url),
    );
    const fixture = fileURLToPath(
      new URL("./offline-claude.mjs", import.meta.url),
    );
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        compiledBunExecutable!,
        [probe, fixture],
        {
          cwd: process.cwd(),
          env: { ...process.env, BUN_BE_BUN: "1" },
          timeout: 10000,
          maxBuffer: 65536,
        },
        (error, output) => (error ? reject(error) : resolve(output)),
      );
    });
    expect(JSON.parse(stdout)).toMatchObject({
      compiledExecutable: await realpath(compiledBunExecutable!),
      privateMcpMode: "1",
      claudeInheritedBunMode: false,
      advertisedSchema: true,
      calls: ["tool-a", "tool-b"],
      results: ["tool-a", "tool-b"],
      cleaned: true,
    });
  },
  15000,
);
