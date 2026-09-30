# Actual host RPC verification

`tests/e2e/live.test.mjs` defines four authenticated cases: Pi + CLI, Pi + SDK, OMP + CLI, and OMP + SDK. Every case loads the production entrypoint directly into the actual host RPC process. The additional native extension registers only the sentinel, cancellable slow tool, and observations; it doesn't replace the runtime, driver, provider, or inference.

At `b40ee2b`, the normal matrix passed all seven phases for Pi + CLI, Pi + SDK and OMP + SDK with natural cleanup. OMP + CLI failed the unchanged exactly-one-edit assertion: an invalid first patch produced a native error, then a distinct second call corrected it and completed the edit/sentinel round. Error/result recovery worked without duplicate call IDs, but that failed receipt doesn't satisfy the strict case. The selected standard OMP + CLI retry then passed all seven phases at the same revision. All four standard cases now satisfy acceptance. The verification lane ran no inference.

The acceptance evidence below comes from the standard harness with unchanged prompts, bounds and assertions. The four-case finish condition can combine a normal matrix and selected standard retry at the same reviewed production revision; it doesn't claim one matrix invocation passed all four. Scratch traces with an extra observer remain separate historical diagnostics.

| Standard case | Revision  | Run                     | Receipt under `main/receipts/` | Acceptance                        |
| ------------- | --------- | ----------------------- | ------------------------------ | --------------------------------- |
| Pi + CLI      | `b40ee2b` | Normal matrix           | `pi-cli-1790786436736.json`    | All seven phases; natural cleanup |
| Pi + SDK      | `b40ee2b` | Normal matrix           | `pi-sdk-1790786461300.json`    | All seven phases; natural cleanup |
| OMP + CLI     | `b40ee2b` | Selected standard retry | `omp-cli-1790786733901.json`   | All seven phases; natural cleanup |
| OMP + SDK     | `b40ee2b` | Normal matrix           | `omp-sdk-1790786510491.json`   | All seven phases; natural cleanup |

All four accepted receipts use `actual-authenticated-host-rpc` provenance, official `claude-login` with preflight `loggedIn: true`, the recorded Pi 0.99.1 / compiled OMP 18.4.4 and Claude CLI 2.1.285 / SDK 0.3.285 versions, exact Haiku model and thinking off. Each submits seven prompts and establishes semantic system-marker/text checks, one canonical sentinel execution/result, resident identity, replay under a fresh authoritative Claude ID, actual streaming and native-tool aborts with no delayed effects, post-abort completion, and natural lifecycle/process cleanup. Both OMP cases additionally establish one successful native read/hashline edit and exact replacement bytes. None of the host processes needed emergency SIGKILL or child fallback; no owned processes survived the coordinator's PID/start-identity audit.

The preceding selected standard SDK case also passed (`omp-sdk-1790786375240.json`). The failed matrix CLI receipt is `omp-cli-1790786478851.json`; it retains both distinct edit attempts and natural cleanup. Receipts live under `~/dev/agentic-scratchpads/pi-claude-cli/main/receipts/`.

Actual loading passed all four combinations with Pi 0.99.1 and compiled OMP 18.4.4: custom provider/model selection, explicit thinking off, extension loading, retry/compaction controls, and native OMP hashline `{ input }` schema. Loading doesn't establish authentication, resident Claude behavior, tool execution, restoration, or abort behavior. Reviewed receipt paths and current integrated gates are recorded in [the execution log](../../openspec/changes/modernize-claude-runtime/execution.md).

## Commands

Offline Node harness gates, with no inference:

```nu
node --test tests/e2e/harness.test.mjs
node --test tests/e2e/live.test.mjs
npm run test:live
```

The direct disabled runner explicitly skips four named cases. The package runner prints the four skipped combinations. The 24 Node harness checks verify those skips, enabled missing-prerequisite failure, invalid selection failure, auth environment isolation, native completion framing, and cancellation cleanup. Its RPC parser and child ownership fixtures are explicitly synthetic unit tests. Child ownership cases distinguish graceful owner shutdown from a leaked child needing direct fallback and an unresponsive host requiring emergency group SIGKILL.

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

The fixture-specific hashline proof accepts paired Begin/End Patch wrappers or their omission: installed OMP 18.4.4's native `editInspect("hashline", ...)` accepts both forms, and the actual SDK receipt showed an unwrapped successful edit. It still requires one successful native read, one completed edit with its matching execution ID and `{ input }` arguments, the exact line-1 replacement operation, the snapshot tag from that read, and exact `replacement\n` file bytes. Grammar unit regressions reject mismatched tags, invalid operations, incomplete wrappers, Pi-style arguments, failed or uncorrelated execution and unchanged bytes. Sentinel execution/result correlation remains independently asserted.

