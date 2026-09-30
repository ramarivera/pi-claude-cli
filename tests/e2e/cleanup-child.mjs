// The signal log distinguishes owner cleanup from a harness group signal.
import { appendFileSync } from "node:fs";

const [log] = process.argv.slice(2);
const keepAlive = setInterval(() => {}, 1000);
process.on("message", (message) => {
  if (message !== "owner-shutdown") return;
  appendFileSync(log, "owner-shutdown\n");
  clearInterval(keepAlive);
  process.exit(0);
});
process.on("SIGTERM", () => {
  appendFileSync(log, "direct-child-sigterm\n");
  clearInterval(keepAlive);
  process.exit(0);
});
process.send("ready");
