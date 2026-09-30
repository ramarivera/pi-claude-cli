## ADDED Requirements

### Requirement: Empty native queues are silent

The OMP adapter SHALL NOT report an unsupported steering request merely because a native LiveSteering channel exists.

#### Scenario: Ordinary hello

- **WHEN** OMP supplies a steering channel but the user sends only a hello
- **THEN** the response completes without steering warnings, capability errors or queue claims

### Requirement: Boundary input is admitted before results

Both production drivers SHALL support same-turn host tool-boundary steering through pinned Claude `next` input. Core SHALL wait for native queue admission before releasing original correlated tool results.

#### Scenario: Steering while a host tool runs

- **WHEN** the host queues supplemental input while a native tool runs and supplies it with the original result
- **THEN** Claude receives the supplemental instruction before the result can finish the turn, the original result survives exactly once, and the resident session is retained

#### Scenario: Missing native admission

- **WHEN** stdin has accepted the input but a matching native queue receipt hasn't arrived
- **THEN** the continuation remains pending until a matching receipt, bounded deadline or session closure, and no internal lifecycle packet is shown as a UI warning

### Requirement: Steering capabilities remain precise

The drivers SHALL advertise tool-boundary steering and SHALL reject immediate preemption until interrupted-result handoff is implemented. Genuine failures SHALL use host-native assistant error reporting.

#### Scenario: Native version offers partial backgrounding

- **WHEN** research finds that a newer Claude runtime can background some active tools but still interrupts pure text
- **THEN** that behavior SHALL NOT be described as universal joined-turn steering or enabled by an unverified dependency bump
