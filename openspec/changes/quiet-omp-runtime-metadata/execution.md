# Execution evidence

Beads: `pcc-22n`, `pcc-tvo`, `pcc-6vb`, `pcc-k4z`. October 1, 2026.

## Latest working-tree repairs and audit

The evidence below for the earlier eight paid checks predates the newest tool-inventory and cache repairs. It doesn't validate the final fingerprint.

The native host prompt referred to `edit`/`write` while Claude callable names were `mcp__host__edit`/`mcp__host__write`. Both drivers now preserve the native prompt as an exact prefix and append a stable explicit map containing only exposed tools and configured built-ins. Four driver boundary regressions first reproduced the missing map, then passed. The new paid discovery matrix uses actual native default prompts, requests read/edit/write without wire names or supplied edit grammar, and asserts successful native execution plus exact file bytes without shell fallback.

An independent Sol 6.1/high audit compared both drivers and history/cache accounting with pinned BB and T3Code references. It found an OMP redacted-thinking round-trip mismatch; the root's native-hook investigation also reproduced a shared-core acknowledgement failure after native tool-argument revision. The native OMP Agent probe, using installed 0.4.3's core, opened `fresh` then `replay`. With the repair it retained one resident session through two actual native dispatches and a later user prompt for both driver profiles. These are scripted Claude packets and real native OMP dispatch/conversion, not paid inference. The reviewer independently checked the narrowly scoped argument-revision logic and all 13 new core regressions. OMP opaque-data snapshot/stream tests and an actual Pi normalizeContext round trip passed without changing Pi's representation.

The actual installed long-conversation interval repeatedly read 69,790 tokens while single-step cache writes grew to 128,125. This is a serious cache-performance signal, not healthy reuse established by positive counters. Its full cause can't be inferred from the host JSONL because native reopen reasons and raw per-step packets weren't retained. The two confirmed bugs are fixed in source; no claim is made that they explain every miss. See [public audit](../../../docs/research/claude-session-cache.md). Scratch independent report, redacted metadata extractor and probes remain under the main scratchpad, without publishing private transcript content.

Current production fingerprint: `dbc8577fa272c02d993d62a625adad73fdc624d3db72793eae9449a76ae35f49`.

- 629 Vitest tests passed in 34 files with compiled OMP native probes enabled, no skips; unchanged coverage gates passed at 94.26% lines/statements, 90.38% branches and 97.48% functions. Log: `044-cache-final-coverage.log`.
- All three typecheck profiles, lint and formatting passed after the final source changes. Strict OpenSpec validation and the original implementation-plan validator passed.
- Combined Node harness: 29 offline passes and 12 explicit skips (four loading opt-ins plus eight paid discovery/cache cases), no failures. Log: `044-cache-final-node.log`. Separate actual no-inference loading passed all four native Pi/OMP × CLI/SDK cases with no skips; log `044-cache-final-loading.log` and matching `loading-*` receipts.
- The new cache matrix measures four actual native turns with a large synthetic prefix, including one native hook rewrite. It requires two no-tool warm turns to report a nonshrinking cached prefix and small cache writes, plus stable Claude identity and exact correlated execution. Its live final-fingerprint matrix remains pending.

Four paid discovery attempts failed before tool execution: three explicit Anthropic session-limit errors and one explicit third-party extra-usage requirement. They remain failed receipts, not skipped or passed validation. Receipts: `source-discovery-pi-cli-1790822370113.json`, `source-discovery-pi-sdk-1790822375190.json`, `source-discovery-omp-cli-1790822381264.json`, `source-discovery-omp-sdk-1790822388048.json`; log `044-tool-discovery-source.log`. Authentication was logged in, but that didn't establish available inference quota. No alternate credentials, spending settings or auth mode were selected to bypass this limit.

The final-fingerprint OMP CLI cache test was also attempted and failed on its first request with `You've hit your session limit · resets 6:20am (Europe/Berlin)`, zero input/output/cache tokens and zero tools. Receipt `source-cache-omp-cli-1790824363360.json`, log `044-cache-source-omp-cli.log`; natural cleanup required no forced kill and left no survivors. The three unselected cases were explicitly skipped, not claimed as attempted.

