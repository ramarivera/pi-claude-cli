# Active input research

Tracked by `pcc-9g6`. Checked October 1, 2026.

T3Code was refreshed from `https://github.com/pingdotgg/t3code.git` without destructive operations. Clean HEAD and origin/HEAD matched `0cf482b08bca0249ec94fbcbd0eb04fff28d9b3d`.

## Condition holds for accepting queued input during generation

T3Code's [persistent prompt queue](https://github.com/pingdotgg/t3code/blob/0cf482b08bca0249ec94fbcbd0eb04fff28d9b3d/apps/server/src/provider/Layers/ClaudeAdapter.ts#L4458) feeds one SDK query. Its [active sendTurn path](https://github.com/pingdotgg/t3code/blob/0cf482b08bca0249ec94fbcbd0eb04fff28d9b3d/apps/server/src/provider/Layers/ClaudeAdapter.ts#L5184) retains the current real turn ID and offers another user message immediately to that queue. [Message construction](https://github.com/pingdotgg/t3code/blob/0cf482b08bca0249ec94fbcbd0eb04fff28d9b3d/apps/server/src/provider/Layers/ClaudeAdapter.ts#L1574) supplies neither priority nor a steering UUID. This is active input acceptance, with no adapter request for arbitrary token-generation preemption.

The native Claude 2.1.285 queue defaults omitted priorities to `next`: scratch `steering-research/bundle-202925270.js:157`, character offset 4813. `bundle-210881888.js:48`, offsets around 66475 and 68436, checks next-priority commands after a tool batch, absorbs delivered commands into a continuation and emits the matching `started` receipt. `now` has a separate controller-abort path. No dependency upgrade is necessary for active queue acceptance.

## Native host ownership needs additional handling

T3's [steering test](https://github.com/pingdotgg/t3code/blob/0cf482b08bca0249ec94fbcbd0eb04fff28d9b3d/apps/server/src/provider/Layers/ClaudeAdapter.test.ts#L1627) manually emits an adjusted response through a fake query. It isn't live consumption evidence. Its adapter [ignores command_lifecycle](https://github.com/pingdotgg/t3code/blob/0cf482b08bca0249ec94fbcbd0eb04fff28d9b3d/apps/server/src/provider/Layers/ClaudeAdapter.ts#L4182), and [clears the active turn](https://github.com/pingdotgg/t3code/blob/0cf482b08bca0249ec94fbcbd0eb04fff28d9b3d/apps/server/src/provider/Layers/ClaudeAdapter.ts#L2865) on a matching native result. Its result filters don't establish consumption of queued UUID-less corrections.

OMP 18.4.4 LiveSteering claims transfer server ownership on accept. The [native channel](https://unpkg.com/@oh-my-pi/pi-agent-core@18.4.4/src/live-steering.ts) records accepted input after the current host response and uses it as continuation input. That input must be recognized by the resident bridge without a second Claude submission. Every claim must be settled exactly once; unsent claims are rejected, and uncertain admission invalidates the owned session explicitly.

Pi 0.99.1 has no provider active-input channel corresponding to OMP's LiveSteering. It continues to use its native queued boundary handoff. Shared DTOs don't contain either host's API types.

## Verification plan

The actual OMP CLI and SDK cases submit RPC steering after a real text delta. They require matching queued/started native UUIDs, admission before the original assistant message ends, exactly one native history correction marked liveSteered, a corrected answer, no tools or history errors, stable host/model/Claude identities, a resident follow-up remembering the correction and natural cleanup. The existing real four-way boundary matrix verifies the parked-tool fallback and result ownership. Deterministic regressions additionally exercise races and failures without inference cost.
