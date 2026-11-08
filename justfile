# The Rust workspace's checks; the 4.x TypeScript tree keeps `bun run validate` until the cut-over.

set windows-shell := ["pwsh", "-NoLogo", "-NoProfile", "-Command"]

# Every check the Rust workflow runs
validate: fmt-check lint test audit

fmt-check:
    cargo fmt --all --check

lint: renderer
    cargo clippy --workspace --all-targets -- -D warnings

test: renderer
    cargo nextest run --workspace

# opentrack embeds the built renderer; the checks only need the page to exist, so a placeholder stands in.
[unix]
renderer:
    mkdir -p apps/opentrack-ui/dist/renderer
    test -f apps/opentrack-ui/dist/renderer/index.html || echo '<!doctype html><title>opentrack</title>' > apps/opentrack-ui/dist/renderer/index.html

[windows]
renderer:
    New-Item -ItemType Directory -Force apps/opentrack-ui/dist/renderer | Out-Null
    if (-not (Test-Path apps/opentrack-ui/dist/renderer/index.html)) { Set-Content apps/opentrack-ui/dist/renderer/index.html '<!doctype html><title>opentrack</title>' }

audit:
    cargo deny check advisories sources

# 4.x and 5.0 on the same fixture home, in four time zones; until the cut-over removes 4.x
parity:
    bun nx run aitrack:build
    cargo build -p aitrack-cli
    node scripts/diff-cli.ts
