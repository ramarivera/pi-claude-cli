# Active Claude steering

## Request

On October 1, 2026 Ramiro requested: "implement the unimplemented thing if t3code does". This follows the explicit remaining limit: arbitrary input during token generation through OMP's immediate LiveSteering channel isn't implemented.

## Outcome and finish condition

Verify current T3Code source and Claude runtime semantics. If T3Code supports accepting steering during an active response, implement the equivalent supported behavior through the host-neutral core and the appropriate Pi/OMP host contracts, preserving existing host tool results and resident identity. Do not claim immediate model preemption from queued-input acceptance. Verify meaningful deterministic regressions and actual authenticated host/driver runs for implemented behavior. If T3Code doesn't implement the requested behavior, record the source evidence and explain the condition without inventing feature parity.

## Constraints

Preserve unrelated work, current dependencies, managed configuration and published artifacts. No dependency or CI changes without separate approval. Paid background RPC tests are authorized by the existing live-test scope; no desktop input or focus changes.
