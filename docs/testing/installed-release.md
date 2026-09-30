# Installed release verification: 0.4.1

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
