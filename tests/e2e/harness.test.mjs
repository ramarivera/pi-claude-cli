import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ROOT, RpcHost, executable, hostEnvironment } from "./rpc.mjs";

function runnerEnvironment(overrides) {
  const env = { ...process.env, ...overrides };
  // Node's child-v8 test context suppresses a nested runner's normal execution.
  delete env.NODE_TEST_CONTEXT;
  return env;
}

test("disabled direct runner explicitly skips all four authenticated cases", () => {
  const env = runnerEnvironment({ PI_CLAUDE_LIVE_E2E: "0" });
  const result = spawnSync(
    process.execPath,
    ["--test", "--test-reporter=tap", join(ROOT, "tests/e2e/live.test.mjs")],
    { env, encoding: "utf8", timeout: 10000 },
  );
  assert.equal(result.status, 0);
  assert.match(result.stdout, /skipped 4/);
  for (const name of ["pi+cli", "pi+sdk", "omp+cli", "omp+sdk"])
    assert.ok(result.stdout.includes(`actual ${name}:`));
});

test("opt-in with a missing host prerequisite fails without starting inference", () => {
  const receipts = mkdtempSync(join(tmpdir(), "pcc-prerequisite-receipts-"));
  try {
    const env = runnerEnvironment({
      PI_CLAUDE_LIVE_E2E: "1",
      PI_CLAUDE_LIVE_CASE: "pi+cli",
      PI_E2E_BIN: "/pcc-missing-host",
      PI_CLAUDE_E2E_RECEIPT_DIR: receipts,
    });
    const result = spawnSync(
      process.execPath,
      ["--test", "--test-reporter=tap", join(ROOT, "tests/e2e/live.test.mjs")],
      { env, encoding: "utf8", timeout: 10000 },
    );
    assert.equal(result.status, 1);
    assert.match(
      result.stdout,
      /Missing executable prerequisite: \/pcc-missing-host/,
    );
    assert.match(result.stdout, /fail 1/);
    assert.match(result.stdout, /skipped 3/);
  } finally {
    rmSync(receipts, { recursive: true, force: true });
  }
});

test("invalid selected case is a failure even when no matrix case matches", () => {
  const result = spawnSync(
    process.execPath,
    ["--test", "--test-reporter=tap", join(ROOT, "tests/e2e/live.test.mjs")],
    {
      env: runnerEnvironment({
        PI_CLAUDE_LIVE_E2E: "1",
        PI_CLAUDE_LIVE_CASE: "invented",
      }),
      encoding: "utf8",
      timeout: 10000,
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Invalid PI_CLAUDE_LIVE_CASE/);
});

test("login isolation retains official config location and clears alternative auth", () => {
  const env = hostEnvironment("pi", "sdk", "/tmp/synthetic-host", "nonce", {
    PATH: process.env.PATH,
    CLAUDE_CONFIG_DIR: "/official-config",
    ANTHROPIC_API_KEY: "synthetic-secret",
    ANTHROPIC_AUTH_TOKEN: "synthetic-token",
    ANTHROPIC_BASE_URL: "https://alternative.invalid",
    CLAUDE_CODE_OAUTH_TOKEN: "synthetic-oauth",
    CLAUDE_CODE_USE_BEDROCK: "1",
    AWS_PROFILE: "other",
    BUN_BE_BUN: "1",
    PI_CLAUDE_EFFORT: "high",
    PI_CLAUDE_MCP_CONFIG: "/unrelated-config",
  });
  assert.equal(env.CLAUDE_CONFIG_DIR, "/official-config");
  for (const name of [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "AWS_PROFILE",
    "BUN_BE_BUN",
    "PI_CLAUDE_EFFORT",
    "PI_CLAUDE_MCP_CONFIG",
  ])
    assert.equal(env[name], undefined, name);
  assert.equal(env.PI_CLAUDE_DRIVER, "sdk");
  assert.equal(env.PI_CLAUDE_AUTH, "claude-login");
  assert.equal(env.PI_CLAUDE_MAX_OUTPUT_TOKENS, "512");
  assert.equal(env.PI_CLAUDE_MAX_TURNS, "8");
});

test("api-key mode requires explicit key and preserves only selected API auth", () => {
  assert.throws(
    () =>
      hostEnvironment("omp", "cli", "/tmp/synthetic", "nonce", {
        PI_CLAUDE_AUTH: "api-key",
      }),
    /requires ANTHROPIC_API_KEY/,
  );
  const env = hostEnvironment("omp", "cli", "/tmp/synthetic", "nonce", {
    PI_CLAUDE_AUTH: "api-key",
    ANTHROPIC_API_KEY: "synthetic-key",
    ANTHROPIC_BASE_URL: "https://api.invalid",
    ANTHROPIC_AUTH_TOKEN: "other",
  });
  assert.equal(env.ANTHROPIC_API_KEY, "synthetic-key");
  assert.equal(env.ANTHROPIC_BASE_URL, "https://api.invalid");
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
});

test("executable prerequisite rejects missing paths", () => {
  assert.throws(
    () => executable("/pcc-missing-executable"),
    /Missing executable prerequisite/,
  );
});

test("test-context cancellation rejects an active RPC wait and permits awaited cleanup", async () => {
  const controller = new AbortController();
  const rpc = new RpcHost(
    process.execPath,
    [
      "-e",
      "process.stdin.resume(); process.stdin.on('end',()=>process.exit(0));",
    ],
    process.env,
    tmpdir(),
    { signal: controller.signal },
  );
  try {
    const pending = rpc.wait(() => false, "synthetic timeout", 10000);
    controller.abort(new Error("synthetic test timeout"));
    await assert.rejects(pending, /synthetic test timeout/);
    assert.throws(() => rpc.send("prompt"), /synthetic test timeout/);
  } finally {
    const cleanup = await rpc.close();
    assert.deepEqual(cleanup.survivors, []);
    assert.deepEqual(cleanup.forcedChildren, []);
  }
});

for (const host of ["pi", "omp"]) {
  test(`synthetic RPC parser ${host}: command acceptance doesn't complete the prompt`, async () => {
    // This is a parser test, not a live host or inference substitute.
    const script = `
      let buffer = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', chunk => {
        buffer += chunk;
        let end;
        while ((end = buffer.indexOf('\\n')) !== -1) {
          const command = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
          const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
          emit({type:'response',id:command.id,success:true,data:{isStreaming:false,isSettled:true}});
          if (command.type === 'prompt') setTimeout(() => {
            ${host === "omp" ? "emit({type:'prompt_result',id:command.id,status:'completed'}); emit({type:'session_settled'});" : "emit({type:'agent_settled'});"}
          }, 150);
        }
      });
      process.stdin.on('end', () => process.exit(0));
    `;
    const rpc = new RpcHost(
      process.execPath,
      ["--input-type=module", "-e", script],
      process.env,
      tmpdir(),
    );
    try {
      const since = rpc.frames.length;
      const id = rpc.send("prompt", { message: "synthetic-parser-only" });
      const before = Date.now();
      await rpc.settled(host, id, since);
      assert.ok(
        Date.now() - before >= 100,
        "Parser treated prompt acceptance as completion",
      );
      assert.ok(
        rpc.frames.some(
          (frame) =>
            frame.type === (host === "pi" ? "agent_settled" : "prompt_result"),
        ),
      );
    } finally {
      const cleanup = await rpc.close();
      assert.deepEqual(cleanup.forcedChildren, []);
      assert.deepEqual(cleanup.survivors, []);
    }
  });
}
