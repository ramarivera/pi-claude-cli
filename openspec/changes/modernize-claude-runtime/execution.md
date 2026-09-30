# Implementation authorization and execution record

## Authority

On 2026-09-30 Ramiro instructed: "commit the changes and set a goal for yourself to complete implementation with subagents like ultra mode or whatever, including the live runs". This supersedes the earlier implementation deferral. The full eight-capability scope and four authenticated host/driver combinations remain binding.

Ramiro then clarified: "u in ultra mode with ur subagents in med or high and also sol 6.1 agents". Native worker dispatch uses `gpt-6.1-sol` with medium or high effort, isolated worktrees and no full-history forks. Ultra is reserved for the parent. The parent can't change its running model/effort through the available tools, so it doesn't claim a settings change happened. No external OMP coding-worker lane is used; native Codex workers have their own transcripts and coordinator supervision.

Planning was committed on local `main` as `5c84c41`; no remote push was requested or performed. A goal is active for full implementation and offline/live verification. Completion requires re-reading all specs, checking every acceptance criterion, and recording actual successful live proof.

## Live prerequisites checked

Installed versions: Claude Code 2.1.285, Pi 0.99.1 and OMP 18.4.4. `claude auth status` reports a logged-in first-party Claude Max subscription. No credential was read or copied. Both drivers will use the official runtime's own login unless a separately configured authentication mode is selected. Live requests are authorized, bounded and isolated; this check alone isn't successful inference evidence.

## Approved execution policy

Ramiro approved the dependency/default setup with this correction: "all approved except dont care aboput migration of legacy users there is almost none so that keeps complexity down". Supported/tested targets are canonical Pi 0.99.1, OMP 18.4.4 and Claude Code 2.1.285. Legacy Pi support/migration isn't implemented. Keep the existing provider ID `pi-claude-cli` and root Pi entrypoint, retain CLI as the default, and add explicit SDK selection. New runtime dependencies are pinned Agent SDK 0.3.285 and MCP SDK 1.31.0; current host packages are approved for peer declarations, development typechecks and actual E2E. No CI changes are approved or planned.

Authentication defaults to the official runtime's inherited Claude login. Explicit API-key mode must be configured separately; inherited credential/endpoint conflicts fail clearly rather than silently changing billing. The current environment has `CLAUDE_CONFIG_DIR` set and no API-key/auth-token/base-URL override. Use that selected Claude configuration without copying credentials.

Every advertised host tool uses its native effective schema through the host MCP namespace; disable native Claude tools by default. Optional explicitly configured Claude-native or user MCP tools retain Claude ownership and must never be projected as host calls. CLI uses a resident print-mode process and parked schema-preserving MCP calls rather than killing at message_stop. SDK uses the same authoritative host call correlation through its in-process MCP endpoint. History divergence rebuilds from the complete host transcript under a fresh Claude identity rather than depending on mutable private session-file formats. Same-session continuation stays resident and verifies authoritative init IDs.

Live runs use the existing Max login with a low-cost model, bounded turns and wall-clock limits. Start with a small proof run, inspect usage and cleanup, then execute all four combinations. Captures contain only sandbox data and sanitized protocol metadata. Paid tests stay opt-in in normal use.

## Initial verification and worker findings

The existing baseline passed 296 tests in nine files and `npm run typecheck`. `npm run lint` is clean after fixing the planning validator's Node console import. These are baseline checks, not proof of the new implementation.

Sol 6.1/high contract research distinguished a provider `toolUse` boundary from the underlying Claude result: long-lived sessions and their background pumps must remain parked across host provider rounds. MCP pairing uses the authoritative `_meta["claudecode/toolUseId"]`, not JSON-RPC request IDs; missing IDs fail. Cancellation resolves parked handlers as errors, never fabricated success. Structured tool content/metadata and bounded parked-call deadlines are in the frozen seam.

Sol 6.1/medium harness research selected actual Pi and OMP subprocesses in RPC mode, with isolated `PI_CODING_AGENT_DIR`, OMP `PI_CONFIG_DIR` and sandbox cwd. Preserve the selected `CLAUDE_CONFIG_DIR` for runtime authentication. Real RPC controls cover model selection, prompt, abort, state and saved-session reload; wait for host settlement, not prompt acceptance. OMP native hashline proof pins `PI_EDIT_VARIANT=hashline` and checks read snapshot tags, edit arguments and file bytes. OMP runs under its installed Bun runtime while the test parent may use Node. Source references: Pi config.ts/resource-loader.ts/modes/rpc/rpc-mode.ts; OMP utils/src/dirs.ts/sdk.ts/modes/rpc/rpc-mode.ts/edit/schemas.ts at the versions recorded above.

Unisolated `pi --help` hit a pre-existing theme-package resolution failure (`my-pi-themes@1.0.0`); no model prompt ran. The harness isolates host configuration from its first invocation and doesn't change that unrelated user configuration.
