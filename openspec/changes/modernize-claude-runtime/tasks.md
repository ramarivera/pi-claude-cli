# Tasks: modernize Claude runtime

Beads is the status/dependency authority. Every checkbox maps to exactly one child of `pcc-modernize`; implementation is authorized; see execution.md. See design.md and lanes.json for frozen-interface rules and owned paths.

## 0. Planning and explicit start gate

- [x] 0.1 Validate OpenSpec plan and mirrored beads graph (`pcc-plan`; lane `coordination`; 60 min).
  - Capabilities: `verification-suite`.
  - Blocked by: none.
  - Acceptance: Strict OpenSpec validation, acyclic native beads graph, exact task mirror, complete disjoint file ownership and four E2E combinations; staged planning artifacts and no extension implementation.

- [x] 0.2 Wait for explicit implementation start instruction (`pcc-start`; lane `coordination`; 15 min).
  - Capabilities: `verification-suite`.
  - Blocked by: `pcc-plan`.
  - Acceptance: Ramiro explicitly instructs starting implementation; link that instruction in bead. Planning or a favourable design discussion alone doesn't satisfy this gate.

## 1. Policies, contracts and bootstrap

- [x] 1.1 Ratify compatibility and authentication execution policies (`pcc-policy`; lane `coordination`; 60 min).
  - Capabilities: `pi-adapter`, `omp-adapter`, `host-tool-handoff`, `session-lifecycle`, `sdk-driver`, `cli-driver`.
  - Blocked by: `pcc-start`.
  - Acceptance: Record tested target version matrix and explicit current-only support (legacy migration excluded by Ramiro), default driver/auth and billing source, allowed Claude-internal/user-MCP owners, resident CLI session strategy, and approval for exact new dependencies or CI changes; update specs before code if externally visible choices change.

- [x] 1.2 Freeze host-neutral driver and host interfaces (`pcc-contracts`; lane `contracts`; 90 min).
  - Capabilities: `claude-event-contract`, `host-tool-handoff`, `session-lifecycle`.
  - Blocked by: `pcc-policy`.
  - Acceptance: Neutral DTOs/driver+host seams compile with two driver and two host contract doubles; define lifecycle, correlations, capabilities and package exports; no host/SDK imports; frozen version and import names in design; contract tests pass.

- [x] 1.3 Prepare dependency and verification configuration once (`pcc-bootstrap`; lane `integration`; 60 min).
  - Capabilities: `sdk-driver`, `pi-adapter`, `omp-adapter`, `verification-suite`.
  - Blocked by: `pcc-contracts`.
  - Acceptance: Install only approved dependencies, preserve hooks, lock once, expose offline/live scripts with opt-in gate, establish supported host typecheck profiles; verification runs without paid inference; lane bootstrap receipt with frozen shared-file revision.

## 2. Core lane

- [x] 2.1 Implement neutral event reconciliation and terminal outcomes (`pcc-core-events`; lane `core`; 90 min).
  - Capabilities: `claude-event-contract`.
  - Blocked by: `pcc-bootstrap`.
  - Acceptance: Delta/full assistant dedupe, typed error/result mapping, usage and attributed retry/limit/task/status events pass state regression tests; one terminal outcome per turn; unknown event policy preserves diagnostics.

- [x] 2.2 Implement session identity, handoff and lifecycle ownership (`pcc-core-session`; lane `core`; 100 min).
  - Capabilities: `session-lifecycle`, `host-tool-handoff`.
  - Blocked by: `pcc-core-events`.
  - Acceptance: Correlate multiple tool results by ID, invalidate changed driver/cwd/history/schema/branch state, settle channels and isolate concurrent sessions; abort/result/EOF and shutdown/reload races pass; no global cache/state.

## 3. CLI lane

- [x] 3.1 Implement raw CLI transport and process resource cleanup (`pcc-cli-process`; lane `cli`; 90 min).
  - Capabilities: `cli-driver`.
  - Blocked by: `pcc-bootstrap`.
  - Acceptance: Correct prompt-file flag/cwd/argv/env, bidirectional NDJSON, fragmented UTF-8/lines and EPIPE/EOF/stderr/exit errors; drain/timeout/signal cleanup and per-request resources pass deterministic child-process tests.

