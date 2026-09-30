# Claude steering: transport, timing, and limits

Research for `pcc-6se`, checked September 30–October 1, 2026. The supported fix is steering at a parked host-tool boundary: queue the user's correction, wait for native queue admission, then release the outstanding MCP results. It doesn't implement immediate input through OMP's `LiveSteering` channel.

## The warning and the actual capability

OMP supplies a `LiveSteering` object even when it contains no input. The adapter previously used that object's presence to display an unconditional steering warning, so ordinary prompts showed the warning. Removing that status fixes the misleading UI; it doesn't establish that queued input reaches Claude. Capability checks belong on actual submitted steering content.

The host-neutral driver capability distinguishes `unsupported`, `tool-boundary`, and `live`. This change advertises `tool-boundary`. A correction attached to host-tool results reaches the resident Claude turn before those results are released. Arbitrary input during token generation through OMP's immediate channel remains outside this guarantee.

## T3Code's precedent

T3Code was read at clean default-branch commit `d5980a0ff1511e6ae1f1876406a7c45a7a989cdb`. It declares SDK `^0.3.276` and [locks `0.3.276`](https://github.com/pingdotgg/t3code/blob/d5980a0ff1511e6ae1f1876406a7c45a7a989cdb/pnpm-lock.yaml#L511), older than our pinned `0.3.285`.

Its [persistent prompt queue](https://github.com/pingdotgg/t3code/blob/d5980a0ff1511e6ae1f1876406a7c45a7a989cdb/apps/server/src/provider/Layers/ClaudeAdapter.ts#L4425) feeds one SDK query. [Mid-turn `sendTurn`](https://github.com/pingdotgg/t3code/blob/d5980a0ff1511e6ae1f1876406a7c45a7a989cdb/apps/server/src/provider/Layers/ClaudeAdapter.ts#L5151) retains the real turn ID and queues another user message without setting priority or interrupting. [Tool-result events](https://github.com/pingdotgg/t3code/blob/d5980a0ff1511e6ae1f1876406a7c45a7a989cdb/apps/server/src/provider/Layers/ClaudeAdapter.ts#L3173) update in-flight tools; a native result [completes and clears the active turn](https://github.com/pingdotgg/t3code/blob/d5980a0ff1511e6ae1f1876406a7c45a7a989cdb/apps/server/src/provider/Layers/ClaudeAdapter.ts#L2843). There isn't a host-MCP result-release barrier or a pending-steer acknowledgement protecting that completion.

Its [steering test](https://github.com/pingdotgg/t3code/blob/d5980a0ff1511e6ae1f1876406a7c45a7a989cdb/apps/server/src/provider/Layers/ClaudeAdapter.test.ts#L1560) uses a fake query and manually emits an adjusted response. It proves turn bookkeeping, not native input consumption, tool-result ordering, or preemption. The [capability probe](https://github.com/pingdotgg/t3code/blob/d5980a0ff1511e6ae1f1876406a7c45a7a989cdb/apps/server/src/provider/Layers/ClaudeProvider.ts#L319) never yields a prompt, so it can't validate steering either.

## Why `next` and a native receipt matter on 0.3.285

The installed SDK declares user-message priorities `now`, `next`, and `later`. Its `streamInput` writes each message unchanged; that persistent input consumer already runs for our query. A second finite `streamInput` invocation would end stdin when its iterable finishes.

Claude Code `2.1.285` subscribes to queued `now` commands and aborts the active turn controller. Sending `now` while a host MCP call is parked can therefore cancel the call or produce an interrupted result before its real tool result is committed. Use `next`, retaining the active turn identity, for this boundary.

An awaited transport write establishes only that bytes were written. The native command queue emits `command_lifecycle` with the supplied UUID and state `queued` after enqueueing. The fix waits for that receipt before releasing MCP results. This is a guarded protocol extension of the pinned runtime, absent from the public `SDKMessage` union; it isn't a stable public SDK guarantee. Missing admission must fail explicitly rather than silently release results.

Extracted `2.1.285` evidence under `~/dev/agentic-scratchpads/pi-claude-cli/steering-research/`: `bundle-221032580.js:12`, character offset `57743`, emits the queued receipt; line 18, offset `153593`, aborts for priority `now`. Offsets are zero-based characters in the extracted UTF-8 JavaScript.

## Why upgrading alone doesn't establish safe live steering

The [official SDK 0.3.286 changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md#03286) says human `now` input backgrounds running shell commands, agents, and MCP calls and joins the running turn. Extracted Claude Code `2.1.286` source shows conditions: UUID, running turn, eligible human prompt, pending tools, and an enabled delivery path. Eligible input is temporarily demoted to `next`; declined delivery promotes it back to `now`. The original abort watcher remains, including cases without pending tools during token generation.

Evidence in scratch `steering-research/runtime-2.1.286/`: `bundle-222253114.js:22`, offsets `172188` (conditional interception) and `167671` (abort watcher). `bundle-236131561.js:11` implements MCP `backgroundNow`: the foreground caller gets a synthetic background-task result while the original operation stays alive and later sends a notification. That changes the result lifecycle our bridge must reconcile; it doesn't preserve a single foreground result automatically.

## Accuracy and remaining limits

[Official streaming-input docs](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode) establish persistent sessions and sequential queued input. The timing conclusions above additionally depend on version-specific runtime source. T3's fake tests and source inspection aren't live behavioral evidence. The fix requires focused receipt/order/finalization tests and an actual host-tool steering run; it doesn't claim that an SDK upgrade supplies safe immediate OMP steering during every execution phase.
