# Contributing

## Development setup

Install Node.js 24+, pnpm (the version in `package.json`), git, and rustup. The pinned
Rust version and components live in `rust-toolchain.toml`.
The workspace builds both the CLI and the Tauri desktop app. On macOS, install Xcode
Command Line Tools. On Windows, install the Visual Studio C++ build tools and WebView2.
On Ubuntu, install the desktop app's system libraries before building:

```sh
sudo apt-get update
sudo apt-get install -y libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev libssl-dev
```

```sh
git clone https://github.com/bircni/aitrack.git
cd aitrack
pnpm install
pnpm run build
node apps/aitrack/dist/cli.js init
node apps/aitrack/dist/cli.js sync
node apps/aitrack/dist/cli.js show
```

Use `pnpm run dev -- init` (or `sync`, `show`) to run from TypeScript without building.

## Desktop development

opentrack has two Nx projects. `opentrack-ui` contains the Svelte renderer and the Node
sidecar, which reads usage through `aitrack-lib` and fetches provider limits. `opentrack`
is the Tauri 2 Rust shell: tray icon, window, notifications, autostart and shortcuts.
The shell and sidecar exchange JSON lines on stdin/stdout. The UI uses the system
webview (WebView2 on Windows, WKWebView on macOS).

```sh
pnpm nx run opentrack:dev
pnpm nx run opentrack-ui:test
pnpm nx run opentrack:test
pnpm nx run opentrack:package
pnpm nx run opentrack:bundle:check
```

The package target builds the renderer and sidecar before invoking Tauri. Windows
installers land in `target/release/bundle/nsis/`; macOS app bundles and disk images land
in `target/release/bundle/macos/` and `target/release/bundle/dmg/`. Run packaging on the
platform you are targeting. macOS release builds run on `macos-latest` for Apple Silicon,
so the Rust app and sidecar share the same native architecture. The bundled Node runtime requires macOS 13.5+.

`pnpm install` downloads the official Node runtime pinned in `apps/opentrack-ui/package.json`.
The `sea` target runs that binary through `pnpm exec` to create a self-contained sidecar;
some system Node builds, including Homebrew's, disable SEA support. The resource keeps
the name `opentrack-sidecar.exe` on every platform, but contains a native executable for
the build machine. On macOS the SEA build reapplies an ad hoc signature after modifying
the Node executable, and Tauri ad hoc signs the app bundle. These builds are not notarized.

The app version is read from the workspace `package.json` through Tauri's `version`
setting; there is no separate desktop release tag or version bump.

## Project layout