- [x] 3.2 Implement CLI payload and interaction normalization (`pcc-cli-control`; lane `cli`; 100 min).
  - Capabilities: `cli-driver`, `claude-event-contract`, `host-tool-handoff`.
  - Blocked by: `pcc-cli-process`.
  - Acceptance: Correct nested control request IDs and updated input; subtype dispatch, explicit unsupported requests, complete result/error variants and configured tasks/full-message families; deterministic host execution handoff; emit contract DTOs.

## 4. SDK lane

- [x] 4.1 Implement official SDK driver and explicit auth options (`pcc-sdk-query`; lane `sdk`; 90 min).
  - Capabilities: `sdk-driver`.
  - Blocked by: `pcc-bootstrap`.
  - Acceptance: Official query executable/model/env options, inherited Claude login default, explicit API-key mode without hidden billing overrides, authoritative session IDs and callbacks, interrupt/close; lazy import allows CLI-only load; dependency transport never direct HTTP imitation.

- [x] 4.2 Implement parked SDK MCP tool-result continuity (`pcc-sdk-handoff`; lane `sdk`; 100 min).
  - Capabilities: `sdk-driver`, `host-tool-handoff`, `session-lifecycle`.
  - Blocked by: `pcc-sdk-query`.
  - Acceptance: Expose native host schemas without lossy conversion, disable duplicate Claude native execution for host-owned tools, parked calls matched by IDs across host rounds, parallel/unordered results and cancellations settled; guarded persistence/steering capabilities with contract assumptions documented.

## 5. Pi lane

- [x] 5.1 Implement current Pi provider input and stream projection (`pcc-pi-stream`; lane `pi`; 90 min).
  - Capabilities: `pi-adapter`.
  - Blocked by: `pcc-bootstrap`.
  - Acceptance: Current transcript prompt/tools, cwd host context, correct callbacks and AssistantMessage errors/usage; active exposure policy preserved; provider-ready tools and metadata project without SDK/OMP imports; entrypoint factory defined.

- [ ] 5.2 Implement Pi tool and session lifecycle adaptation (`pcc-pi-life`; lane `pi`; 90 min).
  - Capabilities: `pi-adapter`, `host-tool-handoff`, `session-lifecycle`.
  - Blocked by: `pcc-pi-stream`.
  - Acceptance: Built-in/custom/native schemas and tools results round-trip, session start/shutdown/reload/compact/tree/branch lifecycle, reentrancy and unsupported capabilities checked; no autoactivation of all tools; same adapter works with both contract drivers.

## 6. OMP lane

- [ ] 6.1 Implement OMP provider stream and native tool formats (`pcc-omp-tools`; lane `omp`; 100 min).
  - Capabilities: `omp-adapter`.
  - Blocked by: `pcc-bootstrap`.
  - Acceptance: OMP normalized context.tools/schema format, hashline/apply-patch/replacement edit, separate glob/semantic find, bash timeout units, callbacks/errors, cwd and native entrypoint; no Pi package imports; native tools retain OMP owner.

- [ ] 6.2 Implement OMP session capabilities and attributed progress (`pcc-omp-life`; lane `omp`; 100 min).
  - Capabilities: `omp-adapter`, `session-lifecycle`, `claude-event-contract`.
  - Blocked by: `pcc-omp-tools`.
  - Acceptance: Provider session store, shutdown/reload/subagent isolation, attributed task/status/limit progress and capability-gated steering; Claude tasks distinguished from OMP tasks; both drivers supported and unsupported capabilities explicit.

## 7. Verification lane

- [x] 7.1 Build versioned fixture catalog and coverage matrix (`pcc-fixtures`; lane `verification`; 90 min).
  - Capabilities: `verification-suite`, `claude-event-contract`.
  - Blocked by: `pcc-bootstrap`.
  - Acceptance: Sanitized recordings with provenance/license/CLI-SDK-host versions/flags plus labelled synthetic rare-event cases; old test-to-replacement matrix; coverage inventory includes payload categories and concrete researched regressions; paid captures only behind approved live gate.

