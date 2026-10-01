import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const compiledBunExecutable = process.env.PCC_COMPILED_BUN_EXECUTABLE;
it.skipIf(!compiledBunExecutable)(
  "retains resident Claude state through native OMP hook argument revisions",
  async () => {
    const probe = fileURLToPath(
      new URL("./hook-rewrite-probe.ts", import.meta.url),
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
      evidence: ["cli", "sdk"].map((driver) => ({
        driver,
        nativeArgumentRevisions: 1,
        executed: ["rewritten"],
        residentOpens: 1,
        delivered: ["bash", "read"],
        followup: true,
      })),
      inference: false,
    });
  },
  15000,
);
