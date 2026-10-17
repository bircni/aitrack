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

opentrack has two Nx projects: `opentrack-ui` (Svelte renderer and Node sidecar, which reads
usage through `aitrack-lib`) and `opentrack` (Tauri 2 Rust shell). They exchange JSON lines
on stdin/stdout. The UI uses the system webview (WebView2, WKWebView, WebKitGTK on Linux).
See [docs/opentrack.md](docs/opentrack.md).

```sh
pnpm nx run opentrack:dev
pnpm nx run opentrack:package        # builds renderer and sidecar first; run on the target platform
pnpm nx run opentrack:bundle:check
```

Installers (NSIS, DMG, AppImage and `.deb`) land under `target/release/bundle/`; package on
the platform you target. `pnpm install` downloads the Node runtime pinned in
`apps/opentrack-ui/package.json`; the `sea` target needs it because some system Node builds
(including Homebrew's) disable SEA. macOS builds are ad hoc signed, not notarized, and need
macOS 13.5+. The app version is the workspace `package.json` version; there is no separate
desktop tag.

## Project layout

This is an [nx](https://nx.dev/) monorepo of pnpm workspace packages.

```
apps/
  aitrack/            The CLI: `aitrack` on the command line
    src/
      cli.ts          Commander entrypoint
      cli/            Commander program, option parsing and JSON output
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
scripts/              Repo tooling: release and release notes, pricing pack build/check,
                      sidecar SEA build, bundle smoke check, updater manifest, Homebrew
                      cask and winget manifests, reader benchmark
```

### Pricing updates

Editable sources of truth for first-party rates (also the offline CLI baseline):

- `libs/aitrack-lib/src/pricing/tables/claude.json`
- `libs/aitrack-lib/src/pricing/tables/codex.json`
- `libs/aitrack-lib/src/pricing/tables/cursor.json`

No pricing pack is shipped in the npm package. CI builds `artifacts/pricing-pack/` and publishes it to the orphan `pricing` branch daily, adding a commit when rates changed; installs refresh into `~/.config/aitrack/pricing/`.

```bash
pnpm run pricing:update            # fetch catalogs → artifacts/pricing-pack/
pnpm run pricing:update -- --write # also patch Claude/Codex IO into tables/*.json
pnpm run pricing:check             # optional local compare of tables vs catalogs
```

Shared pricing calculations, catalog access, table conversion, and stored-day repricing belong in `aitrack-lib`. Apps and scripts handle command arguments, presentation, and file publishing.

Tests are colocated per module in one `__tests__` folder each. Usage is keyed by the
**local** calendar day, so cover day edges with `useTimeZone` and `EXTREME_TIME_ZONES` from
`@aitrack/test-fixtures`, not by changing `TZ`.

The CLI imports the library by subpath (`import { log } from 'aitrack-lib/output'`), which
the `exports` map resolves to `dist/`. Within a package, imports are relative with a `.js`
extension.

### How nx is configured

The `@nx/js/typescript` plugins infer build and typecheck targets from the TypeScript
configurations and `@nx/vitest` infers test targets; other targets live in each
`project.json`, with defaults in `nx.json`. Builds run `tsc --build` with dependencies
first. CLI tests and development use the source paths in its `tsconfig.json`; compiled CLI
imports resolve through the library's exports to `dist/`.

Projects: `aitrack`, `aitrack-lib`, `opentrack-ui`, `@aitrack/test-fixtures`, `opentrack`
(Rust) and `repo-tools` (`scripts/`: release tooling, pricing checks, script tests, root
config checks). Lint is `nx-oxlint:lint` (type-aware for TypeScript); Svelte blocks get the
supported Oxlint rules and `svelte-check --fail-on-warnings` stays required. Clippy runs
with `-D warnings`. Root `.oxlintrc.json` and `.oxfmtrc.json` are Nx inputs. Shared tool
versions live in the `pnpm-workspace.yaml` catalog.

Tests run `vitest run`; the `ci` configuration adds coverage (`pnpm exec nx run
aitrack-lib:test:ci`, or `pnpm run test:ci` for all). Aggregate thresholds are 90%
lines/statements/functions and 80% branches, plus 80% per measured file and metric. Fixture
changes invalidate dependents' cached checks.

`pnpm exec tsx scripts/benchmark-readers.ts` runs a synthetic reader benchmark; see
[recorded results](docs/reader-benchmarks.md).

If `nx` hangs without starting tasks (usually Nx Cloud unreachable), rerun with
`NX_NO_CLOUD=true NX_DAEMON=false`.

`pnpm run mutation` runs [StrykerJS](https://stryker-mutator.io/) over `libs/aitrack-lib/src/data`
and `src/pricing` (not the rate tables) and writes an HTML report to
`libs/aitrack-lib/reports/mutation/`. It is slow and deliberately outside `validate` and CI.
Stryker runs vitest in worker threads, where `useTimeZone` cannot move the zone, so the target
pins `TZ=UTC` and `libs/aitrack-lib/vitest.mutation.config.ts` skips the non-UTC cases. Narrow a
run with `pnpm exec nx run aitrack-lib:mutation -- --mutate 'src/data/usageReport.ts'`.

CI uses `nx affected` with `nrwl/nx-set-shas`. The Audit job lints the workflows with actionlint, runs GitHub's dependency review on
pull requests and `pnpm audit` against the lockfile, failing on high-severity advisories.
Ubuntu runs the affected checks for every project except the Rust shell, plus CLI smoke and
publish-tarball checks. A `macos-latest` / `windows-latest` / `ubuntu-latest` matrix runs
opentrack's Rust checks and packaging (the Linux row installs the WebKitGTK, AppIndicator and
`libxdo` development packages first) and uploads the NSIS installer, Apple Silicon DMG,
AppImage and `.deb` as workflow artifacts. `bundle:check` starts the bundled sidecar from the
DMG, the installer (Windows needs `7z` on `PATH`), the `.deb` (`dpkg-deb`) or the AppImage
(`--appimage-extract`) with temporary app data and no provider or remote requests.

Run `pnpm run validate` before opening a PR.

## Commit messages

Commits **must** follow [Conventional Commits](https://www.conventionalcommits.org/) (e.g. `feat:`, `fix:`, `docs:`, `chore:`, `ci:`, `build:`). The changelog and version bumps are generated from commit messages, so non-conforming commits will be invisible in release notes.

## Scripts

Common ones (see `package.json` for the rest): `pnpm run validate` (format, lint, typecheck,
unused-export check, test, build), `validate:affected` (same, scoped to projects changed
against the base branch), `test`, `test:ci`, `test:smoke`, `check:unused` (knip), `build`,
`lint`, `format`, `changelog`.

Scope checks to one project with e.g. `pnpm exec nx run aitrack:test` or
`pnpm exec nx run repo-tools:check:unused`.

## Releasing

Releases are generated from Conventional Commits using [git-cliff](https://git-cliff.org/). Tagging and pushing happen locally; **npm publish and GitHub Release creation run in CI** when the tag lands on GitHub.

### One-time setup

Configure the `aitrack` and `aitrack-lib` packages on npm with [GitHub Actions as a trusted publisher](https://docs.npmjs.com/trusted-publishers/) for this repository and `.github/workflows/publish.yml`. The workflow exchanges GitHub's OIDC identity for short-lived npm credentials; do not add a long-lived `NPM_TOKEN` repository secret.

opentrack's in-app updater only installs files signed with its release key. Add the
private key from `pnpm exec tauri signer generate` and its password as the
`TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` secrets; the public
key is `plugins.updater.pubkey` in `apps/opentrack/tauri.conf.json` and
`OPENTRACK_PUBLIC_KEY` in `apps/aitrack/src/minisign.ts`. Losing the private key means
installed apps can no longer update. The cask update pushes to
`bircni/homebrew-tap` with the private half of a write deploy key on that repository,
stored as the `HOMEBREW_TAP_DEPLOY_KEY` secret.

### Cut a release locally

```sh
pnpm run release
```

Patch bump by default. Pass a bump type if needed: `pnpm run release -- minor`.

This runs `validate`, which includes the build, sets the same version in the workspace root and both published packages, updates `CHANGELOG.md`, commits, creates the matching `v*` tag, and pushes the current branch plus that exact tag to the configured remote. Opentrack's app and installer version comes from that workspace version. npm publish, desktop packaging and GitHub Release creation happen in CI.

Preview without changing anything:

```sh
pnpm run release:dry-run
```

The dry run calculates and prints the next version, changelog command, commit, and exact pushes without changing repository files.

### After the tag is pushed

The [Publish workflow](.github/workflows/publish.yml) triggers on that same `v*` tag:

- After both desktop packages succeed, the npm job re-runs `validate`, which also
  builds, for every project except the Rust shell, which the desktop jobs check. It
  then publishes `aitrack-lib` before `aitrack` with provenance. pnpm rewrites
  `workspace:*` to the published library version. It also writes a CycloneDX SBOM of
  each package's production dependencies from the lockfile, which the release job
  attaches to the GitHub release.
- Desktop jobs check the Rust shell's formatting, Clippy and tests, and package a
  Windows NSIS installer, a macOS DMG for Apple Silicon and a Linux AppImage and `.deb`
  for x86_64, plus the updater's signed `.app.tar.gz` and installer signatures, then
  upload them as workflow artifacts. Missing installers fail the build.
- After npm publishing and all desktop jobs succeed, the release job extracts that
  tag's section from `CHANGELOG.md`, creates or updates the GitHub release, downloads
  the installer artifacts and uploads them to that release. Reruns replace existing
  assets with the same names. Prerelease tags produce GitHub prereleases.
  It also uploads `latest.json`, which opentrack and `aitrack install-opentrack` read
  from the latest non-prerelease release.
- For non-prerelease tags, the Homebrew job writes `Casks/opentrack.rb` with the new
  version and DMG checksum to `bircni/homebrew-tap` and pushes it.

CI and Publish jobs that run Nx install the toolchain from `rust-toolchain.toml` through
`.github/actions/setup-rust`, which passes the version and components read from that file
to a pinned `dtolnay/rust-toolchain`; the Nx Rust plugin reads Cargo metadata.

Windows builds are unsigned; macOS builds are ad hoc signed and not notarized.
Public npm access comes from `publishConfig` in each package's `package.json`;
authentication comes from npm trusted publishing through `id-token: write`.

### winget

opentrack's winget package (`bircni.opentrack`) is not in `microsoft/winget-pkgs` yet, and
release automation can only update an existing package, so the first version is submitted
by hand. `scripts/winget-manifest.ts` writes that version's manifests into a `winget-pkgs`
checkout:

```sh
gh release download vX.Y.Z -p '*-setup.exe'
node scripts/winget-manifest.ts vX.Y.Z opentrack_X.Y.Z_x64-setup.exe ../winget-pkgs
```

On Windows, `winget validate --manifest manifests/b/bircni/opentrack/X.Y.Z` checks them, and
`winget install --manifest manifests/b/bircni/opentrack/X.Y.Z` (after
`winget settings --enable LocalManifestFiles`) installs from them. Commit them in a fork as
`New package: bircni.opentrack version X.Y.Z` and open a pull request to
`microsoft/winget-pkgs`. The manifest's publisher and product code must match what the
installer registers: `bundle.publisher` and `productName` in `apps/opentrack/tauri.conf.json`.
