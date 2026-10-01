# Releasing

The published fork is `@ramarivera/pi-claude-cli` from `ramarivera/pi-claude-cli`. The unscoped npm package belongs to the upstream author. Keep the scoped name and fork repository in both package metadata and the lockfile. The host provider ID remains `pi-claude-cli`.

## Trusted publishing

The existing npm package must authorize GitHub owner `ramarivera`, repository `pi-claude-cli`, workflow filename `publish.yml`, and direct publishing. The workflow uses a GitHub-hosted runner and `id-token: write`; no npm write token is needed. Any configured environment must match the workflow exactly.

With an interactive npm login and account 2FA, inspect the registration before adding one:

```nu
npm trust list @ramarivera/pi-claude-cli
npm trust github @ramarivera/pi-claude-cli --repository ramarivera/pi-claude-cli --file publish.yml --allow-publish --yes
```

The `npm trust` CLI requires npm 11.15.0 or newer. Publishing via OIDC requires npm 11.5.1 or newer. See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) and [npm trust](https://docs.npmjs.com/cli/v11/commands/npm-trust/).

## Release sequence

1. Update the manifest and lockfile version together. Run the complete Linux offline gate, including the compiled OMP probes, all typechecks, lint, formatting, and the Node harness tests. Inspect `npm pack --dry-run --json` for the correct package name/version, both entrypoints, core/drivers and CLI helper; exclude private or test artifacts.
2. Commit and push `main` after reconciling incoming commits without losing work. Verify the remote commit and successful CI.
3. Create an annotated `v<version>` tag on the verified release commit and push that tag. The publish workflow checks the tag, metadata and release gates before publishing.
4. Verify the npm version, `latest` tag, tarball integrity, entrypoints and provenance, then verify the GitHub release. A failed or uncertain publish must first be checked against the registry before retrying; a published version cannot be overwritten.
5. Pin the published version in Toolbox's Pi package roster and OMP plugin roster. Render/review the targeted Chezmoi diffs before applying. Materialize only the affected package and verify both native entrypoints through package discovery, then run authenticated native-tool smoke checks. Select `pi-claude-cli/...`; an `anthropic/...` selection uses the host's separate Anthropic provider.

Authenticated tests consume account resources and remain opt-in. Existing live receipts establish runtime behavior; a release also needs an installed-package check. Keep receipts and logs under `~/dev/agentic-scratchpads/pi-claude-cli/`, outside the published package.

If pushing a tag doesn't start Actions, dispatch the workflow from `main` with the existing release tag (substitute the version being released):

```nu
gh workflow run publish.yml --ref main --field tag=v0.4.3
```

The workflow resolves the tag to an immutable commit and runs the release gates against it. Publication uses the workflow's actual GitHub source commit for provenance and requires its tarball to be byte-for-byte identical to the tag's tarball. A difference in any packaged file blocks publication. Don't override `GITHUB_REF` or `GITHUB_SHA`: npm checks those values against the signing certificate's source identity.

After installing and deploying the exact pins, run the managed installed-package smoke for each driver:

```nu
with-env { PI_CLAUDE_INSTALLED_E2E: "1", PI_CLAUDE_DRIVER: "cli" } { node --test tests/e2e/installed.test.mjs }
with-env { PI_CLAUDE_INSTALLED_E2E: "1", PI_CLAUDE_DRIVER: "sdk" } { node --test tests/e2e/installed.test.mjs }
```

These tests discover the provider through the real managed configuration and installed package. Pi uses `PI_OFFLINE=1` for package resolution so the smoke doesn't install or update unrelated home packages; Claude inference stays online. Scratch sessions and instrumentation keep test data separate from interactive sessions.

Both OMP smoke cases also run one real native background bash job. An owned controller releases it only after the foreground assistant answer, so its native async-result notification wakes a new provider round with developer input. The checks require exactly one notification, the completion answer, a remembered follow-up and the same resident Claude query. Native status-call observation covers both steering and runtime progress keys because RPC itself suppresses the footer. Routine metadata must never create footer rows; file logging and genuine errors have a separate compiled OMP footer/logger regression.

Before publishing, select `PI_CLAUDE_SOURCE_SMOKE_E2E=1` to run the same behavioral checks against source entrypoints and isolated configuration, with distinct source provenance. `PI_CLAUDE_SMOKE_HOST=omp` selects only OMP; omit it to include Pi. Source checks don't establish installed delivery.

Check native tool discovery using the default host prompt, with no MCP names or editing grammar supplied in the request:

```nu
with-env { PI_CLAUDE_TOOL_DISCOVERY_E2E: "1" } { node --test tests/e2e/tool-discovery.test.mjs }
with-env { PI_CLAUDE_TOOL_DISCOVERY_E2E: "1", PI_CLAUDE_TOOL_DISCOVERY_INSTALLED: "1" } { node --test tests/e2e/tool-discovery.test.mjs }
```

Each of the four cases requires native read/edit/write exactly once, successful correlated results, exact edited/created file bytes, and no shell fallback or claims that these tools are unavailable. Installed mode loads the exact installed entrypoint in isolated configuration; the separate managed smoke above proves package discovery.

Measure Anthropic cache reads separately from session identity:

```nu
with-env { PI_CLAUDE_CACHE_E2E: "1" } { node --test tests/e2e/cache.test.mjs }
with-env { PI_CLAUDE_CACHE_E2E: "1", PI_CLAUDE_CACHE_INSTALLED: "1" } { node --test tests/e2e/cache.test.mjs }
```

This uses the default native host prompt and a synthetic reference prefix above Haiku 4.5's cache minimum. Four turns include two no-tool warm follow-ups around a real native bash call whose arguments a native hook rewrites. The warm turns must retain a nonshrinking large cached prefix, write a small suffix and keep the same Claude session through the correlated tool result. It doesn't infer billing savings from estimated cost, or claim persisted-session restoration after a restart. These checks consume account resources and fail on quota/authentication errors. Case selectors `PI_CLAUDE_TOOL_DISCOVERY_CASE` and `PI_CLAUDE_CACHE_CASE` accept `pi+cli`, `pi+sdk`, `omp+cli`, or `omp+sdk` for bounded reruns. See [session/cache audit](research/claude-session-cache.md).

For the steering release, verify the same four host/driver combinations with a native tool held open and a queued correction:

```nu
with-env { PI_CLAUDE_BOUNDARY_E2E: "1", PI_CLAUDE_BOUNDARY_INSTALLED: "1" } { npm run test:steering }
```

This suite defaults to Sonnet 5.5; `PI_CLAUDE_BOUNDARY_MODEL` overrides the model. It requires exact installed and managed package versions, native admission and consumption receipts, the original tool result once, correction text in the answer, and natural process cleanup. It retains failed receipts instead of treating queue admission as proof that Claude followed the correction.

## Manual fallback

If Actions publishing cannot be used, authenticate interactively with `npm login`, confirm `npm whoami` is the package maintainer, and run `npm publish --access public` from the same checked release commit. Complete any npm 2FA challenge. A manual local publish doesn't claim GitHub Actions provenance. Verify the registry before updating Toolbox.

## Toolbox sources

- `home/.chezmoidata/pi-agent.yaml`: exact `npm:@ramarivera/pi-claude-cli@<version>` package selection, gated by the Claude integration.
- `home/.chezmoidata/omp-harness.yaml`: exact plugin dependency and `pi-claude-cli/...` picker/role selections.
- `home/.chezmoidata/pi-models.yaml`: shared model aliases and their OMP routing, keeping gateway routing separate.

Modify the source templates/data rather than deployed settings, preserve unrelated source changes, and apply only the affected targets. Verify the actual installed version, enabled state and native tool execution before reporting deployment complete.

### Avoid re-resolving managed package roots

Back up the complete installed tree and all package/controller locks before materialization. An ordinary `npm install --prefix` can resolve optional host peers and update unrelated transitive packages, even when the requested extension is the only direct dependency that changes. Don't use `--force` or ignore peer conflicts to install into a shared host root.

For a release with identical production dependencies, fetch its official registry tarball, verify its SHA-512 against registry metadata and the release artifact, and replace only the named extension directory. Preserve its existing nested dependencies, update only its entries in the host's canonical package/controller locks, and compare every other installed package version to the pre-install snapshot. A release with changed dependencies needs a separately reviewed host installation plan. Verify both the actual package and managed settings after materialization; a settings pin alone doesn't install it.
