# Runtime reporting

## ADDED Requirements

### Requirement: Quiet native footer

Routine Claude task, tool-progress, status, retry, rate-limit and compaction observations SHALL NOT add OMP status rows or notifications. They SHALL remain available through the native file logger and observation bus. File logs SHALL retain only bounded metadata and known attribution identifiers, without raw observation payloads or response text.

#### Scenario: Thinking token status during a turn

- **WHEN** Claude reports `thinking_tokens` with a turn ID
- **THEN** the native footer doesn't gain an extension status row
- **AND** OMP's file logger receives the metadata

### Requirement: Preserve real errors

Genuine provider failures and cleanup errors SHALL retain the native assistant error, error logger and notification paths appropriate to the failure.

#### Scenario: Owned runtime cleanup fails

- **WHEN** the owned Claude runtime fails to close
- **THEN** OMP logs and notifies the cleanup failure
- **AND** routine metadata hasn't been promoted into a user warning

### Requirement: Verify installed delivery

Release verification SHALL inspect the exact published artifact and native package discovery for both hosts. Authenticated OMP checks SHALL observe both steering and runtime progress status keys, even when RPC suppresses their visual rendering.

#### Scenario: Managed OMP package handles a real native tool

- **WHEN** the installed package processes an authenticated native tool round
- **THEN** the provider and selected driver are confirmed through native discovery
- **AND** no Claude runtime status text is sent to the native footer

### Requirement: Native background completion input

The OMP adapter SHALL accept native developer notifications and preserve the roles and order of all current user/developer input messages, including image attachments and notifications alongside tool results. Matching resident history SHALL continue without duplicating input or losing notification text.

#### Scenario: Background job completes after the foreground answer

- **WHEN** the native host delivers an async-result notification after its foreground response finishes
- **THEN** the provider accepts the resulting developer input
- **AND** the resident Claude query answers the notification and retains it for the next user request

### Requirement: Native tool discovery across transports

Both drivers SHALL preserve native host instructions and tool schemas while supplying the exact Claude callable name for each exposed host tool. They SHALL describe only actual exposed tools and configured built-ins.

#### Scenario: Existing document edit and new document write

- **WHEN** the user requests native read, edit and write with the default host prompt
- **THEN** both transports expose an explicit native-name to MCP-name mapping
- **AND** authenticated checks require successful native results and exact file bytes without shell fallback or tool-unavailable claims

### Requirement: Measured cache verification

Cache verification SHALL distinguish resident session reuse from Anthropic prompt cache hits. Matching host rounds SHALL retain their existing driver query. A paid cache check SHALL use a synthetic prefix above the model's minimum cacheable size and inspect cache usage on consecutive native turns, together with stable session identity. Historical measurements SHALL be labelled with their production fingerprint; quota failures SHALL remain failed validation rather than passing or being silently skipped.

#### Scenario: Stable warm native follow-ups

- **WHEN** four authenticated turns use unchanged native configuration within the cache lifetime, including a native tool-hook argument revision
- **THEN** the same Claude query handles all turns and the intervening correlated tool result
- **AND** both no-tool warm follow-ups reuse a nonshrinking large cached prefix with a small newly written suffix
- **AND** the check doesn't claim persisted-session restoration after a process restart

### Requirement: Preserve native history acknowledgements

Native argument revisions SHALL acknowledge only newly completed, correlated, released proposals with identical call IDs and names. Other message fields and previously recorded history SHALL remain exact. OMP redacted-thinking projection and normalization SHALL preserve the opaque bytes and the existing neutral history digest.

#### Scenario: Native hook changes pending bash arguments

- **WHEN** the host records revised arguments for a newly completed pending bash call
- **THEN** the correlated result reaches the original resident Claude query once
- **AND** a later change to already acknowledged history still requires invalidation

#### Scenario: OMP records redacted thinking

- **WHEN** native streaming or snapshot projection emits redacted thinking
- **THEN** its opaque data survives normalization with the original neutral message digest
