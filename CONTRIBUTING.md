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

Releases are generated from Conventional Commits using [git-cliff](https://git-cliff.org/). Tagging and pushing happen locally; **npm publish runs in CI** when the tag lands on GitHub.

### One-time setup

Add an `NPM_TOKEN` secret to the GitHub repository (npm → Access Tokens → Granular or Classic with publish permission).

### Cut a release locally

```sh
pnpm run release
```

Patch bump by default. Pass a bump type if needed: `pnpm run release -- minor`.

This runs `validate` and `build`, bumps `package.json`, updates `CHANGELOG.md`, commits, tags (`v*`), and pushes branch + tag. npm publish happens in CI — not locally.

Preview without changing anything:

```sh
pnpm run release:dry-run
```

### After the tag is pushed

The [Publish workflow](.github/workflows/publish.yml) triggers on `v*` tags (local `git push --tags`), re-runs `validate`, builds, then publishes with `pnpm publish --provenance --access public` and `NPM_TOKEN` — same pattern as [GitHub's npm publish guide](https://docs.github.com/en/actions/tutorials/publish-packages/publish-nodejs-packages#publishing-packages-to-the-npm-registry).
