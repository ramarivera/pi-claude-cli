# Quiet OMP runtime metadata

Beads: `pcc-22n` (footer reporting), `pcc-tvo` (background completion), `pcc-6vb` (native tool discovery), `pcc-k4z` (session/cache audit).

## Report and outcome

Ramiro reported `Claude status: thinking_tokens [turnId=…]` beneath OMP's prompt/status bar. Installed 0.4.3 and current source forwarded routine observations to `ctx.ui.setStatus`; OMP 18.4.4 renders that API as an extra plain footer row. The prior warning regression covered only the steering status key and missed runtime progress.

Move routine runtime metadata to OMP's native file logger and preserve the observation bus. Keep genuine error reporting. Extend deterministic native footer and authenticated installed-package checks to cover both status keys. Publish the verified fix and pending active-input implementation as 0.4.4 through the existing trusted workflow, then bump and materialize the exact managed Pi/OMP pins. Preserve unrelated Toolbox changes and installed dependencies.

Ramiro subsequently reported a completed native background task followed by `OMP round requires a trailing user message or tool results`. OMP converts async-result notifications to developer input. Handle that input, including image splits and notifications alongside host tool results, without losing message order or rebuilding a matching resident session.

Ramiro then reported Claude claiming `edit` and `write` weren't available before discovering `mcp__host__*`. The supplied session subsequently executed native `edit` successfully; the inventory wasn't missing that tool. Both drivers pass native host instructions unchanged while exposing prefixed MCP dispatch names. Supply a shared transport-level name map for the actual exposed inventory, preserve original instructions and schemas, and verify real read/edit/write operations with the default native host prompt. The live request mustn't reveal the wire prefix or editing grammar, and shell fallback or failed tool results must fail the check. Hold publication until this additional complaint is addressed.

## Finish condition

Ramiro requested a diligent BB/T3Code session/cache comparison and an independent Sol 6.1 second opinion. Track actual cache-read/write measurements separately from resident IDs. Repair confirmed native hook-argument acknowledgement and opaque-thinking round-trip mismatches while preserving exact historical validation. The cache matrix must exercise native argument revision and measured warm reuse on the final fingerprint; historical small-case hits don't validate the user's large-conversation trace. Publication remains gated on current-source live checks.

The native footer stays clean across routine observations, including the exact reported thinking event. Metadata remains available in file logs without raw response/payload data. Real errors remain reported. Native background completion wakes the provider with preserved roles/order and a resident follow-up. The verified registry artifact and managed installed packages agree, and actual native host tests pass with status-call observation and real background-job delivery enabled. Existing user processes aren't restarted or given foreground input automatically.
