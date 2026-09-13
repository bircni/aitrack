//! Package version used as a cache key.

pub fn package_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}
