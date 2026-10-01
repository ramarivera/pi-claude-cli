# Installed release verification

## 0.4.3: auxiliary session isolation

The source gate passed 562 tests, unchanged coverage thresholds, all three typechecks, lint, formatting, the plan validator and 45 offline Node harness checks. All four authenticated Sonnet 5.5 source boundary cases passed for Pi/OMP with CLI/SDK. Plain greetings emitted no steering warning; queued input was admitted and consumed with matching native UUID receipts before the original tool result continued. Both answer markers, native session identity and natural transport cleanup passed. Ownership-free extension completions now use disposable independent sessions, with regressions covering a parked main query alongside successful and aborted auxiliary calls.

Release commit/tag: `1e14da9cc329c1c9fef12d4b6fa01360794aaa2a`. [CI 36793856758](https://github.com/ramarivera/pi-claude-cli/actions/runs/36793856758), [trusted publish 36794096294](https://github.com/ramarivera/pi-claude-cli/actions/runs/36794096294) and the [GitHub release](https://github.com/ramarivera/pi-claude-cli/releases/tag/v0.4.3) succeeded. Registry `latest`, tarball SHA-512 and SLSA source commit/workflow matched the release artifact. Initial version reads hit a cached 404; a fresh read verified publication without another publish attempt.

```text
sha512-LzuAG7Fp1XsHMCHu2oCsePJyVjNqF4daoO1bSAov0AKQB524A1cdiMRWGAS8HcKuLh4N7Sv3sn+cIYNb4n6TOQ==
```

Toolbox exact pins were pushed as `2a0909c6d78ff8f6478a245621a9108fe7f011a0` and targeted-applied. Both actual installed packages and canonical manifests/locks are 0.4.3; OMP's controller keeps the plugin enabled. Complete package roots were backed up before materialization. Only the verified extension tarball was installed, with identical production and peer dependencies. Post-install hashing proved all 56,181 other Pi dependency files, 36,089 other OMP dependency files and 701 retained OMP extension dependency files unchanged. The earlier 0.4.2 historical inventory gap remains separate.

The final authenticated installed matrix passed all four Sonnet 5.5 cases (21 checks including 17 offline harness regressions), with no skipped cases:

| Host | Driver | Result | Local receipt basename                          |
| ---- | ------ | ------ | ----------------------------------------------- |
| Pi   | CLI    | Passed | `installed-boundary-pi-cli-1790813623401.json`  |
| Pi   | SDK    | Passed | `installed-boundary-pi-sdk-1790813662066.json`  |
| OMP  | CLI    | Passed | `installed-boundary-omp-cli-1790813680985.json` |
| OMP  | SDK    | Passed | `installed-boundary-omp-sdk-1790813697584.json` |

Each receipt was independently inspected: installed version/pin 0.4.3, greeting without the warning, preserved system prompt, exact queued/started UUID ordering, one gate/result, both answer markers, one unchanged authoritative Claude session, no history errors, no private transport files, and no forced child/host cleanup or survivors. Pi's owned retry/compaction settings were restored. The harness retained managed companion extensions; OMP's five external MCP servers were disabled only in each owned test session.

The earlier 0.4.3 matrix passed both Pi cases but failed OMP's test attribution: foreign-provider status-200 callbacks were included in Claude identity checks. Those receipts remain failed records. The test observer now classifies responses using the actual native context model, with a regression retaining strict rejection of missing bridge metadata, unknown attribution and changed Claude identity. The final matrix used the unchanged published package; this was a harness correction, not another release.

An additional installed Opus 5.5 OMP/CLI case passed the same greeting, queue, answer, tool/session and cleanup assertions (`installed-boundary-omp-cli-1790814054861.json`), including two independently attributed other-provider callbacks. Its diagnostic command exposed a separate offline guard-order regression, which was fixed; the final offline Node gate passed 46 checks with only the four paid cases skipped. An earlier Opus greeting probe failed with an unclassified native error (`installed-boundary-omp-cli-1790813750901.json`). Its exact historical error text wasn't retained, so `pcc-c2r` remains open; the later passing case doesn't establish that first failure's cause. `PI_CLAUDE_BOUNDARY_KEEP_FAILED=1` now retains private failed-session evidence after owned process cleanup, only with the explicit authenticated E2E opt-in.

An earlier full Toolbox Nushell run recorded 15 unrelated investigated failures (`toolbox-5og`); it wasn’t repeated after concurrent computer-use changes. The exact pin tests and Remnic prompt-adapter tests passed. The 0.4.2 historical nested dependency inventory gap (`pcc-bgy`) remains unverified. Neither limit is counted as a successful check.

## 0.4.2: warning and boundary steering

Published release commit/tag: `8775c679e76cf73fb27545d74dd8fd59fb6b427d`. [Publish workflow 36787214086](https://github.com/ramarivera/pi-claude-cli/actions/runs/36787214086) and [GitHub release](https://github.com/ramarivera/pi-claude-cli/releases/tag/v0.4.2) succeeded. npm's `latest` tag is `0.4.2`; its SLSA attestation identifies that exact source commit and `publish.yml`. Registry integrity matched the checked release tarball:

```text
sha512-S6cecf120KOv+Ns2QpoUDou/jh1tyO0RJG37oAGZmTJOauH4m+3OgpZNJ4qkF14/ZRgjVt3DeAdnChPm4GQCRQ==
```

Toolbox pins were pushed as `219137c57ad0bc03e9b56008fabb13635e112b43` and applied to the two managed targets. Both actual installed packages are `0.4.2`, with OMP's plugin enabled. The source Sonnet 5.5 boundary matrix passed for Pi/OMP and CLI/SDK; each case proved native queue admission and consumption, answer correction, original tool/result ownership, stable session identity and natural Claude cleanup. See the [execution record](../../openspec/changes/fix-claude-steering/execution.md).

The first installed matrix did **not** pass. OMP SDK exposed Remnic dropping OMP's array system prompt; OMP CLI returned an unclassified host error. Pi CLI completed steering but retained an earlier assistant error in history; Pi SDK completed steering then failed the process check after `new_session` created Node/esbuild helpers. Failed receipts remain under `~/dev/agentic-scratchpads/pi-claude-cli/main/receipts/`; they aren't counted as successful runs. Remnic's managed adapter was fixed separately in Toolbox `e8d7ff97d` and verified with four behavior tests before targeted apply and bundle rebuild. Installed validation remains in progress.

### Installation incident and recovery

The initial Pi `npm install --prefix` unexpectedly re-resolved optional peers and unrelated transitive packages. Recovery restored 29 changed root versions from integrity-verified official tarballs, preserved retained nested dependency bytes, quarantined 11 introduced roots, and rebuilt both package locks against 539 actual installed entries. All 486 pre-recorded Pi root names/versions now match except the intended bridge upgrade. The old inventory didn't record two removed and two changed nested paths, so exact historical equality of the complete nested graph remains unverified (`pcc-bgy`). A complete post-incident tree/lock backup and recovery report remain in `main/pi-recovery-20260930T230325Z/` under the scratch directory.

OMP's ordinary npm install stopped at an existing Coding Buddy optional-peer conflict without changing its tree. The bridge was then materialized from the verified registry tarball with unchanged production dependencies; its nested dependencies were retained, and only the relevant Bun/controller entries changed. All 303 recorded OMP root names/versions match except the bridge upgrade. No peer-check bypass was used. The [release runbook](../releasing.md#avoid-re-resolving-managed-package-roots) now requires full backups and avoids re-resolving shared roots for identical-dependency releases.

## 0.4.1

On 2026-09-30, `@ramarivera/pi-claude-cli@0.4.1` was published through npm trusted publishing and installed into the managed Pi and OMP environments on workbench. Both hosts discovered their native entrypoints from the installed package. No source provider entrypoint or inference double was supplied to these checks.

Release code/tag: `c6b605443130c35e216228c4c788e9c9b46e3997`. Toolbox source: `e93ba776c` on `master`. [Publish workflow 36759384096](https://github.com/ramarivera/pi-claude-cli/actions/runs/36759384096) and [GitHub release](https://github.com/ramarivera/pi-claude-cli/releases/tag/v0.4.1) succeeded. npm reported `latest: 0.4.1`, a SLSA provenance attestation, and tarball integrity:

```text
sha512-51IqDJlpzGw/SKikBKcNtzJBh93QiZzVosAhZ5MvecRRYC+FA7bvfS+GJnk30Fm1fiDwsAFSz+SWxSNgSuUkKw==
```

## Authenticated installed-package checks

Pi 0.99.1, compiled OMP 18.4.4, Claude 2.1.285, and Agent SDK 0.3.285 were used with official Claude login. Each case used a fresh scratch session, a random fixture value, and a random native-tool nonce.

| Host | Driver | Result | Local receipt basename                 |
| ---- | ------ | ------ | -------------------------------------- |
| Pi   | CLI    | Passed | `installed-pi-cli-1790793704231.json`  |
| Pi   | SDK    | Passed | `installed-pi-sdk-1790793800604.json`  |
| OMP  | CLI    | Passed | `installed-omp-cli-1790793788703.json` |
| OMP  | SDK    | Passed | `installed-omp-sdk-1790793914058.json` |

Receipts are under `~/dev/agentic-scratchpads/pi-claude-cli/main/receipts/`. Each receipt and its observations were independently checked for exactly one native `read`, exactly one `pcc_sentinel`, no other tool execution, exact fixture/nonce output, and the selected Claude driver/session identity. After `new_session`, Claude children and private MCP files disappeared naturally. Final owned-process cleanup left no survivors.

The managed Pi environment has unrelated Node/esbuild helpers that needed the harness's cleanup fallback after the host exited. Those helpers were present before inference; Claude transport cleanup used no forced termination. OMP needed no child cleanup fallback.

## Test boundaries and findings

- Pi uses `PI_OFFLINE=1` for installed package discovery so these checks don't update unrelated home packages. Claude inference remains online. The instrumented test extension adds observers and synthetic tools; the provider loads only from the managed installed package.
- The existing Pi powerline footer writes five known shortcut-conflict notices to RPC stdout. The installed Pi smoke accepts only those exact notices and records category counts. Unknown output and malformed JSON remain fatal; the default RPC harness remains strict.
- OMP's RPC model picker follows managed `enabledModels`, which excludes Haiku. The smoke verifies unique Claude picker entries and the exact CLI-selected Haiku model through native `get_state`. It doesn't replace the managed model roster.
- The tests restore the Pi retry/compaction flags they change and retain unrelated settings. Claude callback assertions exclude responses from unrelated providers.
- Installed Pi checks found that 0.4.0 rejected the managed `maxRetries: 0` option before inference. Release 0.4.1 accepts that disabled Pi-provider retry policy and retains explicit rejection of nonzero or malformed values. This doesn't change Claude's internal HTTP retry behavior.

The release gates passed 537 unit tests across 29 files, coverage thresholds, 29 offline Node harness tests, all three typechecks, lint, formatting, OpenSpec validation, Linux compiled-host probes, macOS offline checks, and Windows static checks. Windows inference wasn't tested.

Toolbox's scoped Pi/OMP tests and 89 template renders passed. Its full Nushell suite finished with 111 passing modules and 13 failures, all reproduced at unchanged baseline `88396df42f31f1dffcbabea72500c5a8d59503ca` and tracked in `toolbox-5og`. Three pre-existing stdout capture deadlocks were fixed separately. Final targeted Chezmoi diff was empty; unrelated `fnox.toml` remained untouched.

See [release commands](../releasing.md) and [the installed smoke](https://github.com/ramarivera/pi-claude-cli/blob/c6b605443130c35e216228c4c788e9c9b46e3997/tests/e2e/installed.test.mjs). Paid checks remain opt-in.
