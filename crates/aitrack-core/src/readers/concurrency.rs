//! Concurrency utilities for parallel file processing.

use rayon::prelude::*;

/// Worker count for parallel file work.
/// Parsing is CPU-bound, so this only buys overlap between syscalls and parsing.
pub const DEFAULT_CONCURRENCY: usize = 8;

/// Run worker over items with bounded parallelism, returning results in input order.
pub fn map_with_concurrency<T, R, F>(items: Vec<T>, worker: F) -> Vec<R>
where
    T: Send,
    R: Send,
    F: Fn(T) -> R + Send + Sync,
{
    items.into_par_iter().map(worker).collect()
}

// Legacy compatibility
pub fn parallel_map<T, U, F>(items: Vec<T>, f: F) -> Vec<U>
where
    F: Fn(T) -> U + Send + Sync,
    T: Send,
    U: Send,
{
    map_with_concurrency(items, f)
}
