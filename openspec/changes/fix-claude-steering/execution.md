# Execution

Bead: `pcc-6se`. Scope: unsolicited OMP steering warning, source-backed Claude/T3 steering research, safe queued boundary steering, automated coverage and live delivery.

The empty-host-queue regression failed against the previous implementation with the exact `Claude cli: live steering unsupported; queued input stays with OMP` status. Removing the unconditional call made it pass. OMP's channel is present even when input isn't queued.

Pinned versions remain Pi 0.99.1, OMP 18.4.4, Claude 2.1.285 and SDK 0.3.285. Read-only scratch inspection also verified Claude 2.1.286/SDK 0.3.286; it doesn't universally join during-token input. See `docs/research/claude-steering.md`.

The first OMP/CLI harness attempt removed the warning and cleaned up naturally, but failed its distinctive hello system-prompt assertion before steering. The fixture now verifies actual host and provider system-prompt preservation and explicitly requires the prefix on greetings; assertions remain strict.

Three Pi/CLI attempts subsequently omitted the supplemental marker while retaining the original nonce/result and exact host/provider input. The last of those also proved matching native queued/started receipts. These remain failed behavioral receipts; the earlier captures don't establish whether native output itself lacked the marker. A later unchanged-runtime run passed with native stream/snapshot/result marker-presence instrumentation. No answer assertion was weakened.

Focused real-host runs have passed all four combinations. The final matrix at committed source `f60ab3b` ran all four Haiku 4.5 cases. OMP/CLI passed; Pi/CLI, Pi/SDK and OMP/SDK failed the supplemental answer marker while exact input, matching native queued/started receipts, tool/result preservation, session identity and natural cleanup passed. The Pi native stream, snapshots and result also lacked the marker, ruling out host projection loss in those captures. These remain failed behavioral receipts; publication is held. The steering harness is moving to Sonnet 5.5 with an unambiguous final-answer update, retaining every ownership/receipt/marker assertion and budget cap. Bounds are $0.25 per resident session, eight turns, 512 output tokens and 180 seconds per case.

The Sonnet 5.5 source cases passed for both hosts and both drivers. OMP CLI/SDK receipts are `boundary-omp-cli-1790807741906.json` and `boundary-omp-sdk-1790807754061.json`. Pi initially stopped before inference because its native capability API clamps Sonnet's requested `off` thinking to `low`; the harness now derives that level through the pinned Pi API. Pi CLI/SDK then passed (`boundary-pi-cli-1790807814630.json`, `boundary-pi-sdk-1790807828163.json`). Every case proved matching queued/started receipts, the supplemental answer marker, the original tool result once, unchanged session identity and natural cleanup. Failed Haiku and preflight receipts remain available; they aren't counted as passes.

Actual OMP asynchronous provider-close failures now use `api.logger.error` and `ctx.ui.notify(..., "error")`, with a regression proving that the cleanup status line isn't used.

The final complete Linux offline gate passed 549 tests in 30 files, including pinned compiled OMP probes; coverage was 94.23% lines/statements, 97.29% functions and 89.32% branches against unchanged thresholds. All three typecheck profiles, lint and formatting passed. The original plan validator and 29 Node harness tests passed earlier; ten boundary harness offline checks pass. Package dry-run verified 0.4.2, both native entrypoints, the receipt helper and CLI MCP child, excluding tests, OpenSpec, Beads and node_modules. Installed boundary verification is pending publication and exact managed pin deployment.
