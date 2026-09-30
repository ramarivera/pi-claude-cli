import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.env.PI_CLAUDE_LIVE_E2E !== "1") {
  console.log(
    "SKIPPED authenticated E2E: pi+cli, pi+sdk, omp+cli, omp+sdk. Set PI_CLAUDE_LIVE_E2E=1 to execute paid/runtime tests.",
  );
} else {
  const result = spawnSync(
    process.execPath,
    ["--test", fileURLToPath(new URL("./e2e/live.test.mjs", import.meta.url))],
    { stdio: "inherit", env: process.env },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
