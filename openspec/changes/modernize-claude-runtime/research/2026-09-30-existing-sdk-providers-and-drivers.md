# Existing Pi SDK providers and selectable Claude drivers

Research date: 2026-09-30. Proposal only; implementation remains deferred.

Research task: `task-1790760194397-research-existing-pi-claude-sdk-providers-and-defer-selectable-sdk-cli-driver-de-658f19dc`.

Deferred implementation task: `task-1790754935834-deferred-modernize-pi-claude-cli-and-extract-core-with-pi-omp-adapters-3d78e35a`.

## Requested outcome

Assess selectable official Claude Agent SDK and raw `claude -p` drivers below the shared core, preserving separate Pi and OMP adapters. Find existing Pi.dev extensions that implement SDK-backed inference and inspect the closest primary-source references before recommending reuse. No source implementation, dependencies, tests, installs, or paid model requests in this turn.

## Existing packages: yes, this already exists

Live Pi.dev directory pages list these related provider extensions:

| Package | Directory version/date | Role and relationship |
| --- | --- | --- |
| [pi-claude-bridge](https://pi.dev/packages/pi-claude-bridge) | 0.9.0, September 28 | Claude SDK-backed model provider plus optional AskClaude delegation; original author Eli Dickinson |
| [pi-claude-agent-sdk](https://pi.dev/packages/pi-claude-agent-sdk) | 0.8.6, September 1 | SDK-backed provider fork of pi-claude-bridge maintained in pi-pod |
| [claude-agent-sdk-pi](https://pi.dev/packages/claude-agent-sdk-pi?page=39) | 1.0.22, May 16 | Earlier provider by Prateek Sunal; ancestor of the other two |

These are one related lineage, not three independent new architectures. Source package versions match those directory snapshots. Additional catalog results included [pi-provider-cc-sdk](https://pi.dev/packages/pi-provider-cc-sdk?page=61) and other bridge forks; they weren't deeply inspected. This search confirms existence, not an exhaustive catalog audit or runtime endorsement. The original package's plain directory URL failed through the web reader; the directory URL with its pagination query worked.

The SDK-backed model-provider packages are closer references for Pi-owned tools than T3's Claude-owned tool runtime. T3 remains useful for neutral event contracts, stream/snapshot reconciliation, task linkage, approvals, and session state.

## Source snapshots

Synced clean reference caches via context-research. HEAD matched origin/HEAD:

| Repository | Commit | Checked-out branch |
| --- | --- | --- |
| elidickinson/pi-claude-bridge | `a78a2a5525e96318f8dba7f9fd32ce2191be0136` | main |
| pi-pod/pi-claude-agent-sdk | `5293c03fc1e250725c9e23472eec767a5a302caf` | main |
| prateekmedia/claude-agent-sdk-pi | `de1a64373e1c4839a177802eeeb894f611235ca3` | master |
| durandom/pi-ca-leash | `a3743207cdfffbaf6b7d3a4b5731cf3a9b5713ae` | main |

Cache paths are `/home/ramarivera/.context/<owner>/<repository>`. Subject checkout remains `/home/ramarivera/dev/pi-claude-cli`, clean main at `e0c9a12ac21be4c197e82795f7207746f3183028`.

The current bridge targets canonical Pi peers >=0.86.1 and Agent SDK ^0.3.284; the pi-pod fork targets Pi >=0.82.1 and SDK ^0.3.257; the original targets Pi ^0.74.0 and SDK 0.2.126. Dependency ranges aren't proof of current compatibility. [Bridge package](https://github.com/elidickinson/pi-claude-bridge/blob/a78a2a5525e96318f8dba7f9fd32ce2191be0136/package.json), [fork package](https://github.com/pi-pod/pi-claude-agent-sdk/blob/5293c03fc1e250725c9e23472eec767a5a302caf/package.json), [original package](https://github.com/prateekmedia/claude-agent-sdk-pi/blob/de1a64373e1c4839a177802eeeb894f611235ca3/package.json).

## Closest providers: source-confirmed behavior

| Area | Current pi-claude-bridge | pi-pod fork | Original claude-agent-sdk-pi |
| --- | --- | --- | --- |
| Authentication owner | SDK child inherits process environment and Claude Code auth state; runtime doesn't extract/inject Pi OAuth | Resolves Pi Anthropic auth, removes inherited auth overrides, injects the resolved OAuth/API credential into the SDK child | SDK options don't override env; inherits Claude Code login or API-key environment |
| Tool ownership | Disables Claude native tools, advertises active Pi tools via in-process MCP, parks calls until Pi returns matching results | Same live MCP handoff shape | Denies Claude execution, ends query after proposed tools, builds the next request from Pi history |
| Query continuity | Keeps the query alive across the Pi tool execution boundary; eventually closes/reopens according to session lifecycle | Same general architecture | No SDK resume path found |
| Session/history | Captures Claude identity and resumes/rebuilds/rotates sessions using cc-session-io and Pi history | Similar session-file synchronization; per-query state supports reentrancy/subagents | Uses a tool-result ledger rather than persisted Claude session resume |
| Testing | Offline unit command plus full command with real Pi/Claude integration and installed SDK/CLI contract probes | Offline unit command plus real Pi/Claude integration, subagent and shutdown checks | No tests directory or test script found |
| Host coupling | Canonical Pi API/types, tool schema/context/lifecycle/UI; no distinct OMP adapter found | Pi API/context/auth/lifecycle; no distinct OMP adapter found | Older Pi API/context; no distinct OMP adapter found |

The current bridge calls SDK query with an AsyncIterable prompt, `tools: []`, Pi MCP servers, and the selected cwd/model/resume/executable. On a tool request it completes the current Pi provider stream with a tool-use outcome, while the underlying MCP call waits. Pi executes the tool, invokes the provider again with results, and the bridge resolves the parked MCP call by tool-call ID. This keeps Claude's query alive across that boundary rather than killing Claude. Parallel result delivery must pair by ID, not ordering. [SDK query options](https://github.com/elidickinson/pi-claude-bridge/blob/a78a2a5525e96318f8dba7f9fd32ce2191be0136/src/index.ts#L1956), [MCP correlation](https://github.com/elidickinson/pi-claude-bridge/blob/a78a2a5525e96318f8dba7f9fd32ce2191be0136/src/mcp-server.ts#L29), [tool-result delivery](https://github.com/elidickinson/pi-claude-bridge/blob/a78a2a5525e96318f8dba7f9fd32ce2191be0136/src/index.ts#L1585).

Its session synchronization mirrors Pi history into Claude JSONL files with cc-session-io, detects divergence from compaction/tree/abort changes, and manages rebuild/rotation. Abort closes the SDK query and settles parked prompt/tool channels. These are high-value patterns, but file-layout assumptions, tool-ID metadata and mid-turn prompt priority require executable contract tests: they aren't all guaranteed by public SDK types. [Session synchronization](https://github.com/elidickinson/pi-claude-bridge/blob/a78a2a5525e96318f8dba7f9fd32ce2191be0136/src/index.ts#L725), [prompt-stream assumptions](https://github.com/elidickinson/pi-claude-bridge/blob/a78a2a5525e96318f8dba7f9fd32ce2191be0136/src/prompt-stream.ts#L1), [live contract probes](https://github.com/elidickinson/pi-claude-bridge/blob/a78a2a5525e96318f8dba7f9fd32ce2191be0136/tests/int-cc-contracts.mjs#L1).

Authentication differs materially between the current bridge and its fork. The bridge uses inherited official Claude/SDK login; the fork intentionally constructs its child environment from Pi credentials, including CLAUDE_CODE_OAUTH_TOKEN when applicable. Neither fact by itself establishes product-policy compliance, and neither should be mistaken for a direct HTTP inference transport: both still use the SDK runtime. For the proposed own-subscription setup, explicitly support Claude's own login rather than silently taking credentials from the host. API-key mode and any host-credential mode must be named choices with a clear billing/auth source. [Fork child auth environment](https://github.com/pi-pod/pi-claude-agent-sdk/blob/5293c03fc1e250725c9e23472eec767a5a302caf/src/child-env.ts#L14), [original SDK options](https://github.com/prateekmedia/claude-agent-sdk-pi/blob/de1a64373e1c4839a177802eeeb894f611235ca3/index.ts#L963).

The bridge/fork's full test commands include real inference; their separate unit commands are offline. Don't describe their full test command as harmless or automatically gated behind our proposed opt-in variable. Current bridge contract probes use small Haiku requests/max-turn limits, assert installed runtime assumptions, and explicitly document expensive/uncovered cases. Their tests were read but weren't run here. [Bridge test commands](https://github.com/elidickinson/pi-claude-bridge/blob/a78a2a5525e96318f8dba7f9fd32ce2191be0136/package.json#L28), [real RPC harness](https://github.com/elidickinson/pi-claude-bridge/blob/a78a2a5525e96318f8dba7f9fd32ce2191be0136/tests/lib/rpc-harness.mjs#L19), [fork shutdown regression](https://github.com/pi-pod/pi-claude-agent-sdk/blob/5293c03fc1e250725c9e23472eec767a5a302caf/tests/int-shutdown-kills-cc.mjs#L1).

These providers aren't ready-made framework-neutral shared cores. Reusing the package unchanged may satisfy basic Pi SDK inference, but the requested separate OMP adapter, raw CLI selection, capabilities and four-combination E2E require additional design/work. Prefer the current bridge as the main SDK reference because its host contracts/SDK target are newer and its auth matches the requested Claude-login setup. Consider a fork/extraction versus adapting this repository during implementation; source research doesn't prove either route's live compatibility.

## Direct dual-driver precedent

`pi-ca-leash` has a driver-neutral runtime with actual `ClaudeSdkDriver` and `ClaudeCliDriver` implementations. The interface accepts a run input and event callback and returns kill/done lifecycle control; stateful drivers can implement disposal. SDK is its default driver. [Driver contract](https://github.com/durandom/pi-ca-leash/blob/a3743207cdfffbaf6b7d3a4b5731cf3a9b5713ae/packages/runtime/src/types.ts#L259), [selection/default](https://github.com/durandom/pi-ca-leash/blob/a3743207cdfffbaf6b7d3a4b5731cf3a9b5713ae/packages/runtime/src/runtime.ts#L100).

Its CLI driver constructs `-p --verbose --output-format stream-json`, supports fresh/resumed session IDs and effort, and parses output into normalized driver messages using a parser shared with its SDK driver. Its SDK driver invokes the SDK and aborts via an AbortController. [CLI driver](https://github.com/durandom/pi-ca-leash/blob/a3743207cdfffbaf6b7d3a4b5731cf3a9b5713ae/packages/runtime/src/drivers/claude-cli.ts#L45), [SDK driver](https://github.com/durandom/pi-ca-leash/blob/a3743207cdfffbaf6b7d3a4b5731cf3a9b5713ae/packages/runtime/src/drivers/claude-sdk.ts#L309).

This is a delegated-worker runtime with Claude's tool loop. Its CLI runs a positional prompt and doesn't implement our provider's bidirectional streaming-input/control/tool-result handoff. Its permission defaults must not be copied into a host-owned-tool model. Reuse the driver separation and persistence/selection principles, not the execution policy. This extra reference was inspected narrowly for the driver seam; its whole runtime/test suite wasn't audited.

## Revised proposed architecture

```text
Pi entrypoint  -> Pi adapter  ----+
                                 +-> shared session/event/tool-ownership core
OMP entrypoint -> OMP adapter ----+        |
                                          +-> selected SDK driver -> official Claude runtime
                                          +-> selected CLI driver -> raw claude -p
```

Host adaptation and transport selection are independent axes. OMP-specific edit formats, tasks, provider-session state, UI/lifecycle hooks, and steering stay in the OMP adapter. Pi transcript extraction and output types stay in the Pi adapter. Neither driver imports a host framework.

The common contract should cover requests, correlated interactions, normalized events, authoritative Claude identity, terminal outcomes, cancellation/cleanup, and capability discovery. Raw NDJSON/control framing belongs to the CLI driver; SDK query/message/canUseTool/dialog handling belongs to the SDK driver. Don't force the SDK to impersonate raw control packets or export SDK types into host adapters. Driver-specific capabilities must be explicit rather than assumed identical.

Select a driver explicitly in configuration and retain its identity in session state. Switching drivers must validate or rebuild resume state; matching Claude session IDs alone don't prove identical tool schemas/settings/history. Don't automatically replay a request through the other driver after a failure: it may already have performed tools or consumed paid inference.

Recommendation: prioritize the official SDK driver once it passes host-tool ownership and resume parity, retaining raw CLI as a selectable driver. The SDK offers typed callbacks and managed process protocol; the CLI offers direct control of flags/framing. Use existing Pi provider logic for tool/result/session integration, T3 patterns for normalized event/state design, and BB patterns for fixture/live-test separation. Don't write an SDK provider from scratch before assessing reuse of the existing bridge lineage.

This expands the prior direct-CLI-only recommendation. The requested dual-driver scope is now recorded in the deferred task; choosing or adding dependencies still belongs to later implementation.

## Coverage implications

Keep improved unit/contract tests, sanitized versioned protocol recordings, deterministic process tests, and authenticated live E2E from the prior proposal. Add a common driver conformance suite and live host/driver coverage for all four combinations: Pi+SDK, Pi+CLI, OMP+SDK, OMP+CLI. Assert tool ownership/exactly-once execution, argument formats, result continuity, errors, session resume, cancellation, and cleanup. Optional capabilities require specific assertions or explicit unsupported behavior. Environment gating and bounded account usage remain required. No tests were executed here.

## Is the work still worthwhile given the existing bridge?

Ramiro explicitly asked whether modernizing this repository for both drivers and both hosts remains worthwhile. Recommendation: yes, for that stated scope. Existing SDK providers already solve basic Pi inference and supply valuable tool/session/test patterns; they don't supply the separate OMP adapter, raw-CLI driver selection, neutral shared core and four host/driver live E2E combinations requested here. Reuse their relevant designs, with T3 event/state patterns, and keep OMP-specific capability integration isolated. Maintaining two transports entails continuing contract/version tests; that cost should serve explicit SDK/CLI selection rather than duplicate unneeded host logic. This is a source-informed architectural judgment, not a claim that the implementation already works. The recommendation doesn't authorize beginning implementation; the deferred task remains todo.

## References to preceding research

- [Pi/OMP extension contracts and current CLI gaps](./2026-09-30-extension-contracts.md)
- [T3/BB event designs, explicit live E2E scope, and auth distinction](./2026-09-30-testing-and-reference-designs.md)

## Verification limits

Confirmed directory listings, source entrypoints/auth/tool/session/test paths, dependency targets and default-branch alignment. No installs, tests or live inference were performed. No project files were changed. Additional provider catalog entries were discovery-only; the four named repositories were inspected at the commits above. Existing real test files establish that automation exists, not that it currently passes. Implementing both drivers and both adapters is still deferred.
