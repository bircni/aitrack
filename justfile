# The Rust workspace's checks; the 4.x TypeScript tree keeps `bun run validate` until the cut-over.

set windows-shell := ["pwsh", "-NoLogo", "-NoProfile", "-Command"]

# Every check the Rust workflow runs
validate: fmt-check lint test audit

fmt-check:
    cargo fmt --all --check

# The shell still bundles the Node sidecar, so it is checked by the TypeScript pipeline until the fold-in.
lint:
    cargo clippy --workspace --exclude opentrack --all-targets -- -D warnings

test:
    cargo nextest run --workspace --exclude opentrack

audit:
    cargo deny check advisories sources
