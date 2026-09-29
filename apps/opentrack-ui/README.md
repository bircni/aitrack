# opentrack

A tray (or menu-bar) dashboard for Claude Code, Codex and Cursor: live session and weekly limits
with reset times and pacing, plus token usage and estimated cost from the same data `aitrack`
reads — including other machines synced through your aitrack data repo.

## What it shows

- **Limits** — Claude Code session / weekly / per-model weekly windows and extra usage; Codex
  session and weekly windows and credits; Cursor total, Auto and API usage and on-demand spend.
- **Pacing** — whether each limit is on track to last until it resets, with an even-pace marker
  and alerts when one is almost used up or on pace to run out.
- **Usage** — today, yesterday and the last 30 days per provider, a daily trend and a per-model
  breakdown. Numbers come from the same report builder as `aitrack usage`, so they match the CLI.
- **Tray icon** — the opentrack "O" filled like a pie, coloured by pace. It follows the most used
  provider and limit by default; Settings picks a provider and session or weekly instead.

## Where data comes from

opentrack reuses the logins your tools already saved and never writes to them:

| Provider    | Credentials read                                   | Request                                                    |
| ----------- | -------------------------------------------------- | ---------------------------------------------------------- |
| Claude Code | `~/.claude/.credentials.json` (macOS: Keychain)    | `GET https://api.anthropic.com/api/oauth/usage`            |
| Codex       | `$CODEX_HOME/auth.json`, `~/.codex/auth.json`      | `GET https://chatgpt.com/backend-api/wham/usage`           |
| Cursor      | `cursorAuth/accessToken` in Cursor's `state.vscdb` | `POST https://api2.cursor.sh/aiserver.v1.DashboardService` |

Tokens are not refreshed by opentrack: when one expires, the provider shows a message until you
next use that tool. Codex limits need a ChatGPT login; an API-key-only Codex setup shows none.

Usage history is read locally (Claude/Codex logs, Cursor's usage export) and merged with the other
machines in your aitrack data repo when one is configured (`aitrack init`). opentrack `git pull`s
that repo every 30 minutes (can be turned off). It commits and pushes only when you press the sync
button in the popup, which does exactly what `aitrack sync` does.

Settings and the last snapshot live in the app's data folder (`%APPDATA%\dev.bircni.opentrack` on
Windows): `settings.json`, `cache.json`, and `sidecar.log`. There is no account, telemetry or
backend.

## How it is built

Two Nx projects:

- **`opentrack-ui`** (this folder) is TypeScript: the Svelte popup (`src/renderer`, built by the
  inferred `@nx/vite` target) and a Node sidecar (`src/sidecar`) that fetches limits, reads usage
  through aitrack-lib and pushes state. The sidecar is bundled with `@nx/esbuild` and packed into
  one executable with Node's `--build-sea` (`sea` target).
- **`opentrack`** (`apps/opentrack`) is the Tauri 2 shell in Rust: tray icon, window,
  notifications, autostart and shortcut. It starts the sidecar without a console and talks to it
  over JSON lines on stdin/stdout. It builds, lints and tests through `@monodon/rust`.

The popup uses the system WebView2 (built into Windows 10 and 11) instead of bundling a browser.

```sh
pnpm install
pnpm nx run opentrack:dev        # build everything and launch
pnpm nx run opentrack-ui:test
pnpm nx run opentrack:test       # Rust unit tests
pnpm nx run opentrack:package    # installer, in target/release/bundle/nsis
```

Needs a Rust toolchain (`rustup`) in addition to Node.

Releases are built by `.github/workflows/opentrack-release.yml` on an `opentrack-v*` tag. Builds
are not code-signed, so Windows SmartScreen and macOS Gatekeeper ask for confirmation.

## Acknowledgements

opentrack follows the design of [OpenQuota](https://github.com/deviffyy/OpenQuota) (MIT), whose
provider research and pacing model it ports to TypeScript on top of aitrack-lib. The provider
logos and the pin icon come from OpenQuota's frontend.
