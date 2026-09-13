//! JSONL file reading utilities.

use serde_json::Value;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;

/// Stream JSON objects from a JSONL file, one per line.
///
/// Skips blank lines, truncated lines (half-written), and lines that parse to non-objects.
/// This matches the TypeScript streamJsonlObjects behavior.
pub fn stream_jsonl_objects(
    file_path: &Path,
) -> anyhow::Result<impl Iterator<Item = serde_json::Map<String, Value>>> {
    let file = File::open(file_path)?;
    let reader = BufReader::new(file);

    let objects: Vec<serde_json::Map<String, Value>> = reader
        .lines()
        .map_while(Result::ok)
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| {
            serde_json::from_str::<Value>(&line)
                .ok()
                .and_then(|v| v.as_object().cloned())
        })
        .collect();

    Ok(objects.into_iter())
}