- [ ] 7.2 Build common driver and host contract suites (`pcc-conformance`; lane `verification`; 100 min).
  - Capabilities: `verification-suite`, `cli-driver`, `sdk-driver`, `pi-adapter`, `omp-adapter`.
  - Blocked by: `pcc-fixtures`.
  - Acceptance: Same expected events/outcomes for real driver modules with offline injected transport seams; host contract checks use actual host types; ordering/abort/correlation/error/tool ownership scenarios and replay fixtures; tests cannot merely mirror implementation.

- [ ] 7.3 Build opt-in real Pi and OMP E2E matrix harness (`pcc-e2e-harness`; lane `verification`; 100 min).
  - Capabilities: `verification-suite`.
  - Blocked by: `pcc-conformance`.
  - Acceptance: Four named real host/driver combinations, semantic output/system prompt/host tool/result/resume/abort/cleanup assertions, one OMP native-format and SDK parked-correlation case; CLI/auth/config prerequisites; bounded turns/time/model; disabled explicit skip, enabled unmet prerequisite failure; isolated resources and sanitized receipts.

## 8. Integration and actual proof

- [ ] 8.1 Integrate all lanes and migrate legacy provider files (`pcc-cutover`; lane `integration`; 100 min).
  - Capabilities: `pi-adapter`, `omp-adapter`, `cli-driver`, `sdk-driver`, `session-lifecycle`.
  - Blocked by: `pcc-core-session`, `pcc-cli-control`, `pcc-sdk-handoff`, `pcc-pi-life`, `pcc-omp-life`, `pcc-e2e-harness`.
  - Acceptance: Root entrypoint shims and Pi/OMP discovery manifests select same neutral core+config driver; existing provider ID/root entrypoint retained; legacy migration excluded; replace old tests only with mapped equivalent/improved coverage; inspect every lane diff and receipts; no overlapping shared-file mutations.

- [ ] 8.2 Verify integrated offline regression and host compatibility matrix (`pcc-offline`; lane `integration`; 90 min).
  - Capabilities: `verification-suite`.
  - Blocked by: `pcc-cutover`.
  - Acceptance: Lint/typecheck/unit/replay/process/contract suites fresh green for declared host versions; resolve hooks/failures without silencing tests/any; compare coverage inventory, module import isolation and no orphan children/temp resources; record commands and hashes.

- [x] 8.3 Prepare authenticated live-test account and usage limits (`pcc-live-access`; lane `coordination`; 30 min).
  - Capabilities: `verification-suite`, `sdk-driver`, `cli-driver`.
  - Blocked by: `pcc-start`.
  - Acceptance: Human completes own Claude login if absent, account/auth/billing source and bounded test usage agreed, installed supported CLI/hosts and writable isolated session roots confirmed without copying tokens; no secrets in chat or fixtures. Existing cost acknowledgement retained; only missing specifics requested before live execution.

- [ ] 8.4 Execute all four authenticated host and driver E2E combinations (`pcc-live`; lane `integration`; 100 min).
  - Capabilities: `verification-suite`.
  - Blocked by: `pcc-offline`, `pcc-live-access`.
  - Acceptance: Run SDK+Pi, CLI+Pi, SDK+OMP, CLI+OMP with actual authenticated Claude; semantic tools/output/resume/cancel/resource assertions and usage receipts; skipped/blocked combinations prevent implementation completion; every failure fixed or explicit incomplete.

- [ ] 8.5 Finalize compatibility and verification documentation (`pcc-docs`; lane `integration`; 60 min).
  - Capabilities: `pi-adapter`, `omp-adapter`, `verification-suite`, `sdk-driver`, `cli-driver`.
  - Blocked by: `pcc-live`.
  - Acceptance: Document tested release matrix, entrypoint/driver/auth choice and differences, current supported behavior and excluded legacy migration, installed-vs-source evidence and live tests; spec/tasks/bead evidence synchronized by coordinator; no publish/deploy/commit without session authorization.
