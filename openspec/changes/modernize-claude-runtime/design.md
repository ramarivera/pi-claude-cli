# Design: contracts first, disjoint implementation lanes

## Context

See proposal.md and research/ for scope and pinned evidence. Current raw-CLI code mixes Pi events, subprocess handling and global state. Current pi-claude-bridge provides SDK tool/session/test patterns; T3 supplies neutral-event patterns; BB supplies fixture/live-test separation. None is the requested two-host/two-driver core.

## Goals / Non-Goals

**Goals:** satisfy eight capability specs with one core, two drivers, two adapters and shared conformance; allow independent module work after the interfaces are stable.
**Non-goals:** direct subscription HTTP identity imitation, credential extraction, delegated-worker redesign, auto-fallback replay after side effects, automatic release, or implementation in this planning turn.

## Decisions

### Independent host and driver interfaces

```text
Pi entrypoint  -> Pi adapter  ----+
                                 +-> neutral core -> selected CLI driver -> Claude -p
OMP entrypoint -> OMP adapter ----+               -> selected SDK driver -> official runtime
```

Core owns event reconciliation, terminal outcomes, correlated tool ownership, lifecycle and session decisions. Drivers own framing or SDK callbacks, process/query resources and persistence mechanics. Adapters own effective host schemas, transcript extraction, callbacks/output, history and capabilities. No host imports in contracts/core/drivers; no SDK/raw-control objects in host interfaces; no OMP imports in Pi.

The contract lane defines request/transcript/tool DTOs, normalized events/errors/outcomes, driver/host interfaces, factory exports and capability flags. Keep the interface small but include sequencing, pending-call semantics, abort/close, identity, resource ownership and errors. Compile two driver and two host contract doubles before freeze. No placeholder interfaces that hide hard handoff questions.

After freeze, independent lanes treat contracts as immutable. An interface change is coordinator-owned: pause affected work, update requirements/version/contract, and resume against the same revision. Lanes import contracts and public factories, never sibling internals.

### Tool handoff and state

Use the current bridge's parked MCP pattern for SDK: native Claude tools disabled for host-owned operations, effective host tools exposed by MCP, query waits while Pi/OMP executes and returns results by authoritative call ID. Preserve native schemas without a lossy schema-library round trip.

The CLI driver needs the same observable ownership guarantee using current bidirectional control/stream semantics. Do not assume the existing kill-at-message-stop race is correct. Policy approval defines allowed Claude-internal and user-MCP ownership. Test mixed ownership, parallel/out-of-order results and cancellation.

Core tracks host session/branch, actual Claude identity, driver, cwd, history/schema/settings digests. Drivers implement actual persistence/rebuild mechanics behind the interface. Any common Claude-only session helpers remain private neutral-core implementation. Validate cc-session-io, session-file layout, tool-ID metadata and steering assumptions with executable probes before relying on them. No message-count resume heuristics or global files/schema/session caches.

### Compatibility and authentication policy

Research baselines: canonical Pi 0.99.1, OMP 18.4.4, Claude 2.1.285; refresh version-specific primary source at implementation start. Policy gate records supported releases, exact dependencies and existing provider-ID/entrypoint behavior before code. Ramiro approved current-only support and removed legacy migration on 2026-09-30; see execution.md. Do not claim untested compatibility.

The approved default remains CLI, with explicit SDK selection. Exact new dependencies are approved in execution.md; no CI changes are planned. Own Claude login via official runtime is supported; API-key mode or host-credential injection must be named choices with clear billing source. No silent Pi/OMP token pickup. Existing cost acknowledgement persists; missing login or usage specifics block only live testing.

### Exclusive ownership and parallelism

lanes.json owns the machine-readable file/task graph. Six independent lanes are core, CLI, SDK, Pi, OMP and verification, each with separate source/test directories. Contracts and bootstrap precede them. All legacy files, manifests/lock/configuration, root shims and shared docs belong to the integration owner. OpenSpec and beads are coordination-owned.

