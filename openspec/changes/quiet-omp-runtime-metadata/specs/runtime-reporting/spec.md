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
