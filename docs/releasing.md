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

## Manual fallback

If Actions publishing cannot be used, authenticate interactively with `npm login`, confirm `npm whoami` is the package maintainer, and run `npm publish --access public` from the same checked release commit. Complete any npm 2FA challenge. A manual local publish doesn't claim GitHub Actions provenance. Verify the registry before updating Toolbox.

## Toolbox sources

- `home/.chezmoidata/pi-agent.yaml`: exact `npm:@ramarivera/pi-claude-cli@<version>` package selection, gated by the Claude integration.
- `home/.chezmoidata/omp-harness.yaml`: exact plugin dependency and `pi-claude-cli/...` picker/role selections.
- `home/.chezmoidata/pi-models.yaml`: shared model aliases and their OMP routing, keeping gateway routing separate.

Modify the source templates/data rather than deployed settings, preserve unrelated source changes, and apply only the affected targets. Verify the actual installed version, enabled state and native tool execution before reporting deployment complete.
