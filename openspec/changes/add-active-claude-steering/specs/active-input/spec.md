# Active Claude input

## ADDED Requirements

### Requirement: Active input admission

The OMP entrypoint SHALL consume supported user steering from the native active-input channel while an assistant message streams. The core SHALL submit UUID-bearing `next` input through the selected resident CLI or SDK driver and transfer host ownership only after native admission. An empty queue SHALL produce no warning or unsolicited output.

#### Scenario: Correction during generated text

- **WHEN** native OMP steering arrives after a real text delta and before the assistant message ends
- **THEN** the selected Claude driver acknowledges the queued command
- **AND** its exact command UUID is subsequently consumed once
- **AND** the correction is recorded once in native host history

### Requirement: Continuation ownership

The core SHALL recognize the exact accepted input in the host's subsequent provider request and continue from the original resident driver without resubmitting it. Native continuation events arriving before that request SHALL remain available. Original native completion events SHALL not finalize an unconsumed correction. Buffer overflow, uncertain admission and missing consumption SHALL fail explicitly and clean up owned resources.

#### Scenario: Native continuation precedes host request

- **WHEN** the resident Claude query starts or completes a queued correction before OMP's next provider request
- **THEN** the next request receives the retained continuation
- **AND** no duplicate Claude prompt or replacement Claude session is created

### Requirement: Native boundaries remain safe

Every active claim SHALL settle once. Unsent input SHALL remain host owned. Aborts, invalidation and shutdown SHALL stop the pump, settle in-flight claims and remove owned timers/processes/files. Parked host tool results SHALL retain their original call IDs, values and exactly-once delivery. Pi's current provider API SHALL continue to use its native boundary queue without importing OMP types or claiming an unavailable active channel.

#### Scenario: Claim cannot be delivered

- **WHEN** a claim becomes available after completion, has unsupported content, or cannot obtain native admission
- **THEN** it isn't reported as successfully delivered
- **AND** host-owned input isn't silently lost
- **AND** any uncertain resident query is invalidated through native error reporting
