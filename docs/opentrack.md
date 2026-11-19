# opentrack desktop guide

A tray (or menu-bar) dashboard for Claude Code and Codex: live session and weekly limits
with reset times and pacing, plus token usage and estimated cost from the same data `aitrack`
reads — including other machines synced through your aitrack data repo.

## What it shows

The popup has two tabs. **Limits** answers whether anything is about to run out; **Usage** shows
where the tokens and their estimated cost went. The left and right arrow keys switch between them.
Both are drawn the way `aitrack show` draws its heatmap: in cells, in each provider's heatmap colours.

- **Limits** — the ring from the app icon is filled to the limit that matters most: the most
  urgent one, or the next to reset when every limit is on track, with what to make of it beside
  it. Each provider then shows its session and weekly limits as a row of cells and the rest on one
  line each: Claude Code's per-model weekly limits and extra usage and Codex's credits. A one-line
  limit shows its reset time and pace on hover.
- **Pacing** — whether each limit is on track to last until it resets, with alerts when one is
  almost used up or on pace to run out. Settings picks how much left counts as almost used up
  (5, 10, 20 or 30%; 10% by default) and can add an alert for a weekly limit that resets within
  a day with over half of it left. The outlined cell is the even-pace marker: where usage would be
  now if the limit were used evenly until it resets. A limit's cells wear its provider's colours
  while it is on track and the warning or critical colour when it is not.
- **Usage** — one period (Today / 7 days / 30 days / All time) sets the estimated cost, the tokens
  and the breakdown. Under it is the heatmap of estimated cost per day for the last 18 weeks, a
  column per week from Monday, with the chosen period lit and the other days dimmed; hover a day
  for its cost. Below are the current streak, the longest streak and the peak day, all within
  those 18 weeks, so a streak that began earlier reads as "or more". Numbers come from the same
  report builder as `aitrack usage`, so they match the CLI.
- **By model** — the breakdown's default: every model used in the period with its provider, cost,
  tokens and share.
- **By project** — projects (the git `owner/repo` of the folder the work ran in) with cost, tokens
  and their share, coloured by provider; open one for its split per provider. Usage that no
  project explains is shown as `(unattributed)`, and work in folders without a remote as
  `(no remote)`. Attribution starts with the next refresh (this machine) or sync (other machines), so the list is empty until then and older
  synced days stay unattributed. The numbers come from the same report builder as
  `aitrack top projects`.
- **By machine** — with a synced data repo, the same estimated cost per machine: its share of the
  period, a 30-day activity strip on one scale for every machine, shaded at the same steps as
  `aitrack`'s heatmap, the machine's local time when its timezone differs, and when it last
  synced. A machine that has not synced for three days is marked stale. This machine always shows
  its live logs. Open a machine for its split per provider and its top models.
- **Tray icon** — the opentrack "O" filled like a pie, coloured by pace. It follows the most used
  provider and limit by default; Settings picks a provider and session or weekly instead. Choose
  **Bars** for a rounded progress bar per available limit (session, weekly and model limits),
  grouped by provider in dashboard order, or **Icon** for
  the "O". Turn off **Colored tray icon** for monochrome; macOS adapts it to the menu-bar appearance.
  A limit whose reset has passed is left out until fresh numbers arrive.

Dates, times and numbers follow the system language: grouping, decimal separators and clock
format. Costs stay in US dollars. The interface text is English only. Limit meters expose their
value to screen readers, the results of a refresh or sync you start are announced politely, focus
is always visible, and with reduced motion enabled the spinners stop and sections expand without
sliding.

The popup opens next to the tray, takes the height of what it shows and hides when you click
elsewhere. **Keep open** in Settings turns it into a window that stays open and keeps the place you
drag it to by its footer. The footer's compact button switches to the
**compact view**: one line per enabled provider with its session limit, and the limit that needs
attention when there is one. Closing the window
hides it; quit from the tray menu or the Quit button in Settings. Escape leaves Settings, and
otherwise hides the popup, but not a window kept open.

