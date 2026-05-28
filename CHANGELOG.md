# Changelog

All notable changes to this project will be documented in this file.

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


### Chores

- Initial project scaffolding

- Cli entrypoint and shared types

- Release tooling and changelog config


### Documentation

- Readme, contributing, and security policy


### Features

- Interactive init wizard to set up the data repo

- Track claude code usage with per-model cost estimates

- Track codex usage with per-model cost estimates

- Track cursor usage locally (never synced to repo)

- Render yearly heatmap PNG with per-provider rows

- Sync, show, summary, and recompute-costs commands

