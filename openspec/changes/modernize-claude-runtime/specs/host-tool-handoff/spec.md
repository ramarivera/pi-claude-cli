# host-tool-handoff

## Purpose

Ensure host tools keep their native schemas, exposure rules and execution owner while Claude tool requests and results remain correlated across provider rounds.

## ADDED Requirements

### Requirement: Exactly one execution owner

Each exposed tool SHALL have a declared execution owner. Host-owned tools SHALL execute through Pi or OMP exactly once per authoritative call ID; Claude-internal or user-MCP tools SHALL follow an explicit separately documented policy.

#### Scenario: Host-owned tool proposal

- **WHEN** Claude proposes an exposed host tool
- **THEN** only the host executes it and its result returns to the same Claude call

#### Scenario: Mixed ownership round

- **WHEN** a round contains host tools, Claude-internal tools and user MCP calls
- **THEN** each follows its declared owner and no tool executes both in Claude and the host

### Requirement: Effective schemas and exposure

Only effective active/exposed tools SHALL be advertised. Schema conversion SHALL preserve native field semantics, metadata and required structure without freezing stale inventory or activating all tools.

#### Scenario: Tool exposure changes

- **WHEN** the host changes active tools between turns
- **THEN** the next turn advertises the new effective inventory

#### Scenario: Native-format tool

- **WHEN** a tool requires host-specific input semantics
- **THEN** the host's effective schema is preserved or a validated semantic translation is used

### Requirement: Results and interaction safety

Results, denied requests, tool errors and user questions SHALL preserve IDs, structured output and ownership; cancellation SHALL settle pending calls without fabricating a successful tool result.

#### Scenario: Tool error

- **WHEN** a host tool returns an error or denial
- **THEN** Claude receives that correlated error and the host's output remains truthful

#### Scenario: Missing result or duplicate callback

- **WHEN** a tool result is absent or the same result is delivered twice
- **THEN** the operation reports a bounded failure or ignores the duplicate without repeating execution

#### Scenario: Tool arguments still streaming

- **WHEN** Claude is generating tool arguments or later blocks in the same assistant message
- **THEN** the MCP parking deadline does not count that generation time; it begins at the completed assistant-message boundary for each unparked proposal, while normal stream cancellation and watchdog bounds remain active

#### Scenario: Serialized MCP dispatch for a completed parallel proposal

- **WHEN** a completed assistant message contains multiple authoritative exposed host-tool proposals but the official runtime dispatches one MCP call before waiting for its result to dispatch the next
- **THEN** a matching actual MCP call releases the completed proposal batch to the host once; results for the remaining completed proposals may be buffered by authoritative ID without fabricating MCP request events
- **AND** each actual MCP dispatch must match the immutable completed proposal ID, name and arguments; conflicting or missing dispatch fails within a bound, and abort settles both buffered and parked calls
