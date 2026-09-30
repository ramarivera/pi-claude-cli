import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

/** Optional local integration target: the installed compiled OMP executable, not inference. */
const compiledBunExecutable = process.env.PCC_COMPILED_BUN_EXECUTABLE;
it.skipIf(!compiledBunExecutable).each(["tools", "native-sequence"])(
  "runs %s with actual compiled Bun and keeps Claude's environment unchanged (offline)",
  async (mode) => {
    const probe = fileURLToPath(
      new URL("./compiled-bun-probe.mjs", import.meta.url),
    );
    const fixture = fileURLToPath(
      new URL("./offline-claude.mjs", import.meta.url),
    );
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        compiledBunExecutable!,
        [probe, fixture, mode],
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
      calls:
        mode === "tools"
          ? ["tool-a", "tool-b"]
          : [
              "toolu_019MQnr1hrXbz88TbmDn9End",
              "toolu_01Qb5GdCWMM4CvQefY4YJrGw",
            ],
      results:
        mode === "tools"
          ? ["tool-a", "tool-b"]
          : [
              "toolu_019MQnr1hrXbz88TbmDn9End",
              "toolu_01Qb5GdCWMM4CvQefY4YJrGw",
            ],
      nativeSequence: mode === "native-sequence",
      cleaned: true,
    });
  },
  15000,
);
