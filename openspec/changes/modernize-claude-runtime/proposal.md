# Proposal: modernize Claude runtime

## Why

The extension targets old Pi contracts and assumes incomplete Claude payloads. Current Pi, OMP and Claude behavior needs correct tools, sessions, errors and cleanup; the requested SDK option adds a second supported transport.

## What Changes

- Extract a host-neutral core with selectable official SDK and raw `claude -p` drivers.
- Add separate Pi and native OMP entrypoints, isolating OMP-specific formats/capabilities.
- Modernize event/control/error/usage handling, history reconciliation and tool ownership.
- Improve unit coverage; add versioned replay, process/contract tests and real authenticated E2E for all four host/driver combinations.
- Freeze shared interfaces before parallel work; give each lane exclusive paths and one integration owner for shared files.
- **BREAKING candidates:** supported host contracts, tool schemas and session behavior have changed. Ratify version support and explicit current-only support (legacy migration excluded by Ramiro) before code; preserve the existing provider ID/entrypoint through a documented compatibility path where supported.

## Capabilities

### New Capabilities

- `claude-event-contract`: neutral content/progress/errors and terminal outcomes.
- `cli-driver`: official print-mode streaming/control/process lifecycle.
- `sdk-driver`: official SDK execution/auth and continuous host tool handoff.
- `host-tool-handoff`: active native schemas, one execution owner, correlated results.
- `session-lifecycle`: authoritative identities/history and isolated cleanup.
- `pi-adapter`: supported Pi transcript/provider/tool/lifecycle contracts.
- `omp-adapter`: native OMP provider/tool/capability contracts isolated from Pi.
- `verification-suite`: meaningful deterministic coverage and four real E2E combinations.

### Modified Capabilities

None: no prior OpenSpec specs exist. These contracts describe requested future behavior, not completed implementation.

## Impact

Planned module paths, dependencies, manifests and tests are in design.md and lanes.json. No runtime changes, dependency installations, CI changes, inference or publishing occur in this planning turn.

## Authorization

Implementation remains deferred. OpenSpec owns behavior/design; beads owns tasks/status/dependencies. The start gate requires Ramiro's explicit implementation instruction. This change supersedes historical .planning SDK-only exclusions for this effort while preserving historical files. Portable research/ sources accompany the proposal.
