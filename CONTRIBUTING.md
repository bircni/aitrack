# Contributing

## Development setup

Install rustup (the toolchain and components are pinned in `rust-toolchain.toml`), [just](https://just.systems),
`cargo-nextest`, `cargo-deny`, git, and, for the desktop renderer and the release scripts, Node.js (the
version in `.node-version`) and Bun (the version in `package.json`). The CLI itself needs no Node.

On macOS, install Xcode Command Line Tools. On Windows, install the Visual Studio C++ build tools and
WebView2. On Ubuntu, install the desktop app's system libraries:

```sh
sudo apt-get update
sudo apt-get install -y libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev libssl-dev patchelf
```

```sh
git clone https://github.com/bircni/aitrack.git
cd aitrack
bun install
cargo run -p aitrack-cli -- init
cargo run -p aitrack-cli -- sync
cargo run -p aitrack-cli -- show
```

## Project layout

A Cargo workspace plus one Bun workspace package for the desktop renderer.

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
  xtask/              `cargo xtask`: pricing pack build and check
apps/
  opentrack/          Tauri 2 app: window, tray, polling, alerts, settings, on aitrack-core
  opentrack-ui/       Svelte renderer in the system webview
npm/aitrack/          The npm launcher; one platform package per target is generated at release
scripts/              Release, release notes, npm pack and publish, updater manifest, Homebrew cask,
                      winget manifests, bundle smoke check
```

Usage is keyed by the **local** calendar day, so tests pin the zone through the `Clock` they pass
in (`Clock::fixed`, or `Clock::with_zone` with a zone from `jiff::tz::TimeZoneDatabase::bundled()`),
never by changing `TZ`; cover day edges in Pacific/Kiritimati, UTC and Pacific/Midway. Golden
tests use the bundled tz database because hosts disagree on pre-1901 offsets.

## Checks

```sh
just validate    # everything CI runs: Rust (fmt, clippy, nextest), JS (oxfmt, oxlint, knip,
                 # tsc, svelte-check, vitest) and cargo deny
just rust        # only the Rust checks
just js          # only the renderer and scripts
```

Clippy runs pedantic with `-D warnings`. The opentrack crate embeds the built renderer; the Rust
checks write a placeholder page when it has not been built.

CI (`.github/workflows/ci.yml`) runs on `main`, `rust` and pull requests: format and Clippy on
Ubuntu, tests on Ubuntu, macOS and Windows, cargo deny, and the renderer and scripts with
`bun audit`. Pull requests also get GitHub's dependency review. Dependabot proposes Bun, Cargo and
Actions updates.

## Desktop development

```sh
just desktop-dev                                      # build the renderer, run the app in debug
cd apps/opentrack && bunx tauri build                 # installers under target/release/bundle/
node scripts/smoke-opentrack-bundle.ts                # start the bundled app in smoke-test mode
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
commit messages, so non-conforming commits will be invisible in release notes.

## Releasing

Releases are generated from Conventional Commits using [git-cliff](https://git-cliff.org/). Tagging
and pushing happen locally; **npm publish and the GitHub release run in CI** when the tag lands.

### One-time setup

Configure `aitrack` and `@aitrack/cli-darwin-arm64`, `@aitrack/cli-linux-x64`,
`@aitrack/cli-linux-arm64` and `@aitrack/cli-win32-x64` on npm with
[GitHub Actions as a trusted publisher](https://docs.npmjs.com/trusted-publishers/) for this
repository and `.github/workflows/publish.yml`. Do not add a long-lived `NPM_TOKEN` secret.

opentrack's in-app updater only installs files signed with its release key. Add the private key
from `bunx tauri signer generate` and its password as the `TAURI_SIGNING_PRIVATE_KEY` and
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` secrets; the public key is `plugins.updater.pubkey` in
`apps/opentrack/tauri.conf.json` and `OPENTRACK_PUBLIC_KEY` in
`crates/cli/src/commands/install_opentrack.rs`, which a test keeps equal. Losing the private key
means installed apps can no longer update. The cask update pushes to `bircni/homebrew-tap` with the
private half of a write deploy key on that repository, stored as the `HOMEBREW_TAP_DEPLOY_KEY`
secret.

### Cut a release locally

```sh
node scripts/release.ts                 # patch bump
node scripts/release.ts minor
node scripts/release.ts 5.1.0-beta.1    # an exact version
node scripts/release.ts patch --dry-run
```

It checks that you are on `main` with a clean tree in sync with the remote and that the tag is free,
and stops otherwise. It then runs `just validate`, sets `[workspace.package] version` in `Cargo.toml`
(the CLI, opentrack and the npm packages all carry it), runs `cargo update --workspace`, updates
`CHANGELOG.md`, commits, tags `v<version>`, and pushes `main` and that tag atomically. The dry run
prints all of this, and whatever would stop a real release, without changing anything.

### After the tag is pushed

The [Publish workflow](.github/workflows/publish.yml) triggers on that `v*` tag; started by hand it
builds and checks every file without releasing:

- **CLI.** One job per npm target builds `aitrack`: macOS for Apple Silicon, Windows x64, and Linux
  x64 and arm64 cross-built with `cargo zigbuild` against glibc 2.31. Each native build checks that
  `--version` matches the tag.
- **Desktop.** The renderer is built once; Windows, macOS and Ubuntu 24.04 jobs package the NSIS
  installer, the Apple Silicon DMG, the AppImage and `.deb`, plus the updater's signed
  `.app.tar.gz` and signatures, and smoke-check each bundle.
- **npm tarballs.** `scripts/npm-pack.ts` wraps each binary in its `@aitrack/cli-<target>` package
  and packs the `aitrack` launcher that pins them as exact optional dependencies.
- **Draft release.** The tag's `CHANGELOG.md` section, the installers, `latest.json`, the
  `aitrack-<target>` binaries and their `checksums.txt` go into a draft. It runs before npm, which
  cannot be undone, so its failures surface first.
- **npm.** `scripts/publish-npm.ts` publishes the platform packages, then the launcher, with
  provenance, skipping versions already on the registry. This job alone holds the npm credential.
- **Publish the release.** The draft goes public only now, so opentrack and
  `aitrack install-opentrack`, which read `latest.json` from the latest release, never find it half
  uploaded.
- **Homebrew.** `Casks/opentrack.rb` gets the new version and DMG checksum.

A tag with a `-` is a prerelease: npm publishes it under `next`, the GitHub release never becomes
latest, and the Homebrew job is skipped. After a failure, re-run the failed jobs; the draft job
replaces assets with the same names and the npm script skips what already published.

Windows builds are unsigned; macOS builds are ad hoc signed and not notarized.

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
