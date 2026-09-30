import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const compiledBunExecutable = process.env.PCC_COMPILED_BUN_EXECUTABLE;
it.skipIf(!compiledBunExecutable)(
  "accepts native Agent/settings/dispatcher defaults without calling OMP HTTP fetch (offline)",
  async () => {
    const probe = fileURLToPath(
      new URL("./native-defaults-probe.ts", import.meta.url),
    );
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        compiledBunExecutable!,
        [probe],
        {
          env: { ...process.env, BUN_BE_BUN: "1" },
          timeout: 10000,
          maxBuffer: 65536,
        },
        (error, output, stderr) =>
          error
            ? reject(new Error(`${error.message}\n${stderr}`))
            : resolve(output),
      );
    });
    expect(JSON.parse(stdout)).toEqual({
      evidence: [
        {
          driver: "cli",
          rounds: 2,
          injectedFetch: true,
          injectedThinkingBudgets: true,
        },
        {
          driver: "sdk",
          rounds: 2,
          injectedFetch: true,
          injectedThinkingBudgets: true,
        },
      ],
      globalFetchCalls: 0,
      customFetchCalls: 0,
    });
  },
  15000,
);
