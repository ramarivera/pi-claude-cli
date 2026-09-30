# Actual host RPC verification

`tests/e2e/live.test.mjs` defines four authenticated cases: Pi + CLI, Pi + SDK, OMP + CLI, and OMP + SDK. Every case loads the production entrypoint directly into the actual host RPC process. The additional native extension registers only the sentinel, cancellable slow tool, and observations; it doesn't replace the runtime, driver, provider, or inference.

Authenticated inference remains **unverified** until the coordinator runs the enabled matrix and reviews its receipts. The verification lane ran no inference. Its actual loading check passed all four combinations on September 30, 2026, with Pi 0.99.1 and compiled OMP 18.4.4: custom provider/model selection, explicit thinking off, extension loading, retry/compaction controls, and native OMP hashline `{ input }` schema. Loading doesn't establish authentication, resident Claude behavior, tool execution, restoration, or abort behavior.

## Commands

Offline Node harness gates, with no inference:

```nu
node --test tests/e2e/harness.test.mjs
node --test tests/e2e/live.test.mjs
npm run test:live
```

The direct disabled runner explicitly skips four named cases. The package runner prints the four skipped combinations. `harness.test.mjs` verifies those skips, enabled missing-prerequisite failure, invalid selection failure, auth environment isolation, native completion framing, and cancellation cleanup. Its RPC parser and child ownership fixtures are explicitly synthetic unit tests. Child ownership cases distinguish graceful owner shutdown from a leaked child needing direct fallback and an unresponsive host requiring emergency group SIGKILL.

Actual hosts, with no prompt/inference:

```nu
$env.PCC_E2E_HOST_LOADING = "1"
node --test tests/e2e/loading.test.mjs
hide-env PCC_E2E_HOST_LOADING
```

Coordinator-only authenticated execution, after reviewing the integrated revision and prerequisites:

```nu
$env.PI_CLAUDE_LIVE_E2E = "1"
$env.PI_CLAUDE_LIVE_CASE = "pi+cli"
npm run test:live
hide-env PI_CLAUDE_LIVE_CASE
npm run test:live
hide-env PI_CLAUDE_LIVE_E2E
```

The initial selected case runs the full case and explicitly skips the other three. Removing the selection runs the full matrix sequentially. An unknown selection fails. `PI_E2E_BIN` and `OMP_E2E_BIN` override host executables; the latter must be the compiled ELF host. The default OMP path is the installed mise binary documented in the execution research. `PI_CLAUDE_EXECUTABLE` chooses the official Claude executable. Unexpected host/Claude/SDK versions and missing authentication fail when enabled.

## Assertions and bounds

Each case submits seven synthetic user prompts across an initial and restored host process:

1. Exact semantic text with a distinctive system marker.
2. A native sentinel executes exactly once and returns a nonce, counter, canonical call ID, structured result, and MCP metadata. Native assistant proposal, execute ID, and tool result ID must match, including SDK parked tools. Pi additionally exposes the canonical parked request. Both OMP cases must first read and perform one real native hashline edit using the observed four-hex tag; the patch must use `{ input }`, and resulting file bytes must match.
3. Resident continuation remembers the nonce without another tool call. Every observed provider round retains the authoritative Claude initialization ID and selected driver.
4. The initial process closes, a new actual host restores the saved native session, and the model recalls the nonce. A new authoritative Claude ID identifies fresh-runtime history replay; this doesn't claim native Claude process resumption.
5. Abort while text is actually streaming. Native history must report `aborted`; an OMP correlated prompt result must also report `aborted`.
6. Abort while the native slow tool executes. Its AbortSignal must fire with the same call ID; its delayed effect must never happen.
7. A final tiny prompt completes after both aborts. `new_session` then exercises host lifecycle cleanup while the host remains alive.

Pi completion requires `agent_settled` and a nonstreaming state. OMP requires the correlated `prompt_result`, `session_settled`, and `get_state.isSettled`. Command acceptance alone never counts as inference completion.

The exact observed model is `claude-haiku-4-5-20251001` under `pi-claude-cli`, with thinking explicitly off. Official Claude 2.1.285 initialize metadata doesn't advertise effort support for Haiku. Bounds are eight turns, 512 output tokens, $0.25 reported query-budget limit, 15 seconds for host tool results, three seconds for driver shutdown, and 180 seconds wall time per case. Every RPC wait/send checks the case deadline and Node test context AbortSignal; failure exits through awaited cleanup. The 210-second Node timeout leaves room for cleanup. Native cache warming is stopped by the observer; RPC disables automatic retry and compaction.

The eight-turn bound is conservative: installed SDK 0.3.285 `sdk.d.ts` describes `maxTurns` as a query conversation-turn limit without promising reset per submitted input. The [official streaming input example](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode) uses one persistent query for multiple messages with an explicit turn bound. This harness retains a bound large enough for resident native read/edit/sentinel rounds rather than depending on an undocumented per-input reset.

## Isolation, cleanup, and receipts

Every case uses a fresh sandbox under `~/dev/agentic-scratchpads/pi-claude-cli/<branch-leaf>/`, private host config/session directories, and a private `TMPDIR`. The branch leaf is sanitized (for example, `lane/verification` uses `verification`); `main` is the fallback. `PI_CLAUDE_E2E_SCRATCH_DIR` can select another directory under the project scratchpad root. Actual live/loading sandboxes use short `e-`/`l-` prefixes and a `t` transport subdirectory. Before any prompt, the harness asserts the eventual `pcc-cli-XXXXXX/host.sock` path fits Linux's 107-byte pathname capacity, without using a `/tmp` symlink. The same scratch root owns synthetic process-probe logs and prerequisite receipts. This follows the updated storage instruction; earlier `/tmp` loading results remain historical evidence, and the moved loading suite is checked separately. OMP profiles are cleared, its config path is relative to home as required by the installed host, and hashline edit mode is explicit. The host launch clears `BUN_BE_BUN`.

Default `claude-login` preserves the official `CLAUDE_CONFIG_DIR` location without reading/copying credentials. Competing Anthropic/cloud/auth-helper overrides are cleared. The official `claude auth status` preflight records only `loggedIn: true`; account/auth output is withheld. API key billing requires explicit `PI_CLAUDE_AUTH=api-key` and a key. The harness never records environment values or auth output.

Child PIDs and process start identities are sampled throughout the host lifetime. After aborts and final session reset, Claude children and private `pcc-cli-*` resources must disappear naturally while the actual host stays alive. Shutdown first closes stdin, then sends supported SIGTERM only to the host PID if needed. The host adapter must close its own children; harness signals to children would hide bridge leaks. Emergency group SIGKILL and direct child fallback signals remain safety cleanup and record the affected children. A successful case requires neither emergency host SIGKILL nor Claude children needing harness fallback cleanup. PID identities prevent cleanup from targeting reused PIDs. All sandbox files are removed in `finally`.

Receipts default to `<scratch-root>/receipts`; `PI_CLAUDE_E2E_RECEIPT_DIR` can override that directory within the project scratchpads. Files use mode 0600 and contain versions, launcher hash, Git revision, actual argv/commands, synthetic prompts, selected model/thinking, observed session/call IDs, native hashline arguments/file bytes, host usage statistics, assertions, cleanup, and failure status. Only public response headers and synthetic test tool/provider observations are recorded; host stderr and auth output are drained without persistence. Reported Claude USD estimates and budget limits aren't subscription billing measurements. A receipt marked failed is never feature-completion evidence.

Real model payload recordings remain a separate fixture gate. These receipts establish host assertions when actually run; the loading receipts and synthetic conformance fixtures cannot replace authenticated results.
