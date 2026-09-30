# Execution

Bead: `pcc-6se`. Scope: unsolicited OMP steering warning, source-backed Claude/T3 steering research, safe queued boundary steering, automated coverage and live delivery.

The empty-host-queue regression failed against the previous implementation with the exact `Claude cli: live steering unsupported; queued input stays with OMP` status. Removing the unconditional call made it pass. OMP's channel is present even when input isn't queued.

Pinned versions remain Pi 0.99.1, OMP 18.4.4, Claude 2.1.285 and SDK 0.3.285. Read-only scratch inspection also verified Claude 2.1.286/SDK 0.3.286; it doesn't universally join during-token input. See `docs/research/claude-steering.md`.

The first OMP/CLI harness attempt removed the warning and cleaned up naturally, but failed its distinctive hello system-prompt assertion before steering. The fixture now verifies actual host and provider system-prompt preservation and explicitly requires the prefix on greetings; assertions remain strict.

Three Pi/CLI attempts subsequently omitted the supplemental marker while retaining the original nonce/result and exact host/provider input. The last of those also proved matching native queued/started receipts. These remain failed behavioral receipts; the earlier captures don't establish whether native output itself lacked the marker. A later unchanged-runtime run passed with native stream/snapshot/result marker-presence instrumentation. No answer assertion was weakened.

Focused real-host runs have passed all four combinations. The final matrix against a committed source revision is still pending. Bounds are $0.25 per resident session, eight turns, 512 output tokens and 180 seconds per case.

The complete Linux offline gate passed 548 tests in 30 files, including pinned compiled OMP probes; coverage was 94.23% lines/statements, 97.29% functions and 89.38% branches against unchanged thresholds. All three typecheck profiles, lint, formatting, the original plan validator and 29 Node harness tests passed. Seven new boundary harness offline checks also passed. Package dry-run verified 0.4.2, both native entrypoints, the receipt helper and CLI MCP child, excluding tests, OpenSpec, Beads and node_modules.
