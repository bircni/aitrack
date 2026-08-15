# Changelog

All notable changes to this project will be documented in this file.

## [v1.4.0] - 2026-08-15


### Bug Fixes

- **security:** Update dependencies
- **sync:** Report family-fallback pricing however the push turns out

### CI

- Run the test suite once instead of twice

### Documentation

- **pricing:** Describe the live case in the overrides comment

### Performance

- **machines:** Skip the local JSONL parse
- **readers:** Parse session files with bounded concurrency
- **readers:** Cache parsed transcripts by mtime and size

### Refactoring

- **data:** Share the structural type guards
- **readers:** Keep a single JSONL directory walker
- **sync:** Extract the push, message and logging helpers
- **recompute:** Split the repricing pass out of the command
- **pricing:** Share the family-fallback warning
- **cli:** Name the abbreviated exports at their definition
- **display:** Put usage-period arithmetic on one clock
- **display:** Share the provider stat figures
- Let the linter enforce the numeric template style

### Tests

- Share the duplicated day fixtures and console capture
- Make the date fixtures independent of the machine timezone

## [v1.3.1] - 2026-08-03


### Bug Fixes

- **pricing:** Apply the 2026-07-30 gpt-5.6 price cut by usage date (#60)

## [v1.3.0] - 2026-08-02


### Bug Fixes

- **sync:** Keep synced history that pruned local logs no longer cover
- **recompute:** Only rewrite machine files that actually changed
- **sync:** Push commits stranded by an earlier failed push
- **init:** Stop a stale staged data file from bricking init
- **tui:** Count calendar days once in the TOTAL row
- **display:** Humanize single-version and version-first Claude model IDs
- **format:** Promote to the next unit instead of rounding past it
- **readers:** Drop Claude entries with an unparseable timestamp
- **pricing:** Price the Claude 3 generation from its own rates
- **cursor:** Degrade instead of crashing when the CSV body fails
- **heatmap:** Use a nearest-rank percentile for the intensity ceiling
- **heatmap:** Size the grid for years that need 54 week columns
- **heatmap:** Let the current streak survive a day that has not started
- **cursor:** Keep rows whose token breakdown is populated
- **data:** Keep day cost consistent with the per-model costs
- **git:** Commit a staged deletion instead of crashing on the missing file
- **daemon:** Cap the refresh interval below the timer overflow
- Keep persisted machine data from being under-reported or overwritten

### Performance

- **daemon:** Parse the local logs once per refresh, and overlap Cursor
- **pricing:** Memoize Claude model-id canonicalization

### Refactoring

- **data:** Share one DayMap merge instead of two drifted copies
- Drop dead fields and reuse existing helpers
- **tui:** Build the TOTAL row from merged day maps
- **git:** Delete the dead tryPull helper
- **init:** Remove a conditional that could never be false
- **display:** Keep provider names and keys in one place each
- **heatmap:** Drop two pure alias functions
- **scripts:** Share the pricing drift report between providers
- Collapse three rolling-window cases and the codex gpt-5 special case
- Write the model-id suffix rules down once

## [v1.2.0] - 2026-07-24


### Bug Fixes

- **pricing:** Add Claude Opus 5 rates

### CI

- Add cross-platform CLI smoke coverage
- Delay fresh dependency updates

### Features

- **usage:** Compare with previous periods
- **sync:** Harden concurrent daemon refreshes
- **release:** Publish GitHub releases from changelog (#53)

### Tests

- Cover operational edge cases

## [v1.1.1] - 2026-07-22


### Bug Fixes

- **pricing:** Keep unknown Fable/Mythos models on the top tier
- **data:** Derive machine identity from the short hostname

## [v1.1.0] - 2026-07-12


### Bug Fixes

- **pricing:** Detect new codex models and verify fable/mythos pricing (#42)
- **cli:** Keep empty JSON responses machine-readable
- **cli:** Align option and help contracts
- **codex:** Preserve session day and model attribution
- **pricing:** Use exact and cache-aware model costs
- **data:** Validate and repair aggregate totals
- **cursor:** Preserve legacy aggregate token rows
- **release:** Preview versions and push exact tags
- **build:** Make dist cleanup cross-platform
- **release:** Allow remote-free dry-run previews
- **cursor:** Require secure export endpoints
- **pricing:** Detect and price current vendor models
- **ci:** Run vendor pricing checks weekly
- **security:** Constrain machine data filenames
- **data:** Migrate machine identities safely
- **data:** Preserve persisted machine history
- **config:** Expose typed daemon defaults

### Build

- Migrate from eslint/prettier to oxc (oxlint + oxfmt) (#38)

### Documentation

- Align commands privacy and publishing behavior

## [v1.0.0] - 2026-07-07


### Bug Fixes

- Harden release readiness checks

### Features

- Support custom usage source directories
- Add doctor command
- Add sync dry run
- Expand export periods
- Add json output modes

### Refactoring

- **readers:** Centralize JSONL walking and source root resolution
- **pricing:** Move Claude cost estimation into pricing layer
- **cli:** Unify usage period parsing and command registration
- **data:** Centralize empty states, sorting, and provider policy
- **git:** Run git via spawnSync with argv arrays
- **display:** Share heatmap layout and simplify render entrypoints
- **commands:** Normalize JSON output and improve doctor diagnostics

### Tests

- Cover doctor command
- Improve command branch coverage

## [v0.6.0] - 2026-07-05


### Features

- Replace --no-cursor with --providers allowlist (#32)

## [v0.5.1] - 2026-07-03


### Features

- **pricing:** Update Claude pricing for sonnet-5 and add introductory pricing details

## [v0.5.0] - 2026-06-28


### Features

- **heatmap:** Split stat token amounts onto a lighter second line

## [v0.4.1] - 2026-06-22


### CI

- Enhance CI output

### Features

- Disable auto pulling on usage computation (#26)

### Refactoring

- **deps:** Replace better-sqlite3 with node:sqlite

## [v0.4.0] - 2026-06-15


### Bug Fixes

- **config:** Validate config JSON before trusting it

### Features

- **export:** Add itemized PDF usage receipt
- **config:** Add config get/set/list command

### Refactoring

- Project hygiene — shell injection fix, sumDayMap utility, new unit tests
- **heatmap:** Name magic-number constants
- **cli:** Extract buildProgram and DRY error handling

## [v0.3.3] - 2026-06-11


### Bug Fixes

- Add new claude model pricings

## [v0.3.2] - 2026-06-10


### Documentation

- Document top and machines commands in README

### Features

- Render html in daemon mode (#7)
- Show locale-formatted date and time in usage today label (#8)
- Add 'aitrack top' command
- Add 'aitrack machines' command

### Refactoring

- **cli:** Extract shared option helper for usage subcommands
- Modularize src layout

### Tests

- Expand coverage and extract cli helpers

## [v0.3.0] - 2026-06-04


### Features

- **usage:** Add flexible time filters to the usage command

## [v0.2.0] - 2026-06-01


### Refactoring

- **cli:** Consolidate commands into show --tui and usage group

### Tests

- **usage:** Add coverage for usage command and show --tui

## [v0.1.3] - 2026-05-31


### Documentation

- Update project description and enhance usage details

### Features

- **cli:** Add `today` command and quiet benign Cursor warning

## [v0.1.2] - 2026-05-28


### Bug Fixes

- **pricing:** Add Claude Opus 4.8 at $5/$25

### CI

- Fix drift check to detect new models on pricing page

## [v0.1.1] - 2026-05-27


### Bug Fixes

- **init:** Re-clone when repo URL changes
- **recompute:** Store cache breakdown and reprice without inflating costs

### CI

- Update release process

### Features

- **validate:** Skip corrupt machine JSON with warnings
- **config:** Add optional machineId for sync file naming
- **show:** Add longest streak, peak month, and --year filter
- **tui:** Add terminal stats table command
- Enhance README and CLI for local data handling

### Tests

- Cover summary, recompute, dayMap, claude pricing; enable CI coverage
- **validate:** Cover cache breakdown fields and fix lint for recompute

## [v0.1.0] - 2026-05-27


### CI

- Lint, typecheck, test, and daily pricing drift check

### Documentation

- Readme, contributing, and security policy

### Features

- Interactive init wizard to set up the data repo
- Track claude code usage with per-model cost estimates
- Track codex usage with per-model cost estimates
- Track cursor usage locally (never synced to repo)
- Render yearly heatmap PNG with per-provider rows
- Sync, show, summary, and recompute-costs commands
