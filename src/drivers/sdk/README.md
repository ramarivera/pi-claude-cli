# Official SDK driver

The public factory is `createSdkDriver`. Production composition injects the shared
`normalizerFactory`; offline verification can inject `query` or `loadSdk`. The
official Agent SDK is imported only when opening a session. Supported source
contracts are Agent SDK 0.3.285, MCP SDK 1.31.0 and Claude Code 2.1.285. These
versioned source contracts and offline tests aren't authenticated inference proof.

The driver passes explicit cwd, model, system prompt, executable, effort and limits
to official `query`, with a persistent `AsyncIterable<SDKUserMessage>` prompt input.
Acknowledgment occurs when the SDK resumes the input generator after consuming
the message. The event pump continues across result boundaries and host tool
rounds. Streamed user messages omit `uuid` so the official runtime assigns it.
Prompt priorities other than absent or `next` fail as unsupported steering.

Login mode preserves the selected `CLAUDE_CONFIG_DIR` and rejects inherited
credential, endpoint and cloud-provider overrides. Explicit API-key mode clears
those overrides and supplies the selected key and optional endpoint. Credentials
are never extracted from Claude login or borrowed from a host provider.

Host-owned tools live under MCP namespace `host`. A `McpServer` wrapper supplies
the SDK's public instance type; handlers use its underlying protocol `Server`
for `tools/list` and `tools/call`. Native JSON schemas, tool metadata and structured
results are preserved without conversion through Zod tool registration. The MCP
client's standard schema may discard nonstandard annotation keys, so the offline
suite also checks the actual MCP wire result.

Only `_meta["claudecode/toolUseId"]` identifies a parked host call. Missing IDs,
unknown host tools, conflicting IDs or conflicting results fail explicitly.
Repeated identical calls share the same parked result and don't emit another host
execution request. Results delivered before a matching call are retained by ID.
Every handler has a wall-clock deadline; the runtime's per-server timeout is set
as well (its published minimum is 1000 ms). Interrupt and close settle pending
calls with `isError: true`, clear their timers and cancel interactions.

An actual newly parked handler emits `host_tool_request`, immediately followed by
the diagnostic observation `host-mcp-park`. Its data contains only `toolUseId`,
`toolName` and `serverName`; it includes no arguments or results. Identical calls
don't emit a second observation. The observation shares session/turn/tool-use
attribution and the normal monotonic event sequence.

In installed Agent SDK 0.3.285, `readMessages()` starts `handleControlRequest()`
without awaiting it. The MCP control handler awaits its response independently;
`readSdkMessages()` continues yielding frames from the input stream. The offline
official-SDK regression uses a fake no-inference executable to emit
`message_stop` and an assistant snapshot after a host call parks, and verifies
that both reach the actual SDK iterator before the host result is supplied.
This proves decoder concurrency; it doesn't assert which frames the real Claude
runtime emits while its tool handler is parked.

Native Claude tools are disabled by default. Explicit native tools and user MCP
servers retain Claude ownership. User server names cannot replace `host`.
Host permission bypass requires exact owned tool name and SDK provenance;
untrusted same-name servers don't qualify. Permission and elicitation callbacks
route by official control request IDs. No user-dialog callback is installed and
no dialog kind is advertised.

Core owns resident/history decisions. Resident continuation reuses the same driver
session; `resume` uses the published SDK option only when core has verified
persistence. A mismatching authoritative initialization ID fails explicitly.
Divergence opens a fresh runtime and prepends labelled prior host
history, including images and call/result IDs, to the current prompt. Core must
exclude current input from `replayTranscript`. No private session file is changed.

Shutdown waits for the owned query pump and MCP server within `shutdownTimeoutMs`
(default 5000 ms). It drains MCP response writes before closing their transport;
JSON-RPC IDs are used only for response-drain accounting, never tool correlation.
SDK `close()` is the published process/transport termination
operation. A transport that violates that operation's settlement guarantee causes
a bounded close rejection; the driver doesn't claim that such a transport stopped.