The initial text instruction is `No tools. Follow the system-required prefix, then reply with READY.` The final instruction uses `AFTER_ABORT` in the same wording. Neither user prompt includes the distinctive system marker. This avoids conflicting exact-answer instructions while preserving the assertion that the response includes the effective system-required marker and the expected reply.

The exact observed model is `claude-haiku-4-5-20251001` under `pi-claude-cli`, with thinking explicitly off. Official Claude 2.1.285 initialize metadata doesn't advertise effort support for Haiku. Bounds are eight turns, 512 output tokens, $0.25 reported query-budget limit, 15 seconds for host tool results, three seconds for driver shutdown, and 180 seconds wall time per case. Every RPC wait/send checks the case deadline and Node test context AbortSignal; failure exits through awaited cleanup. The 210-second Node timeout leaves room for cleanup. Native cache warming is stopped by the observer; RPC disables automatic retry and compaction.

The eight-turn bound is conservative: installed SDK 0.3.285 `sdk.d.ts` describes `maxTurns` as a query conversation-turn limit without promising reset per submitted input. The [official streaming input example](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode) uses one persistent query for multiple messages with an explicit turn bound. This harness retains a bound large enough for resident native read/edit/sentinel rounds rather than depending on an undocumented per-input reset.

## Isolation, cleanup, and receipts

Every case uses a fresh sandbox under `~/dev/agentic-scratchpads/pi-claude-cli/<branch-leaf>/`, private host config/session directories, and a private `TMPDIR`. The branch leaf is sanitized (for example, `lane/verification` uses `verification`); `main` is the fallback. `PI_CLAUDE_E2E_SCRATCH_DIR` can select another directory under the project scratchpad root. Actual live/loading sandboxes use short `e-`/`l-` prefixes and a `t` transport subdirectory. Before any prompt, the harness asserts the eventual `pcc-cli-XXXXXX/host.sock` path fits Linux's 107-byte pathname capacity, without using a `/tmp` symlink. The same scratch root owns synthetic process-probe logs and prerequisite receipts. This follows the updated storage instruction; earlier `/tmp` loading results remain historical evidence, and the moved loading suite is checked separately. OMP profiles are cleared, its config path is relative to home as required by the installed host, and hashline edit mode is explicit. The host launch clears `BUN_BE_BUN`.

Default `claude-login` preserves the official `CLAUDE_CONFIG_DIR` location without reading/copying credentials. Competing Anthropic/cloud/auth-helper overrides are cleared. The official `claude auth status` preflight records only `loggedIn: true`; account/auth output is withheld. API key billing requires explicit `PI_CLAUDE_AUTH=api-key` and a key. The harness never records environment values or auth output.

