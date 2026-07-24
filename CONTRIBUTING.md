# Contributing

## Development setup

```sh
git clone https://github.com/bircni/aitrack.git
cd aitrack
pnpm install
pnpm run build
node dist/cli.js init
node dist/cli.js sync
node dist/cli.js show
```

Use `pnpm run dev -- init` (or `sync`, `show`) to run from TypeScript without building.

## Project layout

```
src/
  cli.ts              Commander entrypoint
  config.ts           Local config (~/.config/aitrack)
  git.ts              Clone, pull, push data repo
  commands/           CLI command handlers (show, sync, usage, …)
  data/               Types, validation, aggregation, usage loading
  display/            TUI, PNG heatmap, HTML dashboard
    heatmap/          Shared heatmap stats, themes, view models
    html/             HTML render pipeline
  readers/            Provider-specific ingestion (Claude, Codex, Cursor)
  pricing/            Model pricing tables and cost resolution
  cli/                Pure CLI parsing/validation helpers
  **/__tests__/       Tests colocated per module (one __tests__ folder each)
```

Imports use `.js` extensions (Node ESM). Run `pnpm run validate` before opening a PR.

## Commit messages

Commits **must** follow [Conventional Commits](https://www.conventionalcommits.org/) (e.g. `feat:`, `fix:`, `docs:`, `chore:`, `ci:`, `build:`). The changelog and version bumps are generated from commit messages, so non-conforming commits will be invisible in release notes.

## Scripts

| Script                  | Description                                            |
| ----------------------- | ------------------------------------------------------ |
| `pnpm run validate`     | Lint, format, typecheck, test, and unused-export check |
| `pnpm run check:unused` | Knip — unused files, exports, dependencies             |
| `pnpm run test`         | Run tests                                              |
| `pnpm run coverage`     | Run tests with coverage                                |
| `pnpm run build`        | Compile TypeScript to `dist/`                          |
| `pnpm run lint`         | oxlint (type-aware)                                    |
| `pnpm run format`       | oxfmt write                                            |
| `pnpm run format:check` | oxfmt check                                            |

## Releasing

Releases are generated from Conventional Commits using [git-cliff](https://git-cliff.org/). Tagging and pushing happen locally; **npm publish and GitHub Release creation run in CI** when the tag lands on GitHub.

### One-time setup

Configure the `aitrack` package on npm with [GitHub Actions as a trusted publisher](https://docs.npmjs.com/trusted-publishers/) for this repository and `.github/workflows/publish.yml`. The workflow exchanges GitHub's OIDC identity for short-lived npm credentials; do not add a long-lived `NPM_TOKEN` repository secret.

### Cut a release locally

```sh
pnpm run release
```

Patch bump by default. Pass a bump type if needed: `pnpm run release -- minor`.

This runs `validate` and `build`, bumps `package.json`, updates `CHANGELOG.md`, commits, creates the matching `v*` tag, and pushes the current branch plus that exact tag to the configured remote. npm publish and GitHub Release creation happen in CI — not locally.

Preview without changing anything:

```sh
pnpm run release:dry-run
```

The dry run calculates and prints the next version, changelog command, commit, and exact pushes without changing repository files.

### After the tag is pushed

The [Publish workflow](.github/workflows/publish.yml) triggers when the release script pushes its exact `v*` tag. It re-runs `validate`, builds, extracts that tag's section from `CHANGELOG.md`, creates or updates the matching GitHub Release, and runs `pnpm publish --no-git-checks`. Prerelease tags produce GitHub prereleases. Public npm access comes from `publishConfig` in `package.json`; authentication comes from npm trusted publishing through the workflow's `id-token: write` permission.
