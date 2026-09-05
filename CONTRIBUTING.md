# Contributing

## Development setup

```sh
git clone https://github.com/bircni/aitrack.git
cd aitrack
pnpm install
pnpm run build
node packages/aitrack/dist/cli.js init
node packages/aitrack/dist/cli.js sync
node packages/aitrack/dist/cli.js show
```

Use `pnpm run dev -- init` (or `sync`, `show`) to run from TypeScript without building.

## Project layout

This is an [nx](https://nx.dev/) monorepo of pnpm workspace packages.

```
packages/
  aitrack-lib/        The library: everything that is not the command line
    src/
      config.ts       Local config (~/.config/aitrack)
      git.ts          Clone, pull, push data repo
      index.ts        The public barrel (`import … from 'aitrack-lib'`)
      data/           Types, validation, aggregation, usage loading
      display/        TUI, PNG heatmap, PDF/CSV receipts
        heatmap/      Shared heatmap stats, themes, view models
      readers/        Provider-specific ingestion (Claude, Codex, Cursor)
      pricing/        Model pricing tables and cost resolution
      providers/      Provider registry and descriptors
      store/          Machine files on disk and their schema migrations
  aitrack/            The CLI: `aitrack` on the command line
    src/
      cli.ts          Commander entrypoint
      cli/            Pure CLI parsing/validation helpers
      commands/       Command handlers (show, sync, usage, …)
  test-fixtures/      Fixtures shared by both test suites. Never published.
scripts/              Repo tooling: release, release notes, pricing drift
```

Tests are colocated per module in one `__tests__` folder each.

Usage is keyed by the **local** calendar day, so anything reading `getFullYear`/`getMonth`/
`getDate` can be right at UTC and a day out at the edges of the offset range. Cover that in
the suite, not by re-running it under a different `TZ`: `useTimeZone` from
`@aitrack/test-fixtures` moves the process into a real zone for the surrounding `describe`,
and `EXTREME_TIME_ZONES` is the +14/UTC/-11 set to run it over. `localTimestamp` builds a
fixture instant from local components so its day key holds in every zone.

The CLI imports the library by subpath — `import { log } from 'aitrack-lib/output'` — which
the package's `exports` map resolves to `dist/`. Within a package, imports are relative and
carry a `.js` extension (Node ESM).

### How nx is configured

The `@nx/js/typescript` plugins infer build and typecheck targets from the package
TypeScript configurations. `@nx/vitest` infers test targets. Other targets live in each
project's `project.json`, with shared defaults in `nx.json`.

Builds run `tsc --build` and build dependencies first. Typechecking follows TypeScript
project references. CLI tests and development use the source paths in its `tsconfig.json`;
compiled CLI imports resolve through the library's exports to `dist/`.

The three package projects are `aitrack`, `aitrack-lib`, and `@aitrack/test-fixtures`.
The `repo-tools` project in `scripts/` owns release tooling, pricing checks, script tests,
and checks for root configuration files. Package lint, format and unused-code checks
run per project. Lint uses `nx-oxlint:lint` with type-aware checking.

Tests run `vitest run`; the `ci` configuration adds coverage. Run
`pnpm exec nx run aitrack-lib:test:ci` for one package or `pnpm run test:ci` for all suites.
The CLI and library depend on the shared test-fixtures package, so fixture changes
invalidate their cached checks.

CI uses `nx affected` with `nrwl/nx-set-shas` supplying the comparison commits.
Lint and formatter configuration are inputs to their respective targets. Shared tool
versions live in the catalog in `pnpm-workspace.yaml`; published packages have catalog
and workspace references replaced with concrete versions by pnpm.

Run `pnpm run validate` before opening a PR.

## Commit messages

Commits **must** follow [Conventional Commits](https://www.conventionalcommits.org/) (e.g. `feat:`, `fix:`, `docs:`, `chore:`, `ci:`, `build:`). The changelog and version bumps are generated from commit messages, so non-conforming commits will be invisible in release notes.

## Scripts

| Script                  | Description                                            |
| ----------------------- | ------------------------------------------------------ |
| `pnpm run validate`     | Lint, format, typecheck, test, and unused-export check |
| `pnpm run check:unused` | Knip — unused files, exports, dependencies             |
| `pnpm run test`         | Run package and repository-tool tests                  |
| `pnpm run test:scripts` | Just the `repo-tools` tests                            |
| `pnpm run test:ci`      | The same tests with coverage and thresholds            |
| `pnpm run build`        | Compile each package to its own `dist/`                |
| `pnpm run lint`         | oxlint (type-aware)                                    |
| `pnpm run format`       | oxfmt write                                            |
| `pnpm run format:check` | oxfmt check                                            |
| `pnpm run graph`        | Open the nx project graph                              |

Checks can be scoped to one project: `pnpm exec nx run aitrack:test`,
`pnpm exec nx run-many -t test -p aitrack-lib`, or
`pnpm exec nx run repo-tools:check:unused`.
`pnpm run validate:affected` scopes validation to projects touched by your branch.

## Releasing

Releases are generated from Conventional Commits using [git-cliff](https://git-cliff.org/). Tagging and pushing happen locally; **npm publish and GitHub Release creation run in CI** when the tag lands on GitHub.

### One-time setup

Configure the `aitrack` and `aitrack-lib` packages on npm with [GitHub Actions as a trusted publisher](https://docs.npmjs.com/trusted-publishers/) for this repository and `.github/workflows/publish.yml`. The workflow exchanges GitHub's OIDC identity for short-lived npm credentials; do not add a long-lived `NPM_TOKEN` repository secret.

### Cut a release locally

```sh
pnpm run release
```

Patch bump by default. Pass a bump type if needed: `pnpm run release -- minor`.

This runs `validate` and `build`, sets the same version in the workspace root and both published packages, updates `CHANGELOG.md`, commits, creates the matching `v*` tag, and pushes the current branch plus that exact tag to the configured remote. npm publish and GitHub Release creation happen in CI — not locally.

Preview without changing anything:

```sh
pnpm run release:dry-run
```

The dry run calculates and prints the next version, changelog command, commit, and exact pushes without changing repository files.

### After the tag is pushed

The [Publish workflow](.github/workflows/publish.yml) triggers when the release script pushes its exact `v*` tag. It re-runs `validate`, builds, extracts that tag's section from `CHANGELOG.md`, creates or updates the matching GitHub Release, and runs `pnpm publish -r --no-git-checks`, which publishes `aitrack-lib` before `aitrack` and rewrites the `workspace:*` range to the version it just published. Prerelease tags produce GitHub prereleases. Public npm access comes from `publishConfig` in each package's `package.json`; authentication comes from npm trusted publishing through the workflow's `id-token: write` permission.
