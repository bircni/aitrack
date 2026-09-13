//! Per-file parse cache for provider transcripts.

use crate::data::types::DayMap;
use crate::env::environment_value;
use crate::paths::cache_dir;
use crate::timezone::machine_timezone;
use crate::version::package_version;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};

/// Bump when the cached shape changes.
pub const CACHE_FORMAT: u32 = 1;

/// One transcript file's contribution, as cached.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CachedParse {
    pub days: DayMap,
    /// Dedup keys this file holds (for Claude's cross-file deduplication).
    pub keys: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CacheEntry {
    #[serde(rename = "mtimeMs")]
    mtime_ms: i64,
    size: u64,
    days: DayMap,
    keys: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct CacheFile {
    format: u32,
    #[serde(rename = "appVersion")]
    app_version: String,
    timezone: String,
    entries: HashMap<String, CacheEntry>,
}

pub struct ParseCache {
    cache_path: PathBuf,
    previous: HashMap<String, CacheEntry>,
    next: HashMap<String, CacheEntry>,
}

impl ParseCache {
    /// Lookup the cached parse for `file_path`, or None when absent or stale.
    pub async fn lookup(&mut self, file_path: &Path) -> anyhow::Result<Option<CachedParse>> {
        let key = file_path.to_string_lossy().to_string();
        let entry = match self.previous.get(&key) {
            Some(e) => e,
            None => return Ok(None),
        };

        let metadata = match fs::metadata(file_path) {
            Ok(m) => m,
            Err(_) => return Ok(None),
        };

        let mtime_ms = metadata
            .modified()?
            .duration_since(std::time::UNIX_EPOCH)?
            .as_millis() as i64;

        if mtime_ms != entry.mtime_ms || metadata.len() != entry.size {
            return Ok(None);
        }

        self.next.insert(key, entry.clone());
        Ok(Some(CachedParse {
            days: entry.days.clone(),
            keys: entry.keys.clone(),
        }))
    }

    /// Record a freshly parsed file.
    pub async fn record(&mut self, file_path: &Path, parse: CachedParse) -> anyhow::Result<()> {
        let metadata = match fs::metadata(file_path) {
            Ok(m) => m,
            Err(_) => return Ok(()), // File vanished mid-run
        };

        let mtime_ms = metadata
            .modified()?
            .duration_since(std::time::UNIX_EPOCH)?
            .as_millis() as i64;

        let key = file_path.to_string_lossy().to_string();
        self.next.insert(
            key,
            CacheEntry {
                mtime_ms,
                size: metadata.len(),
                days: parse.days,
                keys: parse.keys,
            },
        );
        Ok(())
    }

    /// Persist the cache. Entries never looked up this run are dropped.
    pub fn save(&self) {
        let cache_file = CacheFile {
            format: CACHE_FORMAT,
            app_version: package_version().to_string(),
            timezone: machine_timezone(),
            entries: self.next.clone(),
        };

        let payload = match serde_json::to_string(&cache_file) {
            Ok(p) => p,
            Err(_) => return,
        };

        let temp_path = self
            .cache_path
            .with_extension(format!("{}.tmp", std::process::id()));

        // Write-then-rename for atomicity
        if let Ok(mut file) = File::create(&temp_path) {
            if file.write_all(payload.as_bytes()).is_ok() {
                let _ = fs::rename(&temp_path, &self.cache_path);
            }
        }
        let _ = fs::remove_file(&temp_path);
    }
}

fn read_cache_file(cache_path: &Path) -> HashMap<String, CacheEntry> {
    let contents = match fs::read_to_string(cache_path) {
        Ok(c) => c,
        Err(_) => return HashMap::new(),
    };

    let cache_file: CacheFile = match serde_json::from_str(&contents) {
        Ok(cf) => cf,
        Err(_) => return HashMap::new(),
    };

    // Invalidate if format, version, or timezone changed
    if cache_file.format != CACHE_FORMAT
        || cache_file.app_version != package_version()
        || cache_file.timezone != machine_timezone()
    {
        return HashMap::new();
    }

    cache_file.entries
}

/// A cache that stores nothing, used when AITRACK_NO_CACHE is set.
pub struct DisabledCache;

impl DisabledCache {
    pub async fn lookup(&mut self, _file_path: &Path) -> anyhow::Result<Option<CachedParse>> {
        Ok(None)
    }

    pub async fn record(&mut self, _file_path: &Path, _parse: CachedParse) -> anyhow::Result<()> {
        Ok(())
    }

    pub fn save(&self) {}
}

/// Open the parse cache for a provider (e.g., "claude", "codex").
pub fn open_parse_cache(name: &str) -> ParseCache {
    let cache_path = cache_dir().join(format!("{}.json", name));
    let previous = read_cache_file(&cache_path);

    ParseCache {
        cache_path,
        previous,
        next: HashMap::new(),
    }
}

/// Check if caching is disabled.
pub fn is_cache_disabled() -> bool {
    environment_value("AITRACK_NO_CACHE").is_some()
}
