# cli-driver

## Purpose

Run the installed published Claude executable through its print-mode streaming protocol while correctly managing controls, resources and version-sensitive capabilities.

## ADDED Requirements

### Requirement: Published CLI transport

The selected CLI driver SHALL invoke the published Claude executable in print mode with bidirectional streaming JSON, explicit cwd/model and supported capability flags, using the user's selected authentication source.

#### Scenario: Existing Claude login

- **WHEN** CLI mode is selected with existing Claude subscription login and no API override
- **THEN** the executable authenticates using that login without the extension copying credentials

#### Scenario: System prompt file

- **WHEN** the prompt is provided through a temporary file
- **THEN** the file-taking CLI option is used and the prompt text affects the response

#### Scenario: Model-dependent effort

- **WHEN** an effort level is requested for a model
- **THEN** supported effort is applied or an explicit unsupported outcome is returned without substring-based silent upgrades

### Requirement: Correlated controls

Control replies SHALL follow the current published protocol nesting, correlate request IDs, preserve approved updated input and dispatch permission, user-input/dialog and other supported request kinds separately.

#### Scenario: Tool permission reply

- **WHEN** a valid tool permission request is answered
- **THEN** the reply nests request_id inside the response and carries the approved or denied input decision

#### Scenario: Unsupported control

- **WHEN** an unsupported control subtype is received
- **THEN** it receives an explicit unsupported/error outcome rather than unconditional tool approval

### Requirement: Reliable process termination

The driver SHALL preserve buffered valid output and expose spawn, parse, stdin, stderr, EOF, timeout and nonzero-exit failures; cancellation and shutdown SHALL release owned children and temporary resources within documented bounds.

#### Scenario: Fragmented traffic

- **WHEN** UTF-8 bytes or NDJSON lines are split across chunks
- **THEN** all complete valid messages are reconstructed once

#### Scenario: Missing terminal result

- **WHEN** the child closes without a terminal result
- **THEN** the turn reports an actionable error

#### Scenario: Cancellation with pending control

- **WHEN** the host aborts while a control request is pending
- **THEN** pending work settles and no child or temporary prompt/schema file survives

### Requirement: Supported version behavior

CLI flags, forwarded subagent output, resume and control assumptions SHALL be checked against the declared CLI version matrix and protocol regression inventory.

#### Scenario: Unsupported required CLI feature

- **WHEN** the installed CLI lacks a required feature
- **THEN** initialization fails with a version/capability explanation before inference

#### Scenario: Forwarded subagent snapshots

- **WHEN** forwarding is enabled and complete child assistant/user messages arrive
- **THEN** their parent attribution and tool results are handled without assuming token deltas exist