## When something is wrong

- **Sign-in problems** say what to run. Sign in with that tool, then press Retry.
- **Rate limits** — a retry-after the provider stated cannot be skipped by Refresh or Retry; the
  provider shows how long is left and a link to its dashboard. With no stated retry-after, Retry
  tries again at once.
- **No numbers** — while usage is loading, failed to load or does not exist yet, totals show a dash
  and say which, never `$0.00`. A real zero still shows `$0.00`.
- **Old limits** — a limit past its reset reads "Reset passed, waiting for new data". Limits kept
  from an earlier fetch show no pace. The footer's age is that of the oldest limits on screen.
- **Background service** — if it cannot start or keeps crashing, the dashboard shows a banner with
  the reason, the footer says it stopped, and Refresh and Sync are disabled. The last numbers stay,
  as cached ones, and the dashboard reloads when the service recovers. A request the service does
  not answer within 30 seconds fails with an error. Only 300 seconds with no output while an answer
  is owed restarts it, and a second such restart in a row counts as down; any `git` it was running continues until its own timeout.

## Where data comes from

opentrack reuses the logins your tools already saved and never writes to them:

| Provider    | Credentials read                                | Request                                          |
| ----------- | ----------------------------------------------- | ------------------------------------------------ |
| Claude Code | `~/.claude/.credentials.json` (macOS: Keychain) | `GET https://api.anthropic.com/api/oauth/usage`  |
| Codex       | `$CODEX_HOME/auth.json`, `~/.codex/auth.json`   | `GET https://chatgpt.com/backend-api/wham/usage` |

Tokens are not refreshed by opentrack: when one expires, the provider shows a message until you
next use that tool. When Claude Code left more than one login behind, such as an old file beside the
Keychain item, the one that is still valid is used. Codex limits need a ChatGPT login; an API-key-only Codex setup shows none.

Usage history comes from the local Claude/Codex logs. A provider turned off in Settings is neither
read nor contacted. Usage is merged with the other machines in your aitrack data repo when one is configured (`aitrack init`). opentrack
`git pull`s that repo every 30 minutes (can be turned off). It commits and pushes only when you
press the sync button in the dashboard, which does exactly what `aitrack sync` does, including refusing
a clone whose `origin` differs from `repoUrl`; that shows as a failed sync.

