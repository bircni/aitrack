set windows-shell := ["pwsh", "-NoLogo", "-NoProfile", "-Command"]

# Every check CI runs
validate: rust audit

# Rust: format, clippy and tests
rust: fmt-check lint test

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

# opentrack in debug, on a fresh renderer build
desktop-dev:
    bun run --cwd apps/opentrack-ui build
    cd apps/opentrack && bunx tauri dev

# Rebuild the pricing pack from LiteLLM and models.dev; --write also updates the tables
pricing-pack *args:
    cargo xtask pricing-pack {{args}}

# Compare the tables with LiteLLM and models.dev
pricing-check:
    cargo xtask pricing-check
