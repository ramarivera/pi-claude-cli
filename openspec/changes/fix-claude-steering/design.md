# Design

## Native boundaries

`DriverPrompt.steering = "tool-boundary"` distinguishes a continuation of an active parked turn from an ordinary new prompt. Core supplies priority `next`: priority `now` aborts tools in the pinned Claude 2.1.285. The original tool results remain held until the driver acknowledges admission.

Both drivers attach a UUID, consume internal `command_lifecycle` frames, and match state `queued` against that UUID. Local queue insertion and successful stdin writes don't attest native admission. This is an explicitly pinned native contract, absent from the public SDK message union. A receipt deadline or session shutdown rejects the continuation rather than silently dropping input. Internal frames don't become UI diagnostics.

OMP's `LiveSteering` presence alone triggers no claim, status, notification or capability warning. The host's existing queue owns input until it supplies boundary steering in transcript normalization. Capability metadata states `tool-boundary`. Provider failures retain native assistant error reporting.

## Version delta

T3 Code supplies persistent SDK queue messages without a `priority` or interrupt call; its steering regression uses a fake query. Claude 2.1.286 backgrounds certain active tools for `now` with UUID/human-origin input, but pure-text generation and fallback cases still interrupt. Immediate steering therefore requires a separate old-result/new-turn coordinator and background-tool ownership design. No dependency upgrade is part of this fix.

## File ownership

The integration owner owns production contracts, core, transports, OMP adapter, SDK/core unit tests, specs and release. Research lanes own `docs/research/claude-steering.md` and CLI fixture/tests. The E2E lane owns boundary harness/fixtures and receipt unit tests. Parent reviews all diffs and coordinates paid runs.