**Sync settings** (off by default) shares the settings that mean the same on every machine through
that repo: the theme, limits shown as used or left, reset times, the providers' order and which
are on, alerts with their threshold and the unused-limit alert, the
compact view, and the tray's provider and limit. Start at login, the shortcut, Keep open, the
tray's style and colour and the two data repo switches stay with each machine. The shared settings
are one file, `opentrack/settings.json`, with the time they last changed, and the newest change
wins as a whole rather than key by key. opentrack takes a newer file over its own settings after a
pull, and a machine that turns the setting on takes what the repo already has. Changes made here
go out the next time you press the sync button, never on their own; with **Include other
machines** off, that is also the only time other machines' changes come in. When two machines push
at once, the later change is kept and the other machine takes it. With
[`encryptData`](cli.md#encrypting-the-synced-files) on, the file is encrypted like the machine
files and stays encrypted whichever machine rewrites it; a machine without the passphrase leaves
it alone and its sync says so.

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
the download must carry a signature from the release key or it is refused. On Linux only
the AppImage updates itself; a `.deb` install is told of the new version without that action. A release withdrawn
after being offered stops being offered at the next check. Development builds never check.

Settings and the last snapshot live in the app's data folder
(`~/Library/Application Support/dev.bircni.opentrack` on macOS, `%APPDATA%\dev.bircni.opentrack` on
Windows, `~/.local/share/dev.bircni.opentrack` on Linux): `settings.json`, `cache.json` (discarded
rather than migrated when its format is older), and `opentrack.log`, with the previous run's in
`opentrack.log.1`. **Export…** next to Logs in Settings zips both logs to a place you choose. There is no account, telemetry or backend. Besides providers and your data repo, opentrack only contacts GitHub: for the update
check, and for the pricing refresh the sync button runs like `aitrack sync` (at most daily).

## Downloads

```sh
brew install --cask bircni/tap/opentrack   # macOS 13.5+, Apple Silicon
npx aitrack install-opentrack              # macOS (Apple Silicon), 64-bit Windows or Linux
```

The cask lives in [bircni/homebrew-tap](https://github.com/bircni/homebrew-tap), not in
Homebrew's own cask repository, which only accepts notarized apps. It removes the
quarantine flag after installing, since an app that is not notarized would otherwise be
refused by Gatekeeper. opentrack then updates itself, so `brew upgrade` leaves it alone
unless you pass `--greedy`.

`aitrack install-opentrack` fetches the same release the in-app updater uses, checks its
signature and installs it: on macOS it replaces `opentrack.app` in `/Applications`
(`--dir` for another folder), on Windows it runs the installer, and on Linux it writes
`opentrack.AppImage` to `~/.local/bin` (`--dir` for another folder).

Windows installers, macOS disk images (Apple Silicon, macOS 13.5+) and Linux AppImage and
`.deb` packages (x86_64) are also attached to the
[same GitHub releases](https://github.com/bircni/aitrack/releases) as aitrack. Choose the
`.exe` on Windows, or the `.dmg` on an Apple Silicon Mac and drag opentrack to Applications. On
Linux, run the `.AppImage` after `chmod +x`, or install the `.deb` with
`sudo apt install ./opentrack_*_amd64.deb`.

Windows builds are unsigned. macOS builds are ad hoc signed and are not notarized.
SmartScreen or Gatekeeper may block the first launch.

See [Contributing](../CONTRIBUTING.md#desktop-development) to build from source.

## Linux

Linux packages are built on Ubuntu 24.04 for x86_64; distributions with an older glibc may
not start them. The behaviour differs from macOS and Windows in a few places:

- **Tray icon** — shown through AppIndicator / StatusNotifierItem. KDE Plasma, Xfce, Cinnamon
  and Ubuntu's GNOME session show it; stock GNOME needs the AppIndicator extension. A tray
  click always opens the menu, so open the dashboard with **Open** there. The icon has no
  hover tooltip.
- **Display backend** — opentrack runs through X11 (XWayland in a Wayland session) so it can
  position the dashboard and register the global shortcut. Set `OPENTRACK_WAYLAND=1` to
  override this; the dashboard is then placed by the compositor, typically in the centre, and
  the shortcut only fires while an XWayland window has focus.
- **Popup position** — the dashboard opens in the top-right corner of the screen.
- **Global shortcut** — needs X11 or XWayland; without it Settings shows why it could not be
  registered.
- **Launch at login** — writes `~/.config/autostart/opentrack.desktop`, pointing at the
  AppImage or the installed binary. After moving the AppImage, start it once from its new
  place so the entry follows.
- **Credentials** — there is no Keychain to fall back on, so the files are the only source:
  Claude Code's `.credentials.json` in `$CLAUDE_CONFIG_DIR`, `~/.config/claude` or `~/.claude`, and
  Codex's `auth.json` in `$CODEX_HOME`, `~/.codex` or `~/.config/codex`.
- **Updates** — the AppImage replaces itself in place, so keep it in a folder you can write
  to. A `.deb` install cannot: it shows that a new version is available, and you install the new
  `.deb` from the GitHub release with your package manager.
- **AppImage** — needs FUSE 2 to start (`libfuse2`, or `libfuse2t64` on Ubuntu 24.04); use the
  `.deb` otherwise.

## Acknowledgements

opentrack follows the design of [OpenQuota](https://github.com/deviffyy/OpenQuota) (MIT), whose
provider research and pacing model it ports to Rust in aitrack-core. The provider
logos come from OpenQuota's frontend.
