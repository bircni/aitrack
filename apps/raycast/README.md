# aitrack for Raycast

Live Claude Code, Codex and Cursor limits, token usage and estimated cost in Raycast, from
the same data and report builder as the `aitrack` CLI and opentrack.

## Commands

- **Show Limits** — session, weekly and per-model limits with reset times and pacing, plus
  balances such as remaining credits. Uses each tool's saved login.
- **Show Usage** — tokens and estimated cost per provider and model for today, yesterday,
  this week or month, the last 7, 30 or 90 days, last month, or all time. Includes synced
  machines when `aitrack init` has set up a data repo.

## Preferences

Like opentrack's settings: which providers to show, limits as used or left, reset times as
a time or a countdown, and for **Show Usage** the period it opens on and whether to pull
other machines' usage first. Open them with ⌘, from either command.

## Development

From the repository root:

```sh
pnpm install
pnpm nx run raycast:dev     # builds aitrack-lib, then `ray develop` imports the extension into Raycast
pnpm nx run raycast:build   # production bundle in apps/raycast/dist
```

The extension depends on `aitrack-lib` through the workspace. A Raycast Store submission
would need it from npm instead.
