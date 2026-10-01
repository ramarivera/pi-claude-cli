import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { managedPiHelper, nativeHelperCleanup } from "./process-ownership.mjs";
import { RpcHost, scratchDirectory } from "./rpc.mjs";

function fixture() {
  const sandbox = scratchDirectory("ownership-");
  const root = join(sandbox, "node_modules");
  const cli = join(root, "tsx/dist/cli.mjs");
  const broker = join(root, "pi-intercom/broker/broker.ts");
  mkdirSync(join(root, "tsx/dist"), { recursive: true });
  mkdirSync(join(root, "pi-intercom/broker"), { recursive: true });
  mkdirSync(join(sandbox, "t"));
  const worker = "setInterval(() => {}, 1000);\n";
  writeFileSync(cli, worker);
  writeFileSync(
    broker,
    "// Synthetic broker path; no real extension is loaded.\n",
  );
  writeFileSync(join(sandbox, "unknown.mjs"), worker);
  const server = join(sandbox, "host.mjs");
  writeFileSync(
    server,
    `import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
const input = createInterface({ input: process.stdin });
input.on('line', line => {
  const command = JSON.parse(line);
  let data = {};
  if (command.type === 'launch') {
    const args = command.trusted
      ? [${JSON.stringify(cli)}, ${JSON.stringify(broker)}]
      : [${JSON.stringify(join(sandbox, "unknown.mjs"))}, ${JSON.stringify(broker)}, ${JSON.stringify(cli)}];
    const child = spawn(process.execPath, args, { stdio: 'ignore' });
    data = { pid: child.pid };
  }
  console.log(JSON.stringify({ type: 'response', id: command.id, success: true, data }));
});
input.on('close', () => process.exit(0));
`,
  );
  const host = new RpcHost(process.execPath, [server], process.env, sandbox, {
    classifyProcess: (process) => managedPiHelper(process, root),
  });
  const allowance = (pid) =>
    nativeHelperCleanup(
      {
        observedProcesses: [...host.identities.values()],
        forcedChildren: [pid],
      },
      host.baseline,
      host.child.pid,
      [...host.initialIdentities.values()],
      true,
    ).rejectedCount === 0;
  // Keep a negative cleanup verdict fast while using the actual live process
  // scanner and predicate; authenticated tests retain their original timeout.
  const wait = host.wait.bind(host);
  host.wait = (predicate, description, timeout) =>
    wait(
      predicate,
      description,
      description.startsWith("natural Claude") ? 150 : timeout,
    );
  return { host, sandbox, allowance };
}

for (const trusted of [true, false])
  test(`late ${trusted ? "signed broker" : "unknown Node worker"} cleanup keeps strict ownership and accurate forced counts`, async () => {
    const { host, sandbox, allowance } = fixture();
    let cleanup;
    try {
      await host.command("get_state");
      host.rememberBaseline();
      const { pid } = await host.command("launch", { trusted });
      await host.wait(() => {
        host.track();
        const identity = host.identities.get(pid);
        return (
          identity?.name === "node-MainThread" &&
          (!trusted || identity.helperOwner === "pi-intercom")
        );
      }, "live Node helper identity");
      assert.equal(host.baseline.has(pid), false);
      await assert.rejects(
        host.transportIdle(join(sandbox, "t")),
        /Timed out waiting for natural Claude/,
      );
      if (trusted) {
        const result = await host.transportIdle(join(sandbox, "t"), {
          allowOwnedHelper: allowance,
        });
        assert.equal(result.childrenGone, true);
        assert.equal(result.forced, false);
        assert.equal(result.excludedNativeHelpers, 1);
        assert.deepEqual(
          result.excludedNativeProcesses.map(({ pid }) => pid),
          [pid],
        );
        assert.equal(
          result.excludedNativeProcesses[0].helperOwner,
          "pi-intercom",
        );
      } else {
        assert.equal(allowance(pid), false);
        await assert.rejects(
          host.transportIdle(join(sandbox, "t"), {
            allowOwnedHelper: allowance,
          }),
          /Timed out waiting for natural Claude/,
        );
      }
      cleanup = await host.close();
      assert.deepEqual(cleanup.forcedChildren, [pid]);
      assert.deepEqual(cleanup.survivors, []);
      assert.equal(cleanup.hostRequiredKill, false);
      const proof = nativeHelperCleanup(
        cleanup,
        host.baseline,
        host.child.pid,
        [...host.initialIdentities.values()],
        true,
      );
      assert.equal(proof.allowedHelperCount, trusted ? 1 : 0);
      assert.equal(proof.rejectedCount, trusted ? 0 : 1);
    } finally {
      if (!cleanup) await host.close();
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

test("cleanup doesn't signal or count a tracked PID after its identity changes", async () => {
  const { host, sandbox } = fixture();
  const unrelated = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    { stdio: "ignore" },
  );
  try {
    await host.command("get_state");
    const stat = readFileSync(`/proc/${unrelated.pid}/stat`, "utf8");
    const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    host.tracked.set(unrelated.pid, `${start}-different`);
    const result = await host.close();
    assert.equal(result.observedPids.includes(unrelated.pid), true);
    assert.equal(result.forcedChildren.includes(unrelated.pid), false);
    assert.equal(unrelated.exitCode, null);
    assert.doesNotThrow(() => process.kill(unrelated.pid, 0));
  } finally {
    unrelated.kill("SIGTERM");
    if (!host.closed) await host.close();
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("process tracking can't reacquire a reused host PID", async () => {
  const unrelated = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    { stdio: "ignore" },
  );
  try {
    const stat = readFileSync(`/proc/${unrelated.pid}/stat`, "utf8");
    const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    const originalStart = `${start}-different`;
    const watch = Object.assign(Object.create(RpcHost.prototype), {
      child: { pid: unrelated.pid },
      closed: true,
      tracked: new Map([[unrelated.pid, originalStart]]),
      identities: new Map(),
      initialIdentities: new Map(),
    });
    watch.track();
    assert.equal(watch.tracked.get(unrelated.pid), originalStart);
    assert.equal(watch.identities.has(unrelated.pid), false);
    assert.doesNotThrow(() => process.kill(unrelated.pid, 0));
  } finally {
    unrelated.kill("SIGTERM");
  }
});
