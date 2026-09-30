# claude-event-contract

## Purpose

Deliver a host-neutral, ordered Claude event stream with correct terminal outcomes and attributable diagnostics across both supported drivers.

## ADDED Requirements

### Requirement: Stream and full-message reconciliation

Consumers SHALL receive text, thinking, signatures and completed assistant content without duplication or loss when partial events and completed snapshots both arrive.

#### Scenario: Partial and full output

- **WHEN** text deltas precede a full assistant snapshot
- **THEN** the emitted final content contains each segment once

#### Scenario: Snapshot-only output

- **WHEN** Claude emits a completed assistant message without preceding deltas
- **THEN** the same usable assistant content is delivered

#### Scenario: Previous snapshot during a newer stream

- **WHEN** a snapshot of a completed previous assistant message arrives after a newer streamed message starts
- **THEN** the newer message remains the active target for its unlabelled delta and stop frames, and a parked tool round can finish without losing that message boundary

### Requirement: Terminal errors and accounting

A turn SHALL finish exactly once with success, error or aborted status, preserving usage, model attribution, available cost, is_error, error subtypes and actionable error content.

#### Scenario: Nonstandard error subtype

- **WHEN** a result reports execution, maximum-turn, budget or structured-output exhaustion, or is_error is true
- **THEN** the turn reports error rather than successful completion

#### Scenario: Abort racing result

- **WHEN** abort and result arrive concurrently
- **THEN** one terminal outcome is delivered and no later content mutates the completed turn

### Requirement: Modern event families

The runtime SHALL preserve initialization, retries, rate limits, compaction/status, tool progress, hooks, task/subagent linkage, user-input/dialogs and reset signals as normalized observations or explicit capability-dependent outcomes.

#### Scenario: Retry liveness

- **WHEN** Claude reports a retry or transient overload before a later successful result
- **THEN** progress remains observable and the turn is not prematurely marked failed

#### Scenario: Attributed child activity

- **WHEN** task or subagent traffic includes parent/tool/session identifiers
- **THEN** progress retains that attribution and does not become a main-assistant tool proposal

#### Scenario: Initialization failure

- **WHEN** init reports failed MCP or runtime initialization
- **THEN** the failure is observable before a misleading empty success

### Requirement: Additive protocol handling

Unknown optional fields and event families SHALL have explicit ignore/diagnostic behavior; malformed required fields SHALL fail the affected operation without exposing secrets.

#### Scenario: New optional event

- **WHEN** a new event subtype appears in otherwise valid traffic
- **THEN** a bounded sanitized diagnostic records its type and supported output continues

#### Scenario: Malformed required correlation

- **WHEN** an interaction omits a required request or tool ID
- **THEN** the operation fails explicitly and no uncorrelated action is approved
