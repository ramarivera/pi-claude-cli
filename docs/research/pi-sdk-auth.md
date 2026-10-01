# Pi SDK login and cleanup investigation

October 1, 2026; tracked by `pcc-oc0`. Sol 6.1 independently inspected the SDK
authentication, executable selection and host prompt paths. No login credentials
were extracted, account settings changed or client identity overridden.

## Auth result

A controlled isolated Pi SDK pair changes only the host system-prompt option:

| Prompt                              | Result                                                                                                                                                             | Cleanup                                  |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| `Use native host tools when asked.` | `AUTH_PROBE_OK`; nonzero inference usage                                                                                                                           | Natural; no forced children or survivors |
| Pi's native default prompt          | `API Error: 400 Third-party apps now draw from your extra usage, not your plan limits. Add more at claude.ai/settings/usage and keep going.`; zero reported tokens | Natural; no forced children or survivors |

Both use Pi 0.99.1, Claude Code 2.1.285, Agent SDK 0.3.285, the same official
login directory, selected `claude` executable, host tools, model and runtime
configuration. The official login preflight succeeds. Source and both installed
SDK bundles are identical. Managed Pi SDK inference also succeeds with its smoke
test's custom prompt, so a universal SDK credential failure isn't established.
The maintained reproducer subsequently passed both custom and native prompt
cases on OMP 18.4.4; Pi's native case still fails. This further isolates the
problem from an account-wide SDK entitlement failure.

The evidence implicates the native prompt or resulting request shape. The exact
server classification rule remains unknown; these observations don't establish
that adding funds is necessary. The driver preserves Pi's prompt and lets the
official SDK set its own default attribution. Stripping host identity, switching
drivers or substituting credentials would conceal the failure rather than resolve
this differential.

Anthropic's [current Help Center notice](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
says its June 15 billing change was paused and SDK, `claude -p` and third-party
app usage still draws from subscription limits. The proposed credit scheme below
that notice is historical. The runtime rejection and that notice disagree; an
Anthropic entitlement/classification investigation remains necessary. Don't treat
the error as evidence that the published policy has changed.

The maintained, paid reproducer is `tests/e2e/sdk-auth.test.mjs`. Both prompt
shapes must succeed; an upstream rejection remains a failed test. It preserves
receipts and checks natural transport cleanup even when inference fails. Run in
Nushell with:

```nu
with-env {PI_CLAUDE_SDK_AUTH_E2E: "1"} { node --test tests/e2e/sdk-auth.test.mjs }
```

Set `PI_CLAUDE_SDK_AUTH_HOST` to `omp` for the same control on OMP. These tests
make real requests, use a synthetic no-tool input, disable host retry/compaction,
and bound each Claude session to USD 0.25 and 512 output tokens. They don't enable
extra usage or change the account. Receipts live under the project scratchpads.

## Managed cleanup repair

The original managed Pi smoke counted late Pi intercom Node/esbuild helpers as
Claude transport children. Its inference succeeded before cleanup timed out.
The smoke now shares the boundary suite's exact executable/argv, PID start-time
and ancestry proof. Unknown children and Claude descendants remain strict.
Receipts separately record proven native helpers and forced cleanup; a host kill,
survivor or unverified forced child fails the smoke.

The RPC harness also refuses to reacquire a recycled host PID and signals only
tracked individual process identities. Offline regressions cover ownership,
reparenting, changed identities, unknown children and cleanup accounting. The
actual installed Pi SDK 0.4.4 smoke subsequently executed native read and sentinel
once each and completed with zero forced children, no host kill and no survivors.
The managed Pi CLI smoke also passed with those same cleanup guarantees. Neither
live run needed helper exclusions; offline process regressions exercise that
separate ownership path. Managed retry/compaction settings were restored and the
targeted Chezmoi diff is empty.
