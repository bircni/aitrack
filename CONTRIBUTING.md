# Contributing

## Development setup

Install Node.js (the version in `.node-version`), Bun (the version in `package.json`), git, and
rustup. Building needs Node 26 or newer; the published `aitrack` and `aitrack-lib` run on Node 24+,
and CI tests them there.
`bun nx run aitrack:build` builds only the CLI and the library. The pinned Rust version and components
live in `rust-toolchain.toml`.
The workspace builds both the CLI and the Tauri desktop app. On macOS, install Xcode
Command Line Tools. On Windows, install the Visual Studio C++ build tools and WebView2.
On Ubuntu, install the desktop app's system libraries before building:

```sh
sudo apt-get update
sudo apt-get install -y libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev libssl-dev patchelf
```

```sh
git clone https://github.com/bircni/aitrack.git
cd aitrack
bun install
bun run build
node apps/aitrack/dist/cli.js init
node apps/aitrack/dist/cli.js sync
node apps/aitrack/dist/cli.js show
```

Use `bun run dev init` (or `sync`, `show`) to build the CLI's dependencies, then run it from TypeScript.

## Desktop development

opentrack has two Nx projects: `opentrack-ui` (Svelte renderer) and `opentrack` (the Tauri 2
app, which reads limits and usage through `aitrack-core`). The UI uses the system webview
(WebView2, WKWebView, WebKitGTK on Linux).
See [docs/opentrack.md](docs/opentrack.md).

```sh
bun nx run opentrack:dev
bun nx run opentrack:package        # builds the renderer first; run on the target platform
bun nx run opentrack:bundle:check
```

Installers (NSIS, DMG, AppImage and `.deb`) land under `target/release/bundle/`; package on
the platform you target. macOS builds are ad hoc signed, not notarized, and need
macOS 13.5+. The app version is the workspace `package.json` version; there is no separate
desktop tag.

## Project layout

