use crate::Locked;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

/// A thread per this much work: below it, starting one costs more than it saves.
const BYTES_PER_WORKER: u64 = 24 * 1024 * 1024;
/// Pricing and caching stay on the calling thread, so more workers add memory, not speed.
const MAX_WORKERS: usize = 4;

/// Scans `files` with up to four threads, results in input order.
pub fn scan_all<T: Send>(
    files: &[PathBuf],
    missed_bytes: u64,
    scan: impl Fn(&Path) -> io::Result<T> + Sync,
) -> Vec<io::Result<T>> {
    let parallelism = std::thread::available_parallelism().map_or(1, std::num::NonZero::get);
    let by_bytes = usize::try_from(missed_bytes / BYTES_PER_WORKER).unwrap_or(usize::MAX);
    let workers = parallelism.min(MAX_WORKERS).min(files.len()).min(by_bytes);
    if workers < 2 {
        return files.iter().map(|file| scan(file)).collect();
    }
    let next = AtomicUsize::new(0);
    let results: Mutex<Vec<(usize, io::Result<T>)>> = Mutex::new(Vec::with_capacity(files.len()));
    std::thread::scope(|threads| {
        for _ in 0..workers {
            threads.spawn(|| {
                loop {
                    let index = next.fetch_add(1, Ordering::Relaxed);
                    let Some(file) = files.get(index) else { break };
                    let result = scan(file);
                    results.locked().push((index, result));
                }
            });
        }
    });
    // A worker that panics takes the scope down with it, so every index is here.
    let mut results = results.into_inner().unwrap_or_else(std::sync::PoisonError::into_inner);
    results.sort_unstable_by_key(|(index, _)| *index);
    results.into_iter().map(|(_, result)| result).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_input_order_with_or_without_threads() {
        let files: Vec<PathBuf> = (0..40).map(|i| PathBuf::from(i.to_string())).collect();
        let scan = |p: &Path| Ok::<_, io::Error>(p.to_string_lossy().parse::<u32>().unwrap() * 2);
        for bytes in [0, u64::MAX] {
            let got: Vec<u32> = scan_all(&files, bytes, scan).into_iter().map(Result::unwrap).collect();
            assert_eq!(got, (0..40).map(|i| i * 2).collect::<Vec<_>>());
        }
    }
}
