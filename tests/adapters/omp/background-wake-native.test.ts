import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const compiledBunExecutable = process.env.PCC_COMPILED_BUN_EXECUTABLE;
it.skipIf(!compiledBunExecutable)(
  "continues native OMP async-result developer and image notifications without inference",
  async () => {
    const probe = fileURLToPath(
      new URL("./background-wake-probe.ts", import.meta.url),
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
        { withImage: false, rounds: 3, roles: ["developer"] },
        { withImage: true, rounds: 3, roles: ["developer", "user"] },
      ],
      inference: false,
    });
  },
  15000,
);
