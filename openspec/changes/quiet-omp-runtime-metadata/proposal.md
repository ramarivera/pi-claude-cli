# Quiet OMP runtime metadata

Beads: `pcc-22n` (footer reporting), `pcc-tvo` (background completion).

## Report and outcome

Ramiro reported `Claude status: thinking_tokens [turnId=…]` beneath OMP's prompt/status bar. Installed 0.4.3 and current source forwarded routine observations to `ctx.ui.setStatus`; OMP 18.4.4 renders that API as an extra plain footer row. The prior warning regression covered only the steering status key and missed runtime progress.

Move routine runtime metadata to OMP's native file logger and preserve the observation bus. Keep genuine error reporting. Extend deterministic native footer and authenticated installed-package checks to cover both status keys. Publish the verified fix and pending active-input implementation as 0.4.4 through the existing trusted workflow, then bump and materialize the exact managed Pi/OMP pins. Preserve unrelated Toolbox changes and installed dependencies.

Ramiro subsequently reported a completed native background task followed by `OMP round requires a trailing user message or tool results`. OMP converts async-result notifications to developer input. Handle that input, including image splits and notifications alongside host tool results, without losing message order or rebuilding a matching resident session.

## Finish condition

The native footer stays clean across routine observations, including the exact reported thinking event. Metadata remains available in file logs without raw response/payload data. Real errors remain reported. Native background completion wakes the provider with preserved roles/order and a resident follow-up. The verified registry artifact and managed installed packages agree, and actual native host tests pass with status-call observation and real background-job delivery enabled. Existing user processes aren't restarted or given foreground input automatically.
