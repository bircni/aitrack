# Architecture

[Back to the overview](../README.md) · [Contributing](../CONTRIBUTING.md)

## Data flow

```text
local logs / Cursor export                  other machines
        │                                        │
   readers/ (parse + cache)            git clone of the data repo
        │                                        │
   DayMap per provider ──► machine file ──► data/{machineId}.json
        │                  (store/, schema)      │
        └──────────────► data/usageData ◄────────┘
                               │
                     data/usageReport (periods, totals, comparisons)
                               │
        ┌──────────────────────┼───────────────────────┐
   display/ (TUI, PNG,    apps/aitrack commands   apps/opentrack-ui sidecar
   PDF, CSV)                                       (JSON for the dashboard)
```

- **Readers** turn provider logs into a `DayMap`: local calendar day → token counts per model. Each
  parsed transcript is cached by path, size and modification time.
- **Projects**: each message is attributed to the `owner/repo` of its git origin (Codex records it;
  for Claude Code the transcript's `cwd` is resolved with `git remote get-url origin`). Day entries
  carry an optional `byProject` map, written to machine files without a schema bump. Working
  directories of work without a remote stay local, for `usage --dir` on this machine. See
  [Usage by project](cli.md#usage-by-project).
- **Pricing** is applied while reading and again by `recompute-costs`. Stored costs are kept as
  written until repriced.
- **`usageData`** merges this machine's fresh logs over its synced file and the other machines' files.
  Reports are built from that one merged set, so the CLI and the desktop app show the same numbers.
- **Machine files** carry a `schemaVersion`; `store/migrations` upgrades older files in memory.

## Providers

A provider is a descriptor, a heatmap palette, a pricing function and a doctor check, plus either:

- a **synced** reader (`SyncedProvider`): Claude Code, Codex and Mistral Vibe, read from local logs and written to the
  data repo; or
- a **live** reader (`LiveProvider`): Cursor, fetched from the account (cached for six hours by default) and never written to git.

Providers are registered in `libs/aitrack-lib/src/providers/registry.ts`. Live quota limits (session and
weekly windows) are separate and live in `libs/aitrack-lib/src/quota/`.

To add a provider: implement the reader under `readers/`, its rate table under `pricing/tables/`, the
provider module under `providers/`, register it, and cover the log format with a fixture-driven test.

## opentrack

```text
Svelte renderer ◄──► Tauri shell (Rust) ◄── JSON lines over stdio ──► Node sidecar
 dashboard, settings   window, tray, shortcut,                       quota fetches, usage
                       autostart, updater                            (aitrack-lib), settings,
                                                                     tray icon, alerts
```

The Rust shell supervises the sidecar and restarts it with a growing delay when it stops. The sidecar
owns all provider access and state; the renderer only renders the `AppState` it is pushed and sends
requests (refresh, sync, save settings). The shared types are in
`apps/opentrack-ui/src/shared/types.ts`.