Publication 0.4.4, managed pins/materialization and installed authenticated checks remain blocked on successful current-source live gates. Installed/managed version remains 0.4.3; no interactive processes were restarted.

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

### Authorized publication and managed deployment, October 1 morning

Ramiro explicitly requested publication and the managed bump after the incomplete validation report. That lifted the publication hold; it didn't turn failed checks into passes. Annotated tag `v0.4.4` resolves to `73a9a811d9680608634b52830489c9e396378f36`. Existing trusted workflow run `36843550915` passed Linux/macOS/Windows release gates, published through OIDC and created the GitHub release. Registry `latest` is 0.4.4. Downloaded artifact SHA-512 equals the local/tag package, and the provenance subject/workflow/source commit matches. Integrity: `sha512-1E5L0jggF7sZxusvXO08+/curOBwzCnT6hj/IlLuR7GVy3tJaWKuMhM8+/M+c+Mq0rdAA2swYNRYXk9PIaHwBw==`.

The morning source discovery rerun passed Pi CLI and both OMP drivers; Pi SDK was explicitly rejected with Anthropic's third-party extra-usage 400. The initial cache rerun exposed an E2E fixture bug: Claude doubled a newline escape in the requested printf command, preventing the exact native rewrite hook from firing. The test now uses simple synthetic echo commands, preserving every assertion and changing no production bytes. Corrected source cache checks passed Pi CLI and both OMP drivers; Pi SDK again failed with the explicit extra-usage response. These don't establish the complete cause of the user's original large trace.

Targeted Chezmoi diff contained only this package's two version pins. Targeted apply preserved normal partial-apply hooks. Full host trees and locks were backed up before materialization. Both installed extension fingerprints equal `dbc8577fa272c02d993d62a625adad73fdc624d3db72793eae9449a76ae35f49`, with unchanged production/peer dependencies. Pi preserved 56,181 unrelated node_modules files; OMP preserved 36,089 plus 701 nested extension dependency files. Managed settings/manifests/controller locks agree on 0.4.4 and OMP is enabled. No user interactive process was restarted.

Actual installed OMP CLI/SDK managed smokes passed native discovery, correlated tools, real background bash completion, resident notification recall and zero runtime/steering footer rows. The installed native FooterComponent/logger regression passed separately. Installed Pi CLI managed smoke passed tool inference, though its broad host cleanup killed native helper descendants; don't describe it as entirely natural cleanup. Installed Pi SDK also completed read/sentinel inference but the broad post-baseline descendant check timed out after new_session. That cleanup investigation is `pcc-oc0`; no Claude leak is established without exact process ownership classification. Actual no-inference loading passed four source-entrypoint cases; the loading harness has no installed selector, so those receipts don't establish installed loading by themselves.

Installed warm-cache checks passed Pi CLI and both OMP drivers, with one native hook argument revision and one resident Claude identity across four turns. Warm/after-hook cache reads were OMP CLI 37,075/37,764 with writes 155/303; OMP SDK 37,022/37,636 with writes 124/316. Each OMP cache case cleaned up naturally without forced shutdown or survivors. Source and installed paid receipts, verification scripts and full backups remain under `main/` scratchpads; logs use `044-publish-*`, `044-installed-*` and `044-registry-verification.log`.

Toolbox template gate passed 89/89, skill registry passed, and focused OMP/Pi configuration tests passed with exact 0.4.4 assertions. The full Nushell suite exposed two stale version assertions (updated) and unrelated failures. Thirteen unrelated failures reproduced against committed HEAD; a tms pane-output failure passed its focused rerun. The detached baseline also exposed a path-dependent ASFA expectation. Investigation is tracked as `toolbox-1dm`; the full Toolbox suite isn't claimed green. No hook or test was bypassed.

Remaining validation: the complete Pi SDK discovery/cache matrix and managed cleanup, plus causal verification of the user's original long conversation. Publication and installation are delivered under the user's explicit instruction; those investigations stay open.