This is an [nx](https://nx.dev/) monorepo of pnpm workspace packages.

```
apps/
  aitrack/            The CLI: `aitrack` on the command line
    src/
      cli.ts          Commander entrypoint
      cli/            Pure CLI parsing/validation helpers
      commands/       Command handlers (show, sync, usage, …)
  opentrack/          Tauri Rust shell, native configuration and icons
    src/             Window, tray, commands and sidecar supervision
  opentrack-ui/       Desktop frontend and bundled Node runtime
    src/
      renderer/      Svelte dashboard and settings
      sidecar/       Provider limits, usage, polling and tray state
libs/
  aitrack-lib/        The library: everything that is not the command line
    src/
      config.ts       Local config (~/.config/aitrack)
      git.ts          Clone, pull, push data repo
      index.ts        The public barrel (`import … from 'aitrack-lib'`)
      data/           Types, validation, aggregation, usage loading
      display/        TUI, PNG heatmap, PDF/CSV receipts
        heatmap/      Shared heatmap stats, themes, view models
      readers/        Provider-specific ingestion (Claude, Codex, Cursor)
      pricing/        Cost resolution; editable rates in pricing/tables/*.json
                      (live pack published on orphan branch `pricing`, not bundled)
      providers/      Provider registry and descriptors
      store/          Machine files on disk and their schema migrations
  test-fixtures/      Fixtures shared by both test suites. Never published.
scripts/              Repo tooling: release, release notes, pricing pack build/check
```

### Pricing updates

Editable sources of truth for first-party rates (also the offline CLI baseline):

- `libs/aitrack-lib/src/pricing/tables/claude.json`
- `libs/aitrack-lib/src/pricing/tables/codex.json`
- `libs/aitrack-lib/src/pricing/tables/cursor.json`

No pricing pack is shipped in the npm package. CI builds `artifacts/pricing-pack/` and publishes it to the orphan `pricing` branch daily; installs refresh into `~/.config/aitrack/pricing/`.

```bash
pnpm run pricing:update            # fetch catalogs → artifacts/pricing-pack/
pnpm run pricing:update -- --write # also patch Claude/Codex IO into tables/*.json
pnpm run pricing:check             # optional local compare of tables vs catalogs
```

Shared pricing calculations, catalog access, table conversion, and stored-day repricing belong in `aitrack-lib`. Apps and scripts handle command arguments, presentation, and file publishing.

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

The package projects are `aitrack`, `aitrack-lib`, `opentrack-ui`, and `@aitrack/test-fixtures`;
`opentrack` is the Rust application. Vite infers renderer builds and `@monodon/rust`
supplies the Rust build, lint and test executors.
The `repo-tools` project in `scripts/` owns release tooling, pricing checks, script tests,
and checks for root configuration files. Package lint, format and unused-code checks
run per project. Lint uses `nx-oxlint:lint` with type-aware checking.

Tests run `vitest run`; the `ci` configuration adds coverage. Run
`pnpm exec nx run aitrack-lib:test:ci` for one package or `pnpm run test:ci` for all suites.
The desktop suite uses the Svelte Vite plugin and jsdom, measures components and the
API bridge, and exercises command failures, settings queues, provider controls and
partial/stale presentation. Only the renderer entrypoint, sidecar process entrypoint
and shared type declarations are excluded; builds, CLI smoke and native app checks
validate the process/bootstrap glue.
The CLI, library and desktop depend on the shared test-fixtures package, so fixture
changes invalidate their cached checks. Calendar tests use `useTimeZone` and
`EXTREME_TIME_ZONES` rather than changing `TZ`.

Run `pnpm exec tsx scripts/benchmark-readers.ts` for an isolated synthetic reader
benchmark. It verifies cold/warm totals and ordering, reports median timings over
five runs, filesystem/request counts, derived-cache size and process memory, and
includes a 10,000-file listing. See [recorded results](docs/reader-benchmarks.md).

If `nx` hangs without starting tasks (typically when Nx Cloud is unreachable),
rerun with `NX_NO_CLOUD=true NX_DAEMON=false`.

CI uses `nx affected` with `nrwl/nx-set-shas` supplying the comparison commits.
The Ubuntu job runs the full set of affected checks, including Rust, CLI smoke tests
and publish-tarball checks. A single `macos-latest` / `windows-latest` matrix runs
CLI smoke and publish-tarball checks alongside opentrack's Rust formatting, lint, tests
and release packaging with the pinned toolchain.
The native matrix starts only after the Ubuntu `Check` job succeeds, so failed
Ubuntu checks do not consume macOS or Windows runner time.
Nx builds the renderer and native sidecar dependencies needed by the Rust shell;
Full JavaScript checks and unit tests stay in the Ubuntu job.
The matrix uploads the Windows NSIS installer and Apple Silicon macOS DMG as
workflow artifacts so PR builds can be downloaded and tried. Missing installers
fail the job. Packaging also checks the release build and bundle configuration.
`bundle:check` mounts the macOS DMG or extracts the Windows NSIS installer with
7-Zip, then starts its bundled sidecar and checks the settings/state protocol.
It uses temporary app data and a smoke mode that makes no provider or git requests.
The Windows check needs `7z` on `PATH`; GitHub's Windows runners include it.
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

This runs `validate` and `build`, sets the same version in the workspace root and both published packages, updates `CHANGELOG.md`, commits, creates the matching `v*` tag, and pushes the current branch plus that exact tag to the configured remote. Opentrack's app and installer version comes from that workspace version. npm publish, desktop packaging and GitHub Release creation happen in CI.

Preview without changing anything:

```sh
pnpm run release:dry-run
```

The dry run calculates and prints the next version, changelog command, commit, and exact pushes without changing repository files.

### After the tag is pushed

The [Publish workflow](.github/workflows/publish.yml) triggers on that same `v*` tag:

- After both desktop packages succeed, the npm job re-runs `validate`, builds,
  and publishes `aitrack-lib` before `aitrack`
  with provenance. pnpm rewrites `workspace:*` to the published library version.
- Desktop jobs package a Windows NSIS installer and a macOS DMG for Apple Silicon,
  then upload them as workflow artifacts. Missing installers fail the build.
- After npm publishing and all desktop jobs succeed, the release job extracts that
  tag's section from `CHANGELOG.md`, creates or updates the GitHub release, downloads
  the installer artifacts and uploads them to that release. Reruns replace existing
  assets with the same names. Prerelease tags produce GitHub prereleases.

Every job that invokes Nx or Rust installs the toolchain from `rust-toolchain.toml`
with `dtolnay/rust-toolchain@stable`, passing the version and components read from
that file. This includes the pricing job (Nx reads Cargo metadata).

Windows builds are unsigned; macOS builds are ad hoc signed and not notarized.
Public npm access comes from `publishConfig` in each package's `package.json`;
authentication comes from npm trusted publishing through `id-token: write`.