This is an [nx](https://nx.dev/) monorepo of Bun workspace packages.

```
apps/
  aitrack/            The CLI: `aitrack` on the command line
    src/
      cli.ts          Commander entrypoint
      cli/            Commander program, option parsing and JSON output
      commands/       Command handlers (show, sync, usage, …)
  opentrack/          Tauri Rust shell, native configuration and icons
    src/             Window, tray, commands, and the limits, usage, polling and tray state
  opentrack-ui/       Desktop frontend
    src/
      renderer/      Svelte dashboard and settings
      shared/        Types and pacing the renderer shares with its tests
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
      quota/          Live limits per provider
      store/          Machine files on disk and their schema migrations
  test-fixtures/      Fixtures and the isolated test environment shared by the test suites.
                      Never published.
scripts/              Repo tooling: release and release notes, npm publish, pricing pack
                      build/check, bundle smoke check, updater manifest,
                      Homebrew cask and winget manifests, reader benchmark
```

### Pricing updates

Editable sources of truth for first-party rates (also the offline CLI baseline):

- `libs/aitrack-lib/src/pricing/tables/claude.json`
- `libs/aitrack-lib/src/pricing/tables/codex.json`
- `libs/aitrack-lib/src/pricing/tables/cursor.json`

No pricing pack is shipped in the npm package. CI builds `artifacts/pricing-pack/` and publishes it to the orphan `pricing` branch daily, adding a commit when rates changed; installs refresh into `~/.config/aitrack/pricing/`.

```bash
bun run pricing:update            # fetch catalogs → artifacts/pricing-pack/
bun run pricing:update --write    # also patch Claude/Codex IO into tables/*.json
bun run pricing:check             # optional local compare of tables vs catalogs
```

Shared pricing calculations, catalog access, table conversion, and stored-day repricing belong in `aitrack-lib`. Apps and scripts handle command arguments, presentation, and file publishing.

Tests are colocated per module in one `__tests__` folder each. Usage is keyed by the
**local** calendar day, so cover day edges with `useTimeZone` and `EXTREME_TIME_ZONES` from
`@aitrack/test-fixtures`, not by changing `TZ`. The library, CLI and UI vitest configs apply
`isolatedTestEnv()` from `@aitrack/test-fixtures/test-env`, so their tests read neither your real home
nor a source-root variable from your shell.

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
versions live in the `workspaces.catalog` of the root `package.json`; its `overrides` pin
patched transitive versions that `bun audit` would otherwise flag.

Tests run `vitest run`; the `ci` configuration adds coverage (`bun nx run
aitrack-lib:test:ci`, or `bun run test:ci` for all). Aggregate thresholds are 90%
lines/statements/functions and 80% branches, plus 80% per measured file and metric; `repo-tools`
has 80% throughout. Fixture
changes invalidate dependents' cached checks.

`bun x tsx scripts/benchmark-readers.ts` runs a synthetic reader benchmark; see
[recorded results](docs/reader-benchmarks.md).

If `nx` hangs without starting tasks (usually Nx Cloud unreachable), rerun with
`NX_NO_CLOUD=true NX_DAEMON=false`.

`bun run mutation` runs [StrykerJS](https://stryker-mutator.io/) over `libs/aitrack-lib/src/data`
and `src/pricing` (not the rate tables) and writes an HTML report to
`libs/aitrack-lib/reports/mutation/`. It is slow and deliberately outside `validate` and CI.
Stryker runs vitest in worker threads, where `useTimeZone` cannot move the zone, so the target
pins `TZ=UTC` and `libs/aitrack-lib/vitest.mutation.config.ts` skips tests with `Pacific/` in their
name; a test that depends on the zone must name one there. `os.homedir()` also ignores the test env in
worker threads, so that config pins the process env, which keeps these runs away from your real
`~/.config/aitrack`. Narrow a
run with `bun nx run aitrack-lib:mutation -- --mutate 'src/data/usageReport.ts'`.

CI uses `nx affected` with `nrwl/nx-set-shas`. It runs on `main` and pull requests, not on tags, which Publish validates itself. The Audit job lints the workflows with actionlint, runs GitHub's dependency review on
pull requests and `bun audit` against the lockfile, failing on high-severity advisories. Dependency
review sees only direct npm dependencies, since GitHub does not parse `bun.lock`, so `bun audit` is
what covers transitive ones. Dependabot proposes Bun, Cargo and Actions updates.
Ubuntu runs the affected checks for every project except the Rust shell in one parallel Nx
run, plus CLI smoke and publish-tarball checks. `Check (Node 24)` runs the published packages' affected
tests and the CLI smoke tests on Node 24. A `macos-latest` / `windows-latest` /
`ubuntu-24.04` matrix runs opentrack's Rust checks and packaging, skipped on pull requests
that do not affect `opentrack`; pushes to `main` save the Cargo cache those runs restore, and CI
packages build without LTO, which only the Publish workflow keeps (the Linux row installs the WebKitGTK, AppIndicator and
`libxdo` development packages first) and uploads the NSIS installer, Apple Silicon DMG,
AppImage and `.deb` as workflow artifacts. `bundle:check` starts the bundled app in its smoke-test mode from the
DMG, the installer (Windows needs `7z` on `PATH`), the `.deb` (`dpkg-deb`) or the AppImage
(`--appimage-extract`) with temporary app data and no provider or remote requests.

Run `bun run validate` before opening a PR.

## Commit messages

Commits **must** follow [Conventional Commits](https://www.conventionalcommits.org/) (e.g. `feat:`, `fix:`, `docs:`, `chore:`, `ci:`, `build:`). The changelog and version bumps are generated from commit messages, so non-conforming commits will be invisible in release notes.

## Scripts

Common ones (see `package.json` for the rest): `bun run validate` (format, lint, typecheck,
unused-export check, test, build), `validate:affected` (same, scoped to the tasks a change
against the base branch reaches), `test`, `test:ci`, `test:smoke`, `check:unused` (knip), `build`,
`lint`, `format`, `changelog`.

Scope checks to one project with e.g. `bun nx run aitrack:test` or
`bun nx run repo-tools:check:unused`.

## Releasing

Releases are generated from Conventional Commits using [git-cliff](https://git-cliff.org/). Tagging and pushing happen locally; **npm publish and GitHub Release creation run in CI** when the tag lands on GitHub.

### One-time setup

Configure the `aitrack` and `aitrack-lib` packages on npm with [GitHub Actions as a trusted publisher](https://docs.npmjs.com/trusted-publishers/) for this repository and `.github/workflows/publish.yml`. The workflow exchanges GitHub's OIDC identity for short-lived npm credentials; do not add a long-lived `NPM_TOKEN` repository secret.

opentrack's in-app updater only installs files signed with its release key. Add the
private key from `bun x tauri signer generate` and its password as the
`TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` secrets; the public
key is `plugins.updater.pubkey` in `apps/opentrack/tauri.conf.json` and
`OPENTRACK_PUBLIC_KEY` in `apps/aitrack/src/minisign.ts`. Losing the private key means
installed apps can no longer update. The cask update pushes to
`bircni/homebrew-tap` with the private half of a write deploy key on that repository,
stored as the `HOMEBREW_TAP_DEPLOY_KEY` secret.

### Cut a release locally

```sh
bun run release
```

Patch bump by default. Pass a bump type if needed: `bun run release minor`.

It first checks that you are on `main` with a clean tree, in sync with the remote, and that the tag is free locally and remotely, and stops otherwise. It then runs `validate`, which includes the build, sets the same version in the workspace root and both published packages, updates `CHANGELOG.md`, commits, creates the matching `v*` tag, and pushes `main` and that exact tag atomically to the configured remote, so a commit never lands without its tag. Opentrack's app and installer version comes from that workspace version. npm publish, desktop packaging and GitHub Release creation happen in CI.

Preview without changing anything:

```sh
bun run release:dry-run
```

The dry run calculates and prints the next version, changelog command, commit, and exact pushes without changing repository files. It reads the remote with `git ls-remote` and prints whatever would stop a real release as a warning.

### After the tag is pushed

The [Publish workflow](.github/workflows/publish.yml) triggers on that same `v*` tag:

- **Tarballs.** The first job re-runs `validate`, which also builds, for every project
  except the Rust shell, which the desktop jobs check. It then packs both packages with
  `bun pm pack`, which rewrites `workspace:*` and `catalog:` to exact versions, and
  `scripts/sbom.ts` writes a CycloneDX SBOM of each packed package's production dependencies.
- **Desktop.** Alongside it, desktop jobs check that the tag matches the workspace version,
  check the Rust shell's formatting, Clippy and tests, and package a Windows NSIS installer,
  a macOS DMG for Apple Silicon and a Linux AppImage and `.deb` for x86_64 (built on
  `ubuntu-24.04`), plus the updater's signed `.app.tar.gz` and installer signatures, then
  upload them as workflow artifacts. Missing installers fail the build.
- **Draft release.** After those succeed, this job extracts the tag's section from
  `CHANGELOG.md` and creates a draft GitHub release with the installers, SBOMs and
  `latest.json`. It runs before npm, which cannot be undone, so its failures surface first.
- **npm.** `scripts/publish-npm.ts` publishes the built tarballs, `aitrack-lib` before `aitrack`,
  with `npm publish --provenance`. It skips a version already on the registry. This job alone holds
  the npm credential, so it installs nothing and runs only that script.
- **Publish the release.** The draft goes public only now, so opentrack and `aitrack install-opentrack`,
  which read `latest.json` from the latest non-prerelease release, never find it half uploaded.
- **Homebrew.** The last job writes `Casks/opentrack.rb` with the new version and DMG checksum to
  `bircni/homebrew-tap` and pushes it.

A tag with a `-` is a prerelease: npm publishes it under the `next` dist-tag, the GitHub release
is marked a prerelease and never becomes latest, and the Homebrew job is skipped.

After a failure, re-run the failed jobs of the same workflow run. They reuse its artifacts; the draft
job finds the existing release and replaces assets with the same names, and the npm script skips what
already published.

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
