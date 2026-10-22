# aitrack for Raycast

Live Claude Code, Codex and Cursor limits, token usage and estimated cost in Raycast, from
the same data and report builder as the `aitrack` CLI and opentrack.

## Commands

- **Show Limits** — session, weekly and per-model limits with % used, reset countdown and
  pacing, plus balances such as remaining credits. Uses each tool's saved login.
- **Show Usage** — tokens and estimated cost per provider for today, yesterday, the last 7
  or 30 days, or all time, with a per-model breakdown. Includes synced machines when
  `aitrack init` has set up a data repo.

## Development

From the repository root:

```sh
pnpm install
pnpm nx run raycast:dev     # builds aitrack-lib, then `ray develop` imports the extension into Raycast
pnpm nx run raycast:build   # production bundle in apps/raycast/dist
```

The extension depends on `aitrack-lib` through the workspace. A Raycast Store submission
would need it from npm instead.
