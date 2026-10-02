# opentrack desktop guide

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
  provider and limit by default; Settings picks a provider and session or weekly instead. Choose
  **Bars** for a rounded progress bar per available limit (session, weekly and model limits),
  grouped by provider in dashboard order, or **Icon** for
  the "O". Turn off **Colored tray icon** for monochrome; macOS adapts it to the menu-bar appearance.

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

## Downloads

Windows installers and macOS disk images (Apple Silicon, macOS 13.5+) are attached to the
[same GitHub releases](https://github.com/bircni/aitrack/releases) as aitrack. Choose the
`.exe` on Windows, or the `.dmg` matching your Mac, and drag opentrack to Applications.

Windows builds are unsigned. macOS builds are ad hoc signed and are not notarized.
SmartScreen or Gatekeeper may block the first launch.

See [Contributing](../CONTRIBUTING.md#desktop-development) to build from source.

## Acknowledgements

opentrack follows the design of [OpenQuota](https://github.com/deviffyy/OpenQuota) (MIT), whose
provider research and pacing model it ports to TypeScript on top of aitrack-lib. The provider
logos and the pin icon come from OpenQuota's frontend.
