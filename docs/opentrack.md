# opentrack desktop guide

A tray (or menu-bar) dashboard for Claude Code, Codex and Cursor: live session and weekly limits
with reset times and pacing, plus token usage and estimated cost from the same data `aitrack`
reads — including other machines synced through your aitrack data repo.

## What it shows

- **Limits** — Claude Code session / weekly / per-model weekly windows and extra usage; Codex
  session and weekly windows and credits; Cursor total, Auto and API usage and on-demand spend.
- **Pacing** — whether each limit is on track to last until it resets, with an even-pace marker
  and alerts when one is almost used up or on pace to run out.
- **Usage** — today, yesterday, the last 7 / 30 days and all-time per provider, a daily trend
  and a per-model breakdown. Numbers come from the same report builder as `aitrack usage`, so
  they match the CLI.
- **Machines** — with a synced data repo, a tab next to Providers splits the same spend per
  machine: its share of the period, a 30-day activity strip on one scale for every machine, the
  machine's local time when its timezone differs, and when it last synced. A machine that has not
  synced for three days is marked stale. This machine always shows its live logs. Cursor usage
  comes from your Cursor account, not from any machine, so it is listed separately.
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

Usage history comes from the local Claude/Codex logs and, while Cursor is enabled, Cursor's CSV
usage export, which is downloaded from `CURSOR_WEB_BASE_URL` (`https://cursor.com` by default) with
the saved Cursor token at most every 6 hours (`AITRACK_CURSOR_CACHE_TTL`) and on each manual
refresh. A provider turned off in Settings is neither read nor contacted. Usage is merged with the
other machines in your aitrack data repo when one is configured (`aitrack init`). opentrack
`git pull`s that repo every 30 minutes (can be turned off). It commits and pushes only when you
press the sync button in the popup, which does exactly what `aitrack sync` does.

A failed pull remains visible until recovery and retries after one minute; a successful
pull restores the 30-minute schedule. Failed local reads retain their own warning.
Quota and usage update times advance only after successful updates and survive app
restarts. Failed refreshes display the age of retained data. Mixed priced/unpriced
usage displays a partial estimate rather than implying a complete dollar total.

Refresh and sync command-delivery failures show retry controls separately from operation
failures. Failed settings saves keep the newest queued changes and provide a retry;
pushed settings cannot overwrite those pending edits.

Shortly after launch and every six hours, opentrack fetches `latest.json` from the latest
GitHub release. When it lists a newer version, the dashboard offers **Install and restart**;
the download must carry a signature from the release key or it is refused. Development
builds never check.

Settings and the last snapshot live in the app's data folder (`%APPDATA%\dev.bircni.opentrack` on
Windows): `settings.json`, `cache.json`, and `sidecar.log`. There is no account, telemetry or
backend. Besides providers and your data repo, opentrack only contacts GitHub: for the update
check, and for the pricing refresh the sync button runs like `aitrack sync` (at most daily).

## Downloads

```sh
brew install --cask bircni/tap/opentrack   # macOS 13.5+, Apple Silicon
npx aitrack install-opentrack              # macOS (Apple Silicon) or 64-bit Windows
```

The cask lives in [bircni/homebrew-tap](https://github.com/bircni/homebrew-tap), not in
Homebrew's own cask repository, which only accepts notarized apps. It removes the
quarantine flag after installing, since an app that is not notarized would otherwise be
refused by Gatekeeper. opentrack then updates itself, so `brew upgrade` leaves it alone
unless you pass `--greedy`.

`aitrack install-opentrack` fetches the same release the in-app updater uses, checks its
signature and installs it: on macOS it replaces `opentrack.app` in `/Applications`
(`--dir` for another folder), on Windows it runs the installer.

Windows installers and macOS disk images (Apple Silicon, macOS 13.5+) are also attached to
the [same GitHub releases](https://github.com/bircni/aitrack/releases) as aitrack. Choose
the `.exe` on Windows, or the `.dmg` matching your Mac, and drag opentrack to Applications.

Windows builds are unsigned. macOS builds are ad hoc signed and are not notarized.
SmartScreen or Gatekeeper may block the first launch.

See [Contributing](../CONTRIBUTING.md#desktop-development) to build from source.

## Acknowledgements

opentrack follows the design of [OpenQuota](https://github.com/deviffyy/OpenQuota) (MIT), whose
provider research and pacing model it ports to TypeScript on top of aitrack-lib. The provider
logos and the pin icon come from OpenQuota's frontend.
