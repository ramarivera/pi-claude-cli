# sdk-driver

## Purpose

Drive the official Claude Agent SDK runtime as a selectable transport with explicit authentication, host tool ownership and fully settled query lifecycles.

## ADDED Requirements

### Requirement: Official SDK execution and auth selection

SDK mode SHALL drive the official Claude runtime, support existing Claude login and explicit API-key mode, and disclose the effective authentication/billing source without silently importing host OAuth credentials or direct HTTP identity imitation.

#### Scenario: Own subscription login

- **WHEN** SDK mode uses the user's existing Claude login
- **THEN** the official runtime handles authentication and no token extraction is required

#### Scenario: Conflicting authentication override

- **WHEN** an inherited credential or endpoint would change the configured auth/billing source
- **THEN** the conflict is resolved according to explicit documented policy or fails clearly

#### Scenario: CLI-only loading

- **WHEN** the user selects CLI mode
- **THEN** loading that entrypoint does not require SDK initialization or SDK-only auth

### Requirement: Continuous host tool handoff

SDK queries SHALL retain correlated pending host tool calls while the host executes tools and returns results; multiple or out-of-order tool completions SHALL match by authoritative call ID.

#### Scenario: Parked tool round

- **WHEN** the SDK requests a host-owned tool and the host returns its result in the next provider round
- **THEN** the result resumes the correct pending SDK query without duplicate execution

#### Scenario: Serialized dispatch with early results

- **WHEN** the official runtime emits multiple completed host-tool proposals and dispatches their MCP calls sequentially
- **THEN** results for completed proposals may arrive before their matching MCP handler; each result is retained for that authoritative call ID and delivered once when the actual handler arrives
- **AND** cancellation, conflicting correlation and absent later dispatch remain bounded failures

#### Scenario: Out-of-order parallel tools

- **WHEN** two host tools complete in reverse order
- **THEN** each result resolves only its matching SDK tool call

### Requirement: SDK lifecycle and feature capability

SDK interruption, close, dialog, history/resume and optional steering SHALL honor the shared lifecycle contract; unsupported or non-public assumptions SHALL be reported and guarded by executable contract evidence.

#### Scenario: Abort parked query

- **WHEN** abort occurs while a prompt or MCP handler is parked
- **THEN** all parked operations settle and the query closes

#### Scenario: Unsupported steering

- **WHEN** the host requests steering that the installed driver cannot provide
- **THEN** the host receives explicit capability behavior rather than a false support claim
