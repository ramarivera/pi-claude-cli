import assert from "node:assert/strict";
import { log } from "node:console";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const base = dirname(fileURLToPath(import.meta.url));
const root = resolve(base, "../../..");
const plan = JSON.parse(readFileSync(resolve(base, "lanes.json"), "utf8"));
const issues = readFileSync(resolve(base, "beads.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map(JSON.parse);
const board = new Map(issues.map((i) => [i.id, i]));
const tasks = new Map(plan.tasks.map((t) => [t.id, t]));
const check = (value, message) => assert.ok(value, message);
check(tasks.size === plan.tasks.length, "Duplicate task IDs");
check(
  board.size === tasks.size + 1 && board.has(plan.epic),
  "Board has wrong task/epic set",
);
const specDirs = new Set(readdirSync(resolve(base, "specs")));
const taskDoc = readFileSync(resolve(base, "tasks.md"), "utf8");
const seenKeys = new Set();
const owners = Object.entries(plan.lanes).flatMap(([lane, value]) =>
  value.owns.map((path) => ({ lane, path })),
);
const dirPrefix = (path) => (path.endsWith("/**") ? path.slice(0, -3) : null);
const matches = (pattern, path) => {
  const prefix = dirPrefix(pattern);
  return prefix === null
    ? pattern === path
    : path === prefix || path.startsWith(prefix + "/");
};
for (let i = 0; i < owners.length; i++) {
  for (let j = i + 1; j < owners.length; j++) {
    const a = owners[i],
      b = owners[j];
    if (a.lane === b.lane) continue;
    const ap = dirPrefix(a.path) ?? a.path,
      bp = dirPrefix(b.path) ?? b.path;
    check(
      !matches(a.path, bp) && !matches(b.path, ap),
      "Overlapping owners: " +
        a.lane +
        " " +
        a.path +
        " / " +
        b.lane +
        " " +
        b.path,
    );
  }
}
const tracked = execFileSync(
  "git",
  [
    "ls-tree",
    "-r",
    "--name-only",
    "e0c9a12ac21be4c197e82795f7207746f3183028",
    "--",
    "src",
    "tests",
    "index.ts",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "vitest.config.ts",
    "eslint.config.mjs",
    ".github",
    ".prettierignore",
    ".gitignore",
    "README.md",
    "LICENSE",
    "test-tool-extension.ts",
  ],
  { cwd: root, encoding: "utf8" },
)
  .trim()
  .split("\n")
  .filter(Boolean);
for (const path of tracked) {
  const assigned = owners.filter((o) => matches(o.path, path));
  check(assigned.length === 1, "Missing or ambiguous owner: " + path);
  check(
    assigned[0].lane === "integration",
    "Legacy/shared file outside integration: " + path,
  );
}
const required = new Set();
for (const t of plan.tasks) {
  check(plan.lanes[t.lane], "Missing lane: " + t.id);
  check(t.mins > 0 && t.mins < 120, "Slice must be under two hours: " + t.id);
  check(!seenKeys.has(t.key), "Duplicate task key");
  seenKeys.add(t.key);
  const issue = board.get(t.id);
  check(issue, "Missing bead: " + t.id);
  check(issue.title === t.title, "Title mismatch: " + t.id);
  check(issue.acceptance_criteria === t.accept, "Acceptance mismatch: " + t.id);
  check(
    issue.description.includes("## Acceptance Criteria"),
    "Missing acceptance section: " + t.id,
  );
  check(issue.spec_id === relative(root, base), "Missing spec link: " + t.id);
  const parents = (issue.dependencies ?? [])
    .filter((d) => d.type === "parent-child")
    .map((d) => d.depends_on_id);
  check(
    parents.length === 1 && parents[0] === plan.epic,
    "Wrong epic parent: " + t.id,
  );
  const actual = (issue.dependencies ?? [])
    .filter((d) => d.type === "blocks")
    .map((d) => d.depends_on_id)
    .sort();
  assert.deepEqual(
    actual,
    [...t.deps].sort(),
    "Native blockers mismatch: " + t.id,
  );
  const mark = issue.status === "closed" ? "x" : " ";
  check(
    taskDoc.includes(
      "- [" + mark + "] " + t.key + " " + t.title + " (`" + t.id + "`",
    ),
    "Checkbox/bead mismatch: " + t.id,
  );
  for (const cap of t.caps) {
    check(specDirs.has(cap), "Missing capability: " + cap);
    required.add(cap);
  }
  for (const dep of t.deps) check(tasks.has(dep), "Unknown dependency: " + dep);
}
assert.deepEqual([...required].sort(), [...specDirs].sort(), "Uncovered specs");
const states = new Map();
const visit = (id) => {
  check(states.get(id) !== "visiting", "Dependency cycle: " + id);
  if (states.get(id) === "done") return;
  states.set(id, "visiting");
  for (const dep of tasks.get(id).deps) visit(dep);
  states.set(id, "done");
};
for (const id of tasks.keys()) visit(id);
const ancestors = (id) => {
  const result = new Set();
  const walk = (value) => {
    for (const dep of tasks.get(value).deps)
      if (!result.has(dep)) {
        result.add(dep);
        walk(dep);
      }
  };
  walk(id);
  return result;
};
for (const t of plan.tasks.filter(
  (t) => plan.lanes[t.lane].kind === "implementation",
)) {
  check(
    ancestors(t.id).has("pcc-start"),
    "Implementation bypasses start: " + t.id,
  );
}
if (plan.implementation === "deferred") {
  check(
    board.get("pcc-start").status === "deferred",
    "Start gate isn't deferred",
  );
  check(board.get(plan.epic).status === "deferred", "Epic isn't deferred");
  check(
    !issues.some((i) => i.id !== "pcc-plan" && i.status === "in_progress"),
    "Implementation already running",
  );
}
check(plan.max_active_lanes === 3, "Active lane resource ceiling changed");
const combinations = new Set(
  plan.live_matrix.map((c) => c.host + "+" + c.driver),
);
assert.deepEqual(
  [...combinations].sort(),
  ["omp+cli", "omp+sdk", "pi+cli", "pi+sdk"],
  "Missing live combination",
);
check(
  ancestors("pcc-live").has("pcc-offline") &&
    ancestors("pcc-live").has("pcc-live-access"),
  "Live execution bypasses offline or account gates",
);
for (const id of [
  "pcc-core-session",
  "pcc-cli-control",
  "pcc-sdk-handoff",
  "pcc-pi-life",
  "pcc-omp-life",
  "pcc-e2e-harness",
])
  check(
    tasks.get("pcc-cutover").deps.includes(id),
    "Cutover doesn't join lane: " + id,
  );
log(
  JSON.stringify(
    {
      valid: true,
      tasks: tasks.size,
      beads: board.size,
      capabilities: specDirs.size,
      ownershipPatterns: owners.length,
      legacyFiles: tracked.length,
      overlap: false,
      cycles: false,
      liveCombinations: combinations.size,
      implementation: plan.implementation,
    },
    null,
    2,
  ),
);
