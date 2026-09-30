# verification-suite

## Purpose

Provide meaningful deterministic regression evidence and explicitly gated authenticated end-to-end verification for both Claude drivers through actual Pi and OMP entrypoints.

## ADDED Requirements

### Requirement: Regression and contract coverage

The suite SHALL improve existing unit coverage, replay sanitized versioned protocol fixtures, exercise deterministic child-process failures and verify actual supported host types and common driver contracts.

#### Scenario: Versioned fixture

- **WHEN** a recording captured from a known CLI/SDK/host version is replayed
- **THEN** expected normalized behavior and provenance are checked without paid inference

#### Scenario: Simulated transport

- **WHEN** the process suite uses a fake child
- **THEN** its result is labelled simulated and is not reported as real Claude E2E

#### Scenario: Retired legacy test

- **WHEN** a legacy implementation test is replaced during migration
- **THEN** an equivalent or stronger behavioral assertion is recorded in the coverage map

### Requirement: Four real host-driver combinations

Automated live E2E SHALL drive the official authenticated Claude runtime through actual Pi+SDK, Pi+CLI, OMP+SDK and OMP+CLI entrypoints. Each SHALL assert semantic text/system prompt, host-tool ownership/result continuity, resume, cancellation and resource cleanup.

#### Scenario: Real host-tool effect

- **WHEN** a live combination executes a bounded sandbox tool
- **THEN** the sentinel effect occurs exactly once through the host and the model uses its correlated result

#### Scenario: OMP native format and SDK parked query

- **WHEN** the corresponding live cases run
- **THEN** OMP accepts a native schema operation and SDK correctly correlates a parked tool result

#### Scenario: Partial live matrix

- **WHEN** only some combinations pass or run
- **THEN** the remaining combinations are reported incomplete and the feature is not declared fully verified

### Requirement: Explicit live opt-in and resource bounds

Paid/authenticated tests SHALL require an explicit environment opt-in, selected auth/billing source, supported model/binary, bounded turns/time/usage and isolated resources; missing prerequisites after opt-in SHALL fail rather than silently skip.

#### Scenario: Default offline run

- **WHEN** live opt-in is absent
- **THEN** no authenticated request occurs and live cases are visibly skipped

#### Scenario: Enabled without credentials

- **WHEN** live opt-in is set but CLI/auth/host prerequisites are missing
- **THEN** the suite fails before making an unintended request

#### Scenario: Cancellation cleanup

- **WHEN** a live test is interrupted or times out
- **THEN** its subprocesses, temp files and parked handlers are cleaned up

### Requirement: Evidence and privacy

Verification receipts SHALL identify commands, hashes, driver/host/CLI/SDK versions, case outcomes, observed usage and remaining limits; captures SHALL remove credentials and user-private data.

#### Scenario: Successful suite

- **WHEN** all required gates pass
- **THEN** the report distinguishes deterministic checks from executed live evidence

#### Scenario: Sensitive raw payload

- **WHEN** a capture includes auth or private content
- **THEN** the saved fixture is sanitized and no credential is committed
