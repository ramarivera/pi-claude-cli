# session-lifecycle

## Purpose

Keep host history and Claude persistence synchronized using authoritative identities and isolate session resources across resume, abort, branching and driver changes.

## ADDED Requirements

### Requirement: Independent authoritative identities

Resume decisions SHALL account for host session/branch, authoritative Claude session, driver kind, cwd, history cursor/digest, tool schema digest and relevant settings rather than message-count heuristics.

#### Scenario: Host history without persisted Claude state

- **WHEN** the host supplies multiple messages but no verified Claude persistence
- **THEN** the runtime rebuilds/replays safely rather than blindly resuming

#### Scenario: Changed driver or cwd

- **WHEN** the selected driver or cwd changes
- **THEN** resume state is explicitly invalidated or rebuilt

### Requirement: History transitions

Abort, compaction, tree navigation, branching, fork and imported history SHALL invalidate or reconcile Claude state according to tested persistence rules without silently losing tool results or user content.

#### Scenario: Compaction divergence

- **WHEN** the host compacts history while a Claude query exists
- **THEN** stale state is discarded or reconciled before the next turn

#### Scenario: Abort then resume

- **WHEN** a tool round is interrupted before all results complete
- **THEN** the next request restores a consistent history or reports why safe resume is unavailable

### Requirement: Resource isolation and cleanup

Concurrent host sessions and subagents SHALL have isolated prompt/schema files, pending calls and session state. Shutdown, reload, abort, failure and EOF SHALL release resources for the affected session.

#### Scenario: Concurrent sessions

- **WHEN** two sessions have different tools/cwd and run concurrently
- **THEN** neither inherits or deletes the other's files, schema or pending calls

#### Scenario: Shutdown during inference

- **WHEN** the host shuts down or reloads the extension
- **THEN** owned queries/processes, timers and pending calls settle within documented bounds

### Requirement: No automatic cross-driver replay

A failed turn SHALL NOT automatically be replayed through the other driver after possible inference or tool side effects.

#### Scenario: Failure after tool effect

- **WHEN** a tool modifies a sentinel file before the driver fails
- **THEN** the runtime reports failure without rerunning the turn using the alternate driver
