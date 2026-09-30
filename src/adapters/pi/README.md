# Current Pi adapter

`registerPiAdapter(pi, options?)` registers `pi-claude-cli` for canonical Pi
0.99.1. `entrypoints/pi.ts` delegates to that factory. The native host's public
`VERSION` is checked at registration; other releases fail explicitly.

The adapter reads `getCurrentSystemPrompt` and `getCurrentTools` from Pi's
normalized transcript. Those effective native JSON schemas define the host MCP
inventory. It never activates tools or reads the configured inventory. The
public `providers/all` catalog and stream factory resolve to the host's module
instances through Pi's extension loader.

Both transports use the neutral `ClaudeRuntime` and common configuration.
`onPayload` receives a cloned round request with API keys and all configured MCP
server environment/header values redacted. A returned
replacement can change model input or restrict the effective tool inventory;
credentials, session ownership, settings and cancellation remain owned by the
adapter. Invalid replacement shapes fail the round.

`onResponse` runs once per round on the first actual driver event, with status
`0`, the selected driver/transport and authoritative Claude session ID when
known. There is no HTTP response status for either runtime transport.
`onProviderStreamEvent` receives cloned normalized driver DTOs before host event
projection. Callback failures terminate with a Pi AssistantMessage error.

Text/thinking deltas and snapshots reconcile by message ID and original content
index. Only authoritative effective host calls are projected as native tool
calls. Claude owned tool proposals and attributed subagent text aren't surfaced
as parent output. Thinking signatures, response models and incremental round
usage survive projection. Catalog costs aren't used to invent usage; a reported
Claude cost is recorded as a USD estimate, with unknown component costs zero.

Supported Pi reasoning levels pass through as Claude effort. Pi `minimal` is
explicitly unsupported and is disabled in the registered thinking-level map;
the drivers accept `low`, `medium`, `high`, `xhigh` and `max` subject to the
exact model's reported capabilities. Models with reasoning disabled reject an
explicit effort. Native `maxTokens` becomes `settings.maxOutputTokens`, which
the drivers implement through Claude's documented output-token setting.

Native provider defaults work: `transport: "auto"`, `timeoutMs: 300000`, and
`maxRetryDelayMs: 60000`. `timeoutMs` is a driver-activity idle bound, reset after
each actual driver event and suspended while Pi executes host tools. A value of
zero disables it. Pi's disabled-timeout sentinel is accepted. The default
HTTP retry-delay setting is inapplicable to these transports; custom retry
delays and provider retry counts are rejected. Custom fetch/headers, sampling,
explicit transport preferences, WebSocket settings, metadata, tool choice,
deferred responses and custom thinking token budgets remain unsupported. Both
current drivers reject tool-boundary steering before opening/replaying a query or
consuming tool results; the adapter retains the steering input so core can report
that unsupported capability without silently dropping or repeating it.

Each extension instance owns its runtime and a map of host session identities.
Ordinary leaf changes keep the same branch and history revision. Successful
compaction, tree navigation, fork/import and reload create an explicit revision
boundary. Model, cwd, prompt, effective tool schema, settings and history changes
reach core unchanged so its digest/resume policy makes the persistence decision.
Saved host history has no verified native Claude persistence: core labels its
restoration as user history replay rather than claiming a Claude session resume.

Quit/reload closes the owned runtime; new/resume/fork session replacement closes
only the outgoing session family. Pi summaries use independent provider routing
IDs: those auxiliary sessions retain the captured cwd, and close on completion,
failure or cancellation without invalidating a parked parent. Native compaction
output limits are supported through the same neutral setting as normal output.
Concurrent host sessions and separate extension instances stay isolated; a second
active provider round for one identity reports an explicit reentrancy error.

Cancellation stays bound after a `toolUse` provider boundary so aborting a slow
host tool settles Claude's parked call immediately. The listener is replaced for
the next result round and removed after final output, history invalidation or
shutdown. An abandoned parked call is invalidated when Pi's agent loop ends.
Cleanup failures are reported while final runtime cleanup is still attempted.
Subagent text remains separately attributed in `onProviderStreamEvent` rather
than becoming parent assistant history; optional subagent forwarding enables
those observations through core. Host-only tools aren't delegated to Claude
subagents.

Source contract: installed canonical packages 0.99.1 and pinned Pi source
`1b347794e2a630e4359f2584f4eea388145d0ddf`, particularly `packages/ai/src/types.ts`,
`packages/ai/src/utils/transcript.ts` and
`packages/coding-agent/src/core/extensions/{types,loader,virtual-modules}.ts`.
