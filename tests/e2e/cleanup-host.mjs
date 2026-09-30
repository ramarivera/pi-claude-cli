// Synthetic ownership fixture only; never invokes a host or Claude runtime.
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

const [mode, log] = process.argv.slice(2);
const child = fork(
  fileURLToPath(new URL("./cleanup-child.mjs", import.meta.url)),
  [log],
  {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  },
);
const keepAlive = setInterval(() => {}, 1000);
child.on("message", (message) => {
  if (message === "ready")
    process.stdout.write(
      JSON.stringify({ type: "fixture_ready", childPid: child.pid }) + "\n",
    );
});
process.stdin.resume(); // Deliberately ignore EOF to exercise supported SIGTERM.
process.on("SIGTERM", () => {
  if (mode === "ignore") return;
  if (mode === "leak") process.exit(0);
  child.once("exit", () => {
    clearInterval(keepAlive);
    process.exit(0);
  });
  child.send("owner-shutdown");
});
