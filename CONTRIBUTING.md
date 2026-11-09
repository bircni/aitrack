# Contributing

## Development setup

Install rustup (the toolchain and components are pinned in `rust-toolchain.toml`), `cargo-nextest`,
`cargo-deny` and git. Releasing also needs [git-cliff](https://git-cliff.org/). Nothing
needs Node except the npm launcher in `npm/aitrack`, which has no dependencies.

On macOS, install Xcode Command Line Tools. On Windows, install the Visual Studio C++ build tools. On
Ubuntu, install the desktop app's system libraries:

```sh
sudo apt-get update
sudo apt-get install -y libgtk-3-dev libayatana-appindicator3-dev libxdo-dev
```

```sh
git clone https://github.com/bircni/aitrack.git
cd aitrack
git config core.hooksPath .githooks    # checks commit messages
cargo run -p aitrack-cli -- init
cargo run -p aitrack-cli -- sync
cargo run -p aitrack-cli -- show
```

## Project layout

A Cargo workspace.

```
crates/
  core/               aitrack-core: everything that is not the command line or the window
    src/
      readers/        Provider logs (Claude, Codex) and the Cursor export into day maps
      pricing/        Cost resolution, the pricing pack store, repricing
      data/           Machine files, reports, periods, rankings, projects
      store/          Machine files on disk, validation, encryption, migrations
      git/, sync.rs   The data repo: clone, pull, rebase, push
      quota/          Live limits per provider
      display/        Terminal table, TUI, CSV, PDF, and the PNG heatmap (feature `render`)
      js/             Number formatting, collation and parsing as 4.x did, for byte-compatible files
    pricing-tables/   claude.json, codex.json, cursor.json: editable first-party rates
    tests/fixtures/   Golden outputs recorded from 4.x (see its README)
  cli/                The `aitrack` binary (clap)
  xtask/              `cargo xtask`: pricing pack, release, packaging and publishing
apps/
  opentrack/          Native popup (egui): tray, polling, alerts, settings, updater, on aitrack-core
npm/aitrack/          The npm launcher; one platform package per target is generated at release
.githooks/            commit-msg: the Conventional Commits check
```

Usage is keyed by the **local** calendar day, so tests pin the zone through the `Clock` they pass
in (`Clock::fixed`, or `Clock::with_zone` with a zone from `jiff::tz::TimeZoneDatabase::bundled()`),
never by changing `TZ`; cover day edges in Pacific/Kiritimati, UTC and Pacific/Midway. Golden
tests use the bundled tz database because hosts disagree on pre-1901 offsets.

## Checks

```sh
cargo xtask validate        # everything CI runs: fmt, clippy, nextest and cargo deny
cargo lint                  # clippy alone, as CI runs it (an alias in .cargo/config.toml)
cargo nextest run -p <crate>
```

Clippy runs pedantic with `-D warnings`.

CI (`.github/workflows/ci.yml`) runs on pushes to `main` and on pull requests: format and Clippy on
Ubuntu, tests on Ubuntu, and cargo deny. macOS and Windows (Clippy and tests) run on demand from the
Platforms workflow (`.github/workflows/platforms.yml`), e.g. before a release or after
platform-specific changes. Pull requests also get GitHub's
dependency review. Dependabot proposes Cargo and Actions updates.

## Desktop development

```sh
cargo dev                        # the app in debug, with its own data dir under target/
cargo xtask package app,dmg      # installers under target/release/bundle/ (appimage,deb or nsis elsewhere)
cargo xtask smoke-bundle         # start the bundled app in smoke-test mode
```

Package on the platform you target. The smoke check starts the bundled app with temporary app data
and no provider or remote requests, from the DMG, the installer (Windows needs `7z` on `PATH`), the
`.deb` (`dpkg-deb`) or the AppImage. See [docs/opentrack.md](docs/opentrack.md).

## Pricing updates

The editable sources of first-party rates, also the offline baseline every build bundles, are
`crates/core/pricing-tables/{claude,codex,cursor}.json`. No pricing pack ships with a release: CI
builds `artifacts/pricing-pack/` and publishes it daily to the orphan `pricing` branch, adding a
commit when rates changed; installs refresh into `~/.config/aitrack/pricing/`.

```sh
cargo xtask pricing-pack            # fetch catalogs → artifacts/pricing-pack/
cargo xtask pricing-pack --write    # also patch Claude/Codex IO into the tables
cargo xtask pricing-check           # compare the tables with the catalogs
```

## Commit messages

Commits **must** follow [Conventional Commits](https://www.conventionalcommits.org/) (e.g. `feat:`,
`fix:`, `docs:`, `chore:`, `ci:`, `build:`). The changelog and version bumps are generated from
commit messages, so non-conforming commits will be invisible in release notes. The
`.githooks/commit-msg` hook checks them once `core.hooksPath` points at `.githooks`.

## Releasing

Releases are generated from Conventional Commits using [git-cliff](https://git-cliff.org/). Tagging
and pushing happen locally; **npm publish and the GitHub release run in CI** when the tag lands.

### One-time setup

Configure `aitrack` and `@aitrack/cli-darwin-arm64`, `@aitrack/cli-linux-x64`,
`@aitrack/cli-linux-arm64` and `@aitrack/cli-win32-x64` on npm with
[GitHub Actions as a trusted publisher](https://docs.npmjs.com/trusted-publishers/) for this
repository and `.github/workflows/publish.yml`. Do not add a long-lived `NPM_TOKEN` secret.

opentrack's in-app updater only installs files signed with its release key. Add the private key
(a minisign secret key file, base64-encoded, as `tauri signer generate` wrote it for 4.x) and its
password as the `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` secrets;
`cargo xtask updater-artifacts` signs with them. The public key is `PUBLIC_KEY` in
`crates/core/src/update.rs`, which both the app's updater and `aitrack install-opentrack` use. Losing the private key
means installed apps can no longer update. The cask update pushes to `bircni/homebrew-tap` with the
private half of a write deploy key on that repository, stored as the `HOMEBREW_TAP_DEPLOY_KEY`
secret.

### Cut a release locally

```sh
cargo xtask release                 # patch bump
cargo xtask release minor
cargo xtask release 5.1.0-beta.1    # an exact version
cargo xtask release patch --dry-run
```

It checks that you are on `main` with a clean tree in sync with the remote and that the tag is free,
and stops otherwise. It then starts the CI and Platforms workflows on that commit with `gh` and
watches them; if either fails it stops before anything is changed. Only then does it set
`[workspace.package] version` in `Cargo.toml`
(the CLI, opentrack and the npm packages all carry it), runs `cargo update --workspace`, updates
`CHANGELOG.md`, commits, tags `v<version>`, and pushes `main` and that tag atomically. The dry run
prints all of this, and whatever would stop a real release, without changing anything.

### After the tag is pushed

The [Publish workflow](.github/workflows/publish.yml) triggers on that `v*` tag; started by hand it
builds and checks every file without releasing:

- **CLI.** One job per npm target builds `aitrack`: macOS for Apple Silicon, Windows x64, and Linux
  x64 and arm64 cross-built with `cargo zigbuild` against glibc 2.31. Each native build checks that
  `--version` matches the tag.
- **Desktop.** Windows, macOS and Ubuntu 24.04 jobs package with `cargo packager` the NSIS
  installer, the Apple Silicon DMG, the AppImage and `.deb`, plus the updater's signed
  `.app.tar.gz` and signatures, and smoke-check each bundle.
- **npm tarballs.** `cargo xtask npm-pack` wraps each binary in its `@aitrack/cli-<target>` package
  and packs the `aitrack` launcher that pins them as exact optional dependencies.
- **Draft release.** The tag's `CHANGELOG.md` section, the installers, `latest.json`, the
  `aitrack-<target>` binaries and their `checksums.txt` go into a draft. It runs before npm, which
  cannot be undone, so its failures surface first.
- **npm.** `cargo xtask publish-npm` publishes the platform packages, then the launcher, with
  provenance, skipping versions already on the registry. This job alone holds the npm credential;
  it compiles nothing and runs the `xtask` binary built once at the start of the workflow.
- **Publish the release.** The draft goes public only now, so opentrack and
  `aitrack install-opentrack`, which read `latest.json` from the latest release, never find it half
  uploaded.
- **Homebrew.** `Casks/opentrack.rb` gets the new version and DMG checksum.

A tag with a `-` is a prerelease: npm publishes it under `next`, the GitHub release never becomes
latest, and the Homebrew job is skipped. After a failure, re-run the failed jobs; the draft job
replaces assets with the same names and `publish-npm` skips what already published.

Windows builds are unsigned; macOS builds are ad hoc signed and not notarized.

### winget

opentrack's winget package (`bircni.opentrack`) is not in `microsoft/winget-pkgs` yet, and
release automation can only update an existing package, so the first version is submitted
by hand. `cargo xtask winget-manifest` writes that version's manifests into a `winget-pkgs`
checkout:

```sh
gh release download vX.Y.Z -p '*-setup.exe'
cargo xtask winget-manifest vX.Y.Z opentrack_X.Y.Z_x64-setup.exe ../winget-pkgs
```

On Windows, `winget validate --manifest manifests/b/bircni/opentrack/X.Y.Z` checks them, and
`winget install --manifest manifests/b/bircni/opentrack/X.Y.Z` (after
`winget settings --enable LocalManifestFiles`) installs from them. Commit them in a fork as
`New package: bircni.opentrack version X.Y.Z` and open a pull request to
`microsoft/winget-pkgs`. The manifest's publisher and product code must match what the
installer registers: `publisher` and `product-name` under `[package.metadata.packager]` in
`apps/opentrack/Cargo.toml`.
