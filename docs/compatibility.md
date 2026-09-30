# Supported versions

This modernization targets current releases only. There isn't a legacy Pi adapter or migration layer.

| Component                          | Target           |
| ---------------------------------- | ---------------- |
| Node.js                            | 22.19.0 or newer |
| Canonical Pi (`@earendil-works/*`) | 0.99.1           |
| Oh My Pi (`@oh-my-pi/*`)           | 18.4.4           |
| Published Claude Code executable   | 2.1.285          |
| Official Claude Agent SDK          | 0.3.285, pinned  |
| MCP SDK                            | 1.31.0, pinned   |

The CLI driver checks the executable version before inference. The package declares current host peers; a newer host or Claude release needs contract and live verification before adding it to the tested matrix. The root entrypoint and provider ID remain `pi-claude-cli`.

The CLI host-tool bridge uses a private Unix-domain socket and process-group cleanup. Windows isn't supported by this driver. Linux is the current live-verification environment; macOS support requires its own live evidence. SDK transport also needs a supported official Claude executable/runtime.

Both drivers require authoritative `_meta["claudecode/toolUseId"]` on host MCP calls. That's a guarded Claude protocol extension, not a generic MCP guarantee. Missing correlation fails explicitly; the bridge never substitutes JSON-RPC IDs or guesses from call order.

Same-process continuation retains the resident Claude identity. Imported or changed host history can be replayed under a fresh Claude identity. This replay labels the complete host history as user-provided context; it doesn't import private Claude JSONL files or claim native assistant-turn persistence. OMP steering remains queued when the selected driver doesn't support live steering.

Provider payload callbacks receive the host-neutral request. Transport response observations use status `0` and transport metadata for these subprocess/query transports; they don't invent an HTTP response. Error/abort results carry each host's actual assistant-message shape.

The repository records approved scope and pinned research in `openspec/changes/modernize-claude-runtime/execution.md`. Target declarations alone aren't verification receipts.
