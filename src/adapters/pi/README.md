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
`onPayload` receives a cloned round request with API keys redacted. A returned
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
explicitly unsupported; the drivers accept `low`, `medium`, `high`, `xhigh` and
`max` subject to the exact model's reported capabilities.
Models with reasoning disabled reject an explicit effort. Custom fetch/headers,
HTTP retry and timeout settings, sampling/temperature/token limits, transport
preferences, metadata, tool choice, deferred responses and custom thinking token
budgets are explicitly unsupported. Native signal cancellation is passed to
core; cache retention and request affinity don't define Claude persistence.

Source contract: installed canonical packages 0.99.1 and pinned Pi source
`1b347794e2a630e4359f2584f4eea388145d0ddf`, particularly `packages/ai/src/types.ts`,
`packages/ai/src/utils/transcript.ts` and
`packages/coding-agent/src/core/extensions/{types,loader,virtual-modules}.ts`.
