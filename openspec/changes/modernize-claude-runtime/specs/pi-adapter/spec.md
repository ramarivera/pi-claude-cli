# pi-adapter

## Purpose

Integrate both Claude drivers with the supported Pi extension/provider contracts while preserving Pi tools, callbacks, history and lifecycle semantics.

## ADDED Requirements

### Requirement: Current Pi input and output contracts

The Pi entrypoint SHALL extract prompt/tools from the supported transcript contract, capture cwd/lifecycle from Pi, use host module instances, implement provider callbacks and return valid assistant events including error/aborted messages.

#### Scenario: Canonical Pi transcript

- **WHEN** Pi supplies normalized transcript messages
- **THEN** the effective system prompt and tools reach Claude correctly

#### Scenario: Driver failure

- **WHEN** the selected driver fails
- **THEN** Pi receives an assistant-message error with correct stop reason and error text

#### Scenario: Provider callbacks

- **WHEN** the host configures payload or response callbacks
- **THEN** the adapter supplies truthful transport observations without inventing an HTTP response for subprocess transport

### Requirement: Driver-independent Pi execution

The same Pi integration SHALL support SDK and CLI selection without losing active tool exposure, tool result continuity, structured images/content or model/thinking metadata.

#### Scenario: Custom tool result

- **WHEN** Pi executes a custom tool returning structured content
- **THEN** the result returns to the correlated Claude call through either selected driver

#### Scenario: Pi policy-controlled tools

- **WHEN** Pi has a restricted active tool set
- **THEN** initialization does not activate tools outside that policy

### Requirement: Pi lifecycle and compatibility migration

The adapter SHALL implement supported shutdown/reload/compact/tree/branch behavior and publish tested current-version requirements. Legacy release support/migration is excluded by Ramiro on 2026-09-30.

#### Scenario: Existing provider configuration

- **WHEN** the user loads an existing provider ID or legacy entrypoint
- **THEN** the existing provider ID and root entrypoint load on the supported current release without a legacy compatibility layer

#### Scenario: Unsupported Pi release

- **WHEN** a Pi version is outside the declared supported matrix
- **THEN** the extension reports the incompatibility rather than claiming untested compatibility
