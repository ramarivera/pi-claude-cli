# Execution evidence

Bead: `pcc-9g6`. Request: implement the previously missing active-response input if T3Code provides it. Completed October 1, 2026.

Current clean T3Code reference `0cf482b08bca0249ec94fbcbd0eb04fff28d9b3d` accepts input into one resident query while a turn runs. Native omitted priority defaults to `next`; this doesn't establish arbitrary generation preemption. The same supported queue behavior is implemented through OMP's native channel, with a host-neutral core seam and matching CLI/SDK command receipts.

Native admission transfers the OMP claim once. The first completed assistant message gives the host a safe response boundary, preserving any actual parked tool boundary instead. The following host request must acknowledge the exact accepted messages in queue order and uses retained native continuation events without another prompt submission. Original native result events are separated from the queued correction using consumption/result attribution. Missing admission/consumption, changed accepted history, cancellation and buffered-event overflow fail explicitly. Unsent or late claims return to the host; owned pumps, timers, queries and files settle on shutdown.

Sol 6.1/high lanes owned separate core/driver and OMP adapter/test files. The coordinator reviewed the diff and ran the integrated gates and paid tests. No dependencies, CI workflow, package version or managed Toolbox configuration changed.

## Offline gates

- 585 Vitest tests passed in 31 files, with no skips and pinned compiled OMP probes enabled. The coordinator used one worker and scratch-owned coverage output.
- Coverage passed unchanged thresholds: 93.98% lines/statements, 89.90% branches, 97.44% functions.
- All three typecheck profiles, lint and the existing OpenSpec/Beads plan validator passed.
- New deterministic regressions cover admission/result races, buffered continuation without resubmission, multiple messages in queue order, mismatched accepted history, spurious empty wakeups, late claims, cancellation, admission deadlines, queued input alongside parked tools, overflow, explicit native UUID/priority/consumption and neutral host-content normalization.
- Node harness offline checks passed 47 tests, with six authenticated cases explicitly skipped. The separate authenticated matrix passed 24 checks with no skips (18 harness checks plus six real cases).
- Formatting initially reported the newly added test helper; it was formatted and the final gate rerun. No assertion or coverage threshold was weakened.

## Real host matrix

All six cases used actual native host RPC, official Claude login, real inference, and the production entrypoints. Versions: Pi 0.99.1, compiled OMP 18.4.4, Claude 2.1.285, SDK 0.3.285. Model: Sonnet 5.5. Bounds remained eight turns, 512 output tokens, $0.25 reported runtime budget per resident query, 180 seconds per case and owned scratch sandboxes. Reported costs aren't subscription billing measurements.

All receipts below match production SHA-256 `b02cdcc500d85a14d052b3ade61d4cde8fe03c1310da369340e249ee95676de5`, independently recomputed after the run. Their source Git parent was `0ff11704b9f20923e6384409a7790862085e3d57`; the fingerprint binds the actual production working tree rather than claiming its modified source was already committed.

| Case    | Behavior                                        | Receipt basename                      | Result |
| ------- | ----------------------------------------------- | ------------------------------------- | ------ |
| Pi CLI  | Existing native tool-boundary steering          | `boundary-pi-cli-1790817527200.json`  | Passed |
| Pi SDK  | Existing native tool-boundary steering          | `boundary-pi-sdk-1790817534884.json`  | Passed |
| OMP CLI | Existing native tool-boundary steering          | `boundary-omp-cli-1790817544734.json` | Passed |
| OMP SDK | Existing native tool-boundary steering          | `boundary-omp-sdk-1790817555733.json` | Passed |
| OMP CLI | Steering admitted during actual text generation | `active-omp-cli-1790817566922.json`   | Passed |
| OMP SDK | Steering admitted during actual text generation | `active-omp-sdk-1790817578259.json`   | Passed |

Receipts and logs are private files beneath `~/dev/agentic-scratchpads/pi-claude-cli/main/`. Matrix log: `active-six-matrix.log`; coverage log: `active-coverage.log`. The first representative OMP CLI active-input run also passed (`active-omp-cli-1790817479916.json`) with the same production fingerprint.

The coordinator independently checked every receipt's passed status, matching source fingerprint, one queued/started matching UUID in order, natural cleanup, no forced children, no emergency host kill, no survivors and no private transport files. Both active cases additionally established native admission before the original assistant message ended, exactly one correction marked `liveSteered`, zero tools/history errors, the requested corrected answer, stable host/model/Claude identity and a third prompt remembering the correction without rebuilding the query. All four boundary cases preserved one original tool/result, the nonce and the correction, with no unsolicited steering warning.

## Scope limits

This implements active queued input, matching T3Code's supported pattern. It doesn't request priority `now` or promise arbitrary token-generation preemption. Pi's pinned provider API has no corresponding active-input channel, so Pi retains its native boundary queue. OMP's pinned channel defers images before reaching the adapter; image normalization has deterministic coverage only. These are source RPC runs, not tests of a newly installed npm release. The previously installed 0.4.3 artifact wasn't modified or republished by this task. Earlier unrelated Opus and dependency-history issues retain their existing trackers.
