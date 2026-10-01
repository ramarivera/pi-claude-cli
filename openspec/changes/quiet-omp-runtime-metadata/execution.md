# Execution evidence

Beads: `pcc-22n`, `pcc-tvo`. October 1, 2026.

## Reproductions and fixes

The reported `Claude status: thinking_tokens [turnId=…]` was a native extension status, not leaked subprocess stdout. Both installed 0.4.3 and current source sent routine observations through `ctx.ui.setStatus`; OMP 18.4.4's actual FooterComponent renders it as an extra plain row after its status bar. The earlier authenticated observer watched only the steering key and missed the runtime progress key.

The root's first focused regression failed seven cases on real adapter status calls. A compiled native footer probe reproduced the exact thinking event with installed 0.4.3. The repaired path renders no extension row, writes routine metadata to OMP's actual file logger, retains the observation bus and preserves genuine cleanup error logging/notifications. Logger records whitelist attribution IDs and omit raw payload/text, unknown fields, oversized IDs and control characters. Both status keys are now observed during authenticated cases, even though RPC hides the footer.

OMP's native async-result builder emits an agent-attributed custom notification; convertToLlm turns it into developer input. Image notifications split into developer text then user image. The adapter rejected trailing developer input and lost preceding notification text for image splits. Two request regressions reproduced that failure before the fix. Accepting developer alone would still break resident history because the core previously acknowledged input as one user message. Neutral ordered prompt messages now retain host roles and pending-tail order while the official Claude wire accepts user content. Tool results interleaved before/after notifications retain their actual correlation and exactly-once delivery. Hook edits must preserve ordered roles and coherent content.

Sol 6.1/high agents owned disjoint native-footer and request/core lanes. The root reviewed their changes and ran the integrated checks and paid cases. No dependencies or CI workflows changed.

## Integrated offline gates

- 608 Vitest tests passed in 33 files, with pinned compiled OMP probes enabled and no skips.
- Unchanged coverage thresholds passed: 94.10% lines/statements, 90.10% branches, 97.46% functions.
- All three typecheck profiles, lint, formatting, OpenSpec/Beads plan verification and strict new-change validation passed.
- The combined Node harness passed 47 offline checks, with eight authenticated cases explicitly skipped.
- Native no-inference OMP Agent tests used the actual async-result builder/converter and Agent.continue for text and image notifications, followed by an ordinary prompt. Core regressions established one resident open and exact parked-result delivery for both notification/result orders.
- An existing conformance double lacked the native logger's debug method. Its fixture was completed without weakening assertions; all 12 production-driver/native-boundary cases passed.

## Authenticated source cases

All eight paid source cases passed against production SHA-256 `bdf8a911ff61df0249c893b238c77151fb6d72fd066a9681ebd540486a18e03f`. The root independently re-parsed every receipt, recomputed the fingerprint, and checked natural cleanup with no forced child shutdown, emergency host kill, survivors or private transport files. Versions remained Pi 0.99.1, OMP 18.4.4, Claude 2.1.285 and SDK 0.3.285.

Two actual OMP source smokes (CLI and SDK) ran native read/sentinel tools and a real native background bash job. The controller held the job until the foreground answer ended, then released it. Each produced exactly one native async-result notification, answered it, remembered it on a subsequent prompt, retained the resident Claude query and sent zero runtime status rows. Model: Haiku 4.5. This exercises the real shared async-job delivery pipeline; it doesn't claim to have rerun the user's NuBreakingResearch task.

- `source-smoke-omp-cli-1790821505749.json`
- `source-smoke-omp-sdk-1790821575988.json`

All six steering cases also passed: four native Pi/OMP CLI/SDK tool-boundary cases and two OMP active-input cases. They retained queue admission/consumption, original tools/results and resident follow-up while observing both status keys. Model: Sonnet 5.5. Active input uses next delivery rather than arbitrary generation preemption.

Receipts and logs remain under `~/dev/agentic-scratchpads/pi-claude-cli/main/`; source matrix log `044-source-steering.log`, background logs `044-source-background-cli.log` and `044-source-background-sdk.log`, offline gate `044-coverage.log`. The pending active-input implementation from `e635a7f` is included in 0.4.4.

## Delivery

Release metadata is prepared for 0.4.4. Publication, exact managed pins, materialization and authenticated installed checks are pending. Existing interactive processes haven't been restarted or sent desktop input.
