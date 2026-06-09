# pi-claude-cli

A [pi](https://github.com/mariozechner/pi-coding-agent) extension that routes LLM calls through the [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) as a subprocess. Use your Claude Pro/Max subscription as the LLM backend — no API key, no separate billing.

## How it works

The extension registers as a custom pi provider exposing all Claude models. Each request spawns a `claude -p` subprocess using the stream-json wire protocol, with `--resume` on follow-up turns to reuse the CLI's session state instead of replaying full history. Claude proposes tool calls, pi executes them natively. Custom pi tools are exposed to Claude via a schema-only MCP server.

## Requirements

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated (`claude` on PATH)
- A Claude Pro or Max subscription
- [pi](https://github.com/mariozechner/pi-coding-agent) or [GSD](https://github.com/gsd-build/gsd-2)

## Installation

Add to `~/.gsd/agent/settings.json`:

```json
{
  "packages": ["npm:pi-claude-cli"]
}
```

Then select a Claude model via `/model` in the interactive UI. All Claude models appear under the `pi-claude-cli` provider.

## Features

- Streams text, thinking, and tool call tokens in real-time
- Maps tool names and arguments bidirectionally between Claude and pi
- Exposes custom pi tools to Claude via MCP (schema-only, no execution)
- Break-early pattern prevents Claude CLI from auto-executing tools
- Session resume via `--resume` eliminates history replay on follow-up turns
- Configurable thinking effort with elevated budgets for Opus models
- Cross-platform subprocess management (Windows, macOS, Linux)
- Inactivity timeout and process registry for cleanup

## Local development & testing

This checkout is **live-loadable** without publishing to npm. A self-import shim
re-exports the real entrypoint so `pi` can load the working tree directly:

```
.pi/extensions/pi-claude-cli/index.ts   ->  re-exports ../../../index.ts
```

Load only this checkout (and skip globally-installed packages, which would
register a duplicate `pi-claude-cli` provider):

```sh
pi --no-extensions --extension ./.pi/extensions/pi-claude-cli/index.ts --list-models claude
```

### Tests

```sh
npm install            # installs cross-spawn + @earendil-works/pi-* types
npm test               # unit tests (vitest) — no network
npm run typecheck      # tsc --noEmit
npm run test:e2e       # live e2e: spawns pi + Claude CLI, asserts a real reply
```

The e2e (`e2e/say-something.e2e.ts`) spawns a real `pi` process against the local
shim, selects `pi-claude-cli/claude-haiku-4-5`, and asserts the model actually
replies — guarding against the silent "empty response" failure mode. It requires
an authenticated Claude Code CLI on PATH and is intentionally excluded from
`npm test` (the `.e2e.ts` suffix is outside the unit glob). Override the model
with `PI_CLAUDE_E2E_MODEL`.

> Requires `pi` built on `@earendil-works/pi-ai` (0.7x+). This package's peer
> dependencies target `@earendil-works/pi-*`; the legacy `@mariozechner/pi-*`
> names are no longer used.

## License

MIT
