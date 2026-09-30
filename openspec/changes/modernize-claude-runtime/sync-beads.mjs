import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Coordinator only: export the canonical local board, never an independent worker board.
const base = dirname(fileURLToPath(import.meta.url));
const root = resolve(base, "../../..");
const exported = execFileSync("bd", ["--sandbox", "export"], {
  cwd: root,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"],
});
const plan = JSON.parse(readFileSync(resolve(base, "lanes.json"), "utf8"));
const plannedIds = new Set([plan.epic, ...plan.tasks.map((task) => task.id)]);
// Other changes have their own beads; this snapshot owns only this plan.
const scoped = exported
  .trim()
  .split("\n")
  .map(JSON.parse)
  .filter((issue) => plannedIds.has(issue.id));
writeFileSync(
  resolve(base, "beads.jsonl"),
  scoped.map((issue) => JSON.stringify(issue)).join("\n") + "\n",
);
const issues = new Map(
  readFileSync(resolve(base, "beads.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => {
      const issue = JSON.parse(line);
      return [issue.id, issue];
    }),
);
let text = readFileSync(resolve(base, "tasks.md"), "utf8");
for (const task of plan.tasks) {
  const escaped = task.key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp("^- \\[[ x]\\] " + escaped + " ", "m");
  if (!pattern.test(text)) throw new Error("Missing task checkbox: " + task.id);
  const issue = issues.get(task.id);
  if (!issue) throw new Error("Missing canonical bead: " + task.id);
  text = text.replace(
    pattern,
    "- [" + (issue.status === "closed" ? "x" : " ") + "] " + task.key + " ",
  );
}
writeFileSync(resolve(base, "tasks.md"), text);
execFileSync("node", [resolve(base, "validate-plan.mjs")], {
  cwd: root,
  stdio: "inherit",
});
