//! Pipeline for provider source parsing with caching.

use crate::readers::cache::{CachedParse, open_parse_cache};
use crate::readers::paths::list_unique_source_files;
use std::path::{Path, PathBuf};

pub struct ParseProviderSourcesResult {
    pub files: Vec<PathBuf>,
    pub parsed: Vec<CachedParse>,
}

/// Read every source file for one provider, using the mtime/size cache.
pub fn parse_provider_sources<F>(
    cache_name: &str,
    roots: Vec<PathBuf>,
    parse_file: F,
) -> anyhow::Result<ParseProviderSourcesResult>
where
    F: Fn(&Path) -> anyhow::Result<CachedParse> + Send + Sync,
{
    let files = list_unique_source_files(&roots);
    let mut cache = open_parse_cache(cache_name);

    // Use sequential processing for simplicity (avoids Send trait issues)
    let parsed: Vec<CachedParse> = files
        .iter()
        .map(|path| parse_file(path.as_path()))
        .collect::<Result<Vec<_>, _>>()?;

    // Record all parses in cache
    for (file_path, parse) in files.iter().zip(parsed.iter()) {
        let _ = pollster::block_on(cache.record(file_path, parse.clone()));
    }

    cache.save();

    Ok(ParseProviderSourcesResult { files, parsed })
}
