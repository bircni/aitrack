# Changelog

All notable changes to this project will be documented in this file.

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
