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
   display/ (TUI, PNG,    apps/aitrack commands   apps/opentrack (Rust, on
   PDF, CSV)                                       aitrack-core; JSON for the dashboard)
```

- **Readers** turn provider logs into a `DayMap`: local calendar day → token counts per model. Only
  lines that can count are parsed, and a large cold read is scanned on worker threads. Each parsed
  transcript is cached by path, size and modification time, and a provider's merged result is kept
  in a snapshot reused while no source file changed. The parse cache is not rewritten when only
  recently active files changed. See [reader benchmarks](reader-benchmarks.md).
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

- a **synced** reader (`SyncedProvider`): Claude Code and Codex, read from local logs and written to the
  data repo; or
- a **live** reader (`LiveProvider`): Cursor, fetched from the account (cached for six hours by default) and never written to git.

Providers are registered in `libs/aitrack-lib/src/providers/registry.ts`, on top of the dependency-free
names and keys in `providers/descriptors.ts`. Live quota limits (session and weekly windows) are separate
and live in `libs/aitrack-lib/src/quota/`; their provider keys derive from each descriptor's `hasQuota`,
so a flagged provider without a fetcher is a compile error.

To add a provider: start with its descriptor in `providers/descriptors.ts`, implement the reader under
`readers/`, its rate table under `pricing/tables/`, the provider module under `providers/`, register it,
and cover the log format with a fixture-driven test.

## opentrack

```text
Svelte renderer ◄──► Tauri app (Rust)
 dashboard, settings   window, tray, shortcut, autostart, updater, and on aitrack-core:
                       quota fetches, usage, settings, tray icon, alerts
```

The app owns all provider access and state on background threads; the renderer only renders the
`AppState` it is pushed and sends requests (refresh, sync, save settings). `service_status` always
reports `running`, since the work runs in the app's own process. The shared types are in
`apps/opentrack-ui/src/shared/types.ts`.
