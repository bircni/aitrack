# Architecture

[Back to the overview](../README.md) · [Contributing](../CONTRIBUTING.md)

Everything except the window's markup is Rust. `crates/core` (aitrack-core) holds the logic; the
`aitrack` binary in `crates/cli` and the opentrack app in `apps/opentrack` are thin shells over it.

## Data flow

```text
local logs / Cursor export                  other machines
        │                                        │
   readers/ (parse + cache)            git clone of the data repo
        │                                        │
   DayMap per provider ──► machine file ──► data/{machineId}.json
        │                  (store/, schema)      │
        └──────────────► data/usage_data ◄───────┘
                               │
                     data/usage_report (periods, totals, comparisons)
                               │
        ┌──────────────────────┼───────────────────────┐
   display/ (TUI, PNG,    crates/cli commands     apps/opentrack (egui popup
   PDF, CSV)                                       on the same state)
```

- **`Core`** owns what a run shares: environment, paths, clock, output, the HTTP client, the
  pricing store and Cursor's retry state. The CLI builds one per run; opentrack keeps one for its
  lifetime. Tests pass a fixed clock, zone and scripted HTTP client instead of changing the process.
- **Readers** turn provider logs into a `DayMap`: local calendar day → token counts per model. Only
  lines that can count are parsed, and a large cold read is scanned on up to four threads. Each
  parsed transcript is cached by path, size and modification time, and a provider's merged result
  is kept in a snapshot reused while no source file changed. See
  [reader benchmarks](reader-benchmarks.md).
- **Projects**: each message is attributed to the `owner/repo` of its git origin (Codex records it;
  for Claude Code the transcript's `cwd` is resolved with `git remote get-url origin`, every
  repository at once). Day entries carry an optional `byProject` map, written to machine files
  without a schema bump. Working directories of work without a remote stay local, for `usage --dir`
  on this machine. See [Usage by project](cli.md#usage-by-project).
- **Pricing** is applied while reading and again by `recompute-costs`. Stored costs are kept as
  written until repriced.
- **`usage_data`** merges this machine's fresh logs over its synced file and the other machines'
  files. Reports are built from that one merged set, so the CLI and the desktop app show the same
  numbers.
- **Machine files** carry a `schemaVersion`; `store/migrate` upgrades older files in memory.
- **Byte compatibility**: 4.x machines may sync into the same repo, so everything written there or
  to the shared config goes through `aitrack_core::js`, which formats numbers, sorts keys and
  pretty-prints JSON exactly as Node did. The golden fixtures recorded from 4.x pin it.

## Providers

A provider is a descriptor in `providers.rs` (key, label, aliases, whether it has live limits),
plus either:

- a **synced** reader: Claude Code and Codex, read from local logs and written to the data repo; or
- a **live** reader: Cursor, fetched from the account (cached for six hours by default) and never
  written to git.

Live limits (session and weekly windows) live in `quota/`, one module per provider.

To add a provider: add its descriptor, implement the reader under `readers/`, its rate table under
`pricing-tables/` and its pricing in `pricing/`, and cover the log format with a fixture-driven test.

## opentrack

```text
ui/ (egui) ◄── app.rs ──► background.rs, service.rs on aitrack-core
 dashboard,     window,      quota fetches, usage, settings, cache,
 settings       tray, OS     tray icon, alerts
```

One native process, no webview. Background threads own all provider access and state and send each
new `AppState`, the settings, alerts and tray pictures to the UI thread, which wakes even while the
popup is hidden. The UI draws from that state and hands back actions (refresh, sync, save settings,
install an update) for `app.rs` to carry out. `tray-icon`, `global-hotkey`, `auto-launch` and
`notify-rust` cover the tray, shortcut, start at login and alerts; the updater reads the same
`latest.json` and key as 4.x's Tauri updater through `aitrack_core::update`, which
`aitrack install-opentrack` shares.