OMP 18.4.4 also treats a nonempty `CLAUDE_CONFIG_DIR` as an opt-in to foreign Claude discovery in [`isUserSourceEnabled`](https://unpkg.com/@oh-my-pi/pi-coding-agent@18.4.4/src/capability/index.ts); [`getUserClaude`](https://unpkg.com/@oh-my-pi/pi-coding-agent@18.4.4/src/discovery/claude.ts) then imports that directory's MCP configuration. The sandbox's native `--config` overlay sets [`disabledProviders`](https://unpkg.com/@oh-my-pi/pi-coding-agent@18.4.4/src/config/model-settings.ts) to `claude` and `claude-plugins`, and [`mcp.enableProjectConfig`](https://unpkg.com/@oh-my-pi/pi-coding-agent@18.4.4/src/mcp/settings.ts) to false. Inherited `PI_CONFIG_FILES` overlays are cleared. This isolates native host discovery while retaining official Claude login, the explicit production extension, the sentinel/slow extensions, and native read/hashline edit tools. Four loading checks passed with this overlay; both OMP receipts observed only their host PID and required no fallback cleanup. No Claude inference runs during loading.

Child PIDs and process start identities are sampled throughout the host lifetime. After aborts and final session reset, Claude children and private `pcc-cli-*` resources must disappear naturally while the actual host stays alive. Shutdown first closes stdin, then sends supported SIGTERM only to the host PID if needed. The host adapter must close its own children; harness signals to children would hide bridge leaks. Emergency group SIGKILL and direct child fallback signals remain safety cleanup and record the affected children. A successful case requires neither emergency host SIGKILL nor Claude children needing harness fallback cleanup. PID identities prevent cleanup from targeting reused PIDs. All sandbox files are removed in `finally`.

Receipts default to `<scratch-root>/receipts`; `PI_CLAUDE_E2E_RECEIPT_DIR` can override that directory within the project scratchpads. Files use mode 0600 and contain versions, launcher hash, Git revision, actual argv/commands, synthetic prompts, selected model/thinking, observed session/call IDs, native hashline arguments/file bytes, host usage statistics, assertions, cleanup, and failure status. Only public response headers and synthetic test tool/provider observations are recorded; host stderr and auth output are drained without persistence. Reported Claude USD estimates and budget limits aren't subscription billing measurements. A receipt marked failed is never feature-completion evidence.

Loading receipts use `actual-host-rpc-no-inference` provenance and include selection, RPC commands, failure status, and cleanup identities. Process diagnostics retain only PID, native process name, parent PID, state, and start identity; they don't collect process argv or environment. This distinguishes imported native MCP helpers from Claude driver resources without attributing loading-only children to a driver query.

Response diagnostics retain synthetic assistant text, stop reason, public error and numeric usage/cost even when a semantic assertion fails. Local native `message_end` frames survive case cancellation or an unavailable RPC read; bounded optional `get_messages` and `get_session_stats` reads supplement them when possible. Native public `before_agent_start` and `before_provider_request` hooks report only effective system-prompt availability, marker presence, length and part count. They never record full system prompts, credentials or arbitrary provider payloads. This distinguishes model obedience from prompt propagation without weakening either assertion.

The OMP observer subscribes to the native `pi-claude-cli:observation` progress bus and the separate `pi-claude-cli:diagnostic` bus. The dedicated `native-diagnostic` timeline contains only the four accepted message-start, message-stop, assistant-snapshot and actual MCP-park subtypes. An independent explicit whitelist retains valid IDs (128 characters maximum, no control characters), known block types, Boolean completion flags, nonnegative integer counts, bounded host/session attribution and nested runtime boundary lists (32 items maximum). Runtime state includes unended messages, proposal IDs, unparked proposals, actual parked IDs and delivered IDs. No raw spreads, text, tool argument values, schemas, arbitrary observation data or auth fields cross this observer. The existing ordered observations flow includes that timeline in failed receipts as well as successful ones.

The accepted serialized dispatch correction lets a completed authoritative batch with at least one real MCP park matching the completed ID, name and arguments expose the host tool round. Core buffers other completed-proposal results until later actual handlers park and ID/name/arguments validate; released late calls aren't projected as new native tool proposals. SDK handlers never report early fabricated success, and only actual MCP parking emits `host_tool_request`. Bounded timers, cancellation, ownership, completed-proposal correlation and exactly-once settlement stay required. Fresh deterministic regressions and all four same-revision standard cases passed, including the selected CLI retry. The accepted live SDK runs used separate edit/sentinel messages; the serialized-batch ordering specifically has deterministic regression coverage and the historical failed trace.

The current synthetic and initialize-recording fixture scope is complete. Optional future raw assistant/tool recordings would extend it. Live receipts establish host assertions only when actually run; loading receipts and deterministic conformance fixtures can't replace authenticated results.

## Queued boundary steering

`npm run test:steering` runs the boundary harness's offline fixture checks and
skips authenticated cases by default. Opt in to a selected actual host/driver
case with Nushell:

```nu
with-env { PI_CLAUDE_BOUNDARY_E2E: "1", PI_CLAUDE_BOUNDARY_CASE: "omp+cli" } {
  npm run test:steering
}
```

The other selections are `omp+sdk`, `pi+cli` and `pi+sdk`; omit the case variable
to run all four. Each case uses one resident Claude session capped at $0.25 in
reported runtime cost, eight turns and 512 output tokens per response. It sends
a literal hello, then holds a native `pcc_gate` tool behind an owned release
marker, queues an RPC steer while that tool runs, and releases its original
result. Assertions preserve the original nonce/result exactly once, the
supplemental instruction, session/model identity and natural transport cleanup.
OMP's real `ctx.ui.setStatus` is observed to catch the unsolicited-warning bug.
Receipts retain only bounded IDs, counts and marker-presence booleans, including
failed semantic checks; no prompt or assistant text is persisted by this suite.
This exercises host tool-boundary steering, not immediate during-token input
through OMP's `LiveSteering.claim()`.