At most three implementation lanes are active. Prefer an available-slot scheduler: start core/CLI/SDK, then start Pi, OMP or verification as slots free. No whole-wave barrier is required because all six consume frozen contracts, not sibling internals. Same-lane tasks are serial. Estimated slices are <=100 minutes; split before dispatch if needed without reducing scope.

Each worker gets its own branch/worktree based on an integrated contract/bootstrap revision. Future worktrees carry committed spec/research/interface context before dispatch; this planning turn stages artifacts without committing. Worker briefs include bead/title/specs, base hash, owned/forbidden paths, interfaces, dependency readiness, commands, acceptance and evidence format. Unmatched files require coordinator allocation. Root registries/barrels/configs are not shared scratchpads.

Contracts edits after freeze require the coordinated change process; no worker freely edits another owner's file. Coordination status writes are serialized to one canonical board. Workers query it read-only and send receipts; they never edit the JSONL snapshot or bootstrap competing boards. Receipts list paths/hashes, commands/results, versions, cost/auth constraints and known gaps. Coordinator inspects diffs and reruns focused gates before serial integration. Long external OMP lanes require an observed armed monitor; resolve permitted model routes at dispatch.

### Tests follow modules

Each implementation lane owns its behavioral unit tests. Verification owns shared fixtures/provenance, conformance/replay, process harness support and real E2E. Shared tests use frozen factory interfaces with injected offline transports, not mock host shapes or sibling internals. Lane-private fixtures stay private until catalog publication. Integrator connects actual factories at cutover.

Live matrix: Pi+CLI, Pi+SDK, OMP+CLI, OMP+SDK. Assert semantic text/system prompt, exactly-once host effects/result continuity, resume and abort/cleanup; include native OMP formats and SDK parked-call correlation. Live inference is disabled by default. Explicit opt-in plus missing prerequisites fails; skipped combinations prevent full completion. Bound models/turns/time/usage, isolate state, sanitize captures and record observed cost where available. Rare rate-limit/budget/destructive conditions use clearly labelled fixtures instead of burning quota.

## Migration Plan

1. Finish validated planning receipt; keep implementation-start deferred.
2. After explicit start, ratify policies, freeze interfaces and let one integrator prepare approved dependencies/test profiles.
3. Dispatch bounded disjoint lanes; serially integrate inspected/verified results.
4. Cut over root entrypoints/manifests; retire old files/tests only with mapped equivalent or stronger behavior coverage. Preserve historical .planning evidence.
5. Run fresh integrated offline gates, then four real E2E combinations after account/usage readiness.
6. Document actual tested releases, capability/driver/auth differences, migration and receipts. Do not publish or declare implementation complete before required proof.

## Risks / Trade-offs

- Non-public SDK/session assumptions drift -> versioned executable contracts and guarded capabilities.
- Two transports increase maintenance -> shared core/conformance and four live combinations.
- File-disjoint edits can diverge semantically -> frozen interfaces and one integrator.
- OMP edit/search units differ -> native schemas and semantic behavior tests.
- Live account setup can block proof -> early readiness bead; no skipped-live completion.
- Old tests can encode bugs -> explicit coverage mapping and stronger behavioral assertions.

## Frozen interface revision

`CONTRACT_VERSION = 1` is frozen in src/contracts/index.ts at lane commit 32c696e, with resolveResumePlan in resume.ts. Production public factories are `createClaudeRuntime` and `createClaudeEventNormalizer` from src/core/index.ts, `createCliDriver` from src/drivers/cli/index.ts, and `createSdkDriver` from src/drivers/sdk/index.ts. The integration composition root supplies the normalizerFactory through DriverFactoryOptions, so driver lanes don't import core internals. `registerPiAdapter` and `registerOmpAdapter` remain host-owned factories; production entrypoints share the integration-owned entrypoints/runtime.ts composition module.

Current host packages are optional peers and pinned development dependencies. Original Mario packages remain temporary development inputs only until old source/tests are replaced at cutover; they don't add legacy runtime support. Live E2E uses actual RPC subprocesses; OMP may select a compiled installed binary explicitly so npm PATH doesn't choose an incompatible global Bun.
