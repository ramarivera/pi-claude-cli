# omp-adapter

## Purpose

Expose both Claude drivers through a native OMP entrypoint with OMP tool formats, session capabilities and progress presentation isolated from Pi.

## ADDED Requirements

### Requirement: Native OMP discovery and provider contracts

The OMP entrypoint SHALL use OMP package/discovery/provider contracts, normalized tool schemas, cwd, callbacks and assistant error types while selecting either driver.

#### Scenario: Native OMP load

- **WHEN** OMP discovers the configured OMP extension manifest
- **THEN** the OMP adapter loads and registers the intended provider

#### Scenario: Callable tool inventory schema

- **WHEN** OMP inventory contains a callable schema but context supplies normalized tool wire schema
- **THEN** the advertised tool uses the normalized effective schema rather than JSON-serializing a function

### Requirement: Native tool semantics

OMP tools SHALL retain configured hashline, apply-patch or replacement edit semantics; glob and semantic find SHALL remain distinct, and bash timeout units SHALL be correctly translated.

#### Scenario: Hashline edit

- **WHEN** OMP uses its default hashline input format
- **THEN** the tool call validates and executes in OMP with that format

#### Scenario: Alternative edit formats

- **WHEN** OMP selects replacement or apply-patch editing
- **THEN** calls follow that effective schema rather than Pi oldText/newText arguments

#### Scenario: Glob and timeout

- **WHEN** Claude requests a glob or timed bash operation
- **THEN** the correct OMP tool and time unit are used

### Requirement: OMP capabilities without Pi coupling

OMP provider-session state, subagent isolation, task/progress presentation and supported steering SHALL use OMP capabilities without introducing OMP imports or behavior into Pi integration.

#### Scenario: Claude task progress

- **WHEN** Claude emits attributed background-task progress
- **THEN** OMP presents it with Claude ownership without fabricating an OMP-native task execution

#### Scenario: Unsupported steering driver

- **WHEN** OMP supports steering but the selected driver doesn't
- **THEN** an explicit unsupported capability outcome is surfaced

#### Scenario: Pi load isolation

- **WHEN** the package loads via its Pi entrypoint
- **THEN** OMP modules, tools and UI initialization are not required
