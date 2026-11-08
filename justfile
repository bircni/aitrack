set windows-shell := ["pwsh", "-NoLogo", "-NoProfile", "-Command"]

# Every check CI runs
validate: rust audit

# Rust: format, clippy and tests
rust: fmt-check lint test

fmt-check:
    cargo fmt --all --check

lint:
    cargo clippy --workspace --all-targets -- -D warnings

test:
    cargo nextest run --workspace

audit:
    cargo deny check advisories sources

# opentrack in debug; a separate data dir keeps it apart from an installed copy
desktop-dev:
    cargo run -p opentrack -- --data-dir target/opentrack-dev

# The installers for this OS under target/release/bundle, laid out and signed as releases ship them
package formats:
    cd apps/opentrack && cargo packager --release --formats {{formats}}
    cargo xtask updater-artifacts target/release/packager target/release/bundle

# Rebuild the pricing pack from LiteLLM and models.dev; --write also updates the tables
pricing-pack *args:
    cargo xtask pricing-pack {{args}}

# Compare the tables with LiteLLM and models.dev
pricing-check:
    cargo xtask pricing-check
