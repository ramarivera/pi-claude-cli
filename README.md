# pi-claude-cli

Run Claude through the published `claude -p` runtime or the official Claude Agent SDK, with native entrypoints for [Pi](https://github.com/earendil-works/pi) and [Oh My Pi](https://github.com/can1357/oh-my-pi).

Select the `pi-claude-cli` provider in the host's model picker. CLI is the default driver; set `PI_CLAUDE_DRIVER=sdk` to select the SDK. Both drivers let the official Claude runtime use its own login. The extension doesn't read the host's Anthropic OAuth credentials or construct subscription-authenticated HTTP requests.

## Install the release

```text
pi install npm:@ramarivera/pi-claude-cli@0.5.1
omp plugin install @ramarivera/pi-claude-cli@0.5.1
```

Authenticate with `claude auth login`, restart your host, and select a `pi-claude-cli/...` model. The npm package name is scoped; the provider ID stays `pi-claude-cli`. See [release instructions](docs/releasing.md) and [supported versions](docs/compatibility.md).

## Run from this checkout

Install dependencies with `npm ci`, authenticate the published Claude executable with `claude auth login`, then load the appropriate entrypoint:

```text
pi -e ./index.ts
omp -e ./entrypoints/omp.ts
```

To select SDK in Nushell:

```nu
with-env { PI_CLAUDE_DRIVER: "sdk" } { pi -e ./index.ts }
```

The package manifest exposes `pi.extensions` and `omp.extensions` for each host's package discovery. The root entrypoint loads Pi; `./omp` loads OMP. See [supported versions](docs/compatibility.md).

## Hermes model-provider

`hermes/` contains a separate Hermes plugin registered as `pi-claude-cli`. It runs the compiled Node worker over versioned NDJSON and reuses this repository's core plus the selectable CLI/Agent SDK driver. Hermes still owns its native tools and approvals. The worker stays resident across tool-result calls.

For the published Python distribution, install into the interpreter that runs Hermes, then explicitly download and verify its worker before model calls:

```nu
python -m pip install hermes-claude-bridge==0.5.1
hermes-claude-bridge setup
hermes-claude-bridge status
hermes plugins enable pi-claude-cli
```

The first worker release supports Linux x64 and requires Node >=22.19. See the [Python package guide](python/README.md) for cache ownership, checksums and offline setup. No worker downloads or builds happen on import or inference. API-key authentication is recommended for third-party products; subscription use is subject to Anthropic's terms and isn't an endorsement or ban guarantee.

Alternatively, build and install the local artifact from Nushell:

```nu
$env.HERMES_BUILD_DIR = ($env.HOME | path join "dev" "agentic-scratchpads" "pi-claude-cli" "hermes-provider-build")
npm run typecheck:hermes
npm run build:hermes
let profile_home = ($env.HERMES_HOME? | default ($env.HOME | path join ".hermes"))
^python3 ($env.HERMES_BUILD_DIR | path join "install.py") --artifact $env.HERMES_BUILD_DIR --profile-home $profile_home
with-env { PI_CLAUDE_DRIVER: "sdk" } { hermes --provider pi-claude-cli -m opus }
```

Select `pi-claude-cli` in Hermes's model picker. The SDK route above uses its version-paired official runtime. The shared default CLI driver requires Claude Code 2.1.285 or newer. Versions below 2.2.0 are accepted silently; newer versions warn once and continue. Set `PI_CLAUDE_CLI_STRICT_VERSION=1` to reject versions above the supported range. Pi follows the same policy with `>=0.99.1 <0.100.0`. `PI_CLAUDE_AUTH=api-key` is an explicit billing choice and uses the existing `ANTHROPIC_API_KEY` configuration. The plugin doesn't read Hermes/Pi OAuth credentials or provide subscription usage. The installer refuses an existing provider directory and doesn't change active model or login settings. See [Hermes installation, behavior and limits](hermes/README.md).

## Tools and sessions

Each host supplies its effective tools and native JSON schemas. Claude calls them through the reserved `host` MCP namespace; Pi or OMP executes them, and the correlated results return to the parked Claude request. The runtime keeps a resident process/query across host tool rounds rather than killing Claude at an assistant-message boundary. For a completed batch, the host may execute proposed calls before every MCP handler arrives. The core holds those results until each actual handler matches the completed call's ID, name and arguments.

Native Claude tools are disabled by default. Explicitly configured Claude tools or user MCP servers execute under Claude ownership. They aren't renamed into host tools. OMP keeps its own hashline, apply-patch and replacement edit formats, distinct glob/search tools and timeout units.

The shared core reconciles streaming deltas and assistant snapshots, preserves thinking signatures and attributed progress, and reports result/error boundaries. Host history, tool schemas, cwd, branch and settings determine whether a resident session can continue. Divergent or imported history is rebuilt as labelled user-history replay; this isn't native restoration of private Claude session files. Failed turns don't automatically retry through the other driver.

Both drivers support queued steering at host tool boundaries: supplemental input is admitted by Claude before the original tool results are released. OMP additionally accepts corrections while text streams, transferring its claim only after native queue admission and continuing through the same Claude session without resending the correction. Pi retains its native boundary queue. Active input uses `next` delivery; it doesn't request arbitrary token-generation interruption. See [the versioned steering research](docs/research/claude-steering.md).

## Configuration

Both entrypoints use the same environment settings. Restart/reload the extension after changing them.

| Variable                          | Default        | Meaning                                                                                                  |
| --------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------- |
| `PI_CLAUDE_DRIVER`                | `cli`          | `cli` or `sdk`                                                                                           |
| `PI_CLAUDE_AUTH`                  | `claude-login` | Official login, or explicitly selected `api-key` billing                                                 |
| `PI_CLAUDE_EXECUTABLE`            | Driver default | Published Claude executable path                                                                         |
| `PI_CLAUDE_EFFORT`                | Unset          | Model-supported `low`, `medium`, `high`, `xhigh` or `max`                                                |
| `PI_CLAUDE_MAX_TURNS`             | Unset          | Positive integer Claude turn bound                                                                       |
| `PI_CLAUDE_MAX_OUTPUT_TOKENS`     | Unset          | Positive safe integer output cap per Claude response; combined with the host cap using the smaller value |
| `PI_CLAUDE_MAX_BUDGET_USD`        | Unset          | Positive Claude budget bound                                                                             |
| `PI_CLAUDE_TOOL_TIMEOUT_MS`       | `180000`       | Deadline for dispatch after a completed tool proposal and for parked host results                        |
| `PI_CLAUDE_SHUTDOWN_TIMEOUT_MS`   | `5000`         | Driver shutdown deadline                                                                                 |
| `PI_CLAUDE_INTERNAL_TOOLS`        | `[]`           | JSON array of explicitly enabled Claude tool names                                                       |
| `PI_CLAUDE_MCP_CONFIG`            | Unset          | File containing explicitly configured user `mcpServers`                                                  |
| `PI_CLAUDE_FORWARD_SUBAGENT_TEXT` | `0`            | Set `1` to forward attributed Claude subagent text                                                       |
| `PI_CLAUDE_RESUME_DIAGNOSTICS`    | `0`            | Set `1` to log each session's resume mode, restoration and rebuild reason                                |
| `PI_CLAUDE_NATIVE_RESUME`         | `0`            | Set `1` to use SDK native persistence after a clean close instead of replaying host history              |

Login mode rejects inherited API-key, auth-token, endpoint and cloud-provider overrides rather than silently changing authentication or billing. `CLAUDE_CONFIG_DIR` can select the official runtime's existing login configuration. API-key mode requires `ANTHROPIC_API_KEY`; `ANTHROPIC_BASE_URL` is optional in that mode. No token is copied into host auth storage.

User MCP configuration accepts explicit stdio (`command`, `args`, `env`) or HTTP/SSE (`type`, `url`, `headers`) servers. `host` is reserved. Host settings and implicit user MCP discovery are disabled by default.

## Verification

```text
npm run test:offline
npm run typecheck:pi
npm run typecheck:omp
npm run lint
npm run test:coverage
npm run verify:plan
```

Offline tests don't make authenticated model calls. `npm run test:live` reports four skipped combinations unless `PI_CLAUDE_LIVE_E2E=1`; enabled runs require the actual hosts, official Claude runtime and selected credentials. They consume real account resources. The live harness and its receipts are documented under [live harness and receipts](docs/testing/live-harness.md).

`npm run test:steering` runs offline checks and skips its six actual-host
cases unless `PI_CLAUDE_BOUNDARY_E2E=1`. Set `PI_CLAUDE_BOUNDARY_CASE=omp+cli`
(or another host/driver pair) to select one paid queued-steering case.
These cases default to Sonnet 5.5. Set `PI_CLAUDE_BOUNDARY_INSTALLED=1` with the
inference opt-in to test the actual managed installed release.

## Architecture

```mermaid
flowchart LR
  Pi[Pi entrypoint and adapter] --> Core[Host-neutral session and event core]
  OMP[OMP entrypoint and adapter] --> Core
  Core --> CLI[Resident claude -p driver]
  Core --> SDK[Official Agent SDK driver]
  CLI --> Claude[Published Claude runtime]
  SDK --> Claude
```

The core and drivers import neither host. OMP session state, progress presentation and native formats stay in the OMP adapter; the Pi entrypoint doesn't initialize OMP. OMP exposes attributed progress on `pi-claude-cli:observation` and bounded message/tool correlation diagnostics on `pi-claude-cli:diagnostic`; the diagnostic bus excludes text, tool arguments, schemas and credentials. Routine runtime metadata goes to OMP's native file logger rather than status rows below its prompt bar; genuine errors retain native reporting.

## License

MIT
