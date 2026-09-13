//! Cursor CSV export caching.

use crate::env::environment_value;
use crate::paths::cache_dir;
use crate::timezone::machine_timezone;
use crate::version::package_version;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

const CACHE_FORMAT: u32 = 1;
const CACHE_FILE: &str = "cursor.json";

/// Default TTL for Cursor cache: 6 hours (21600 seconds).
pub const DEFAULT_CURSOR_CACHE_TTL_SECONDS: u64 = 21_600;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CursorCacheEntry {
    #[serde(rename = "fetchedAt")]
    pub fetched_at: String,
    pub csv: String,
    #[serde(rename = "workingAuthShape", skip_serializing_if = "Option::is_none")]
    pub working_auth_shape: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct CursorCacheFile {
    format: u32,
    #[serde(rename = "appVersion")]
    app_version: String,
    timezone: String,
    #[serde(rename = "fetchedAt")]
    fetched_at: String,
    csv: String,
    #[serde(rename = "workingAuthShape", skip_serializing_if = "Option::is_none")]
    working_auth_shape: Option<String>,
}

fn cache_path() -> PathBuf {
    cache_dir().join(CACHE_FILE)
}

/// Get the TTL for Cursor cache from AITRACK_CURSOR_CACHE_TTL env var or default.
pub fn cursor_cache_ttl_seconds() -> u64 {
    environment_value("AITRACK_CURSOR_CACHE_TTL")
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(DEFAULT_CURSOR_CACHE_TTL_SECONDS)
}

/// Read the cached Cursor CSV export, or None if absent/invalid.
pub fn read_cursor_cache() -> Option<CursorCacheEntry> {
    if environment_value("AITRACK_NO_CACHE").is_some() {
        return None;
    }

    let contents = fs::read_to_string(cache_path()).ok()?;
    let cache_file: CursorCacheFile = serde_json::from_str(&contents).ok()?;

    // Validate format, version, timezone
    if cache_file.format != CACHE_FORMAT
        || cache_file.app_version != package_version()
        || cache_file.timezone != machine_timezone()
    {
        return None;
    }

    Some(CursorCacheEntry {
        fetched_at: cache_file.fetched_at,
        csv: cache_file.csv,
        working_auth_shape: cache_file.working_auth_shape,
    })
}

/// Age of a cache entry in seconds.
pub fn cursor_cache_age_seconds(entry: &CursorCacheEntry) -> u64 {
    let fetched_at_ms = chrono::DateTime::parse_from_rfc3339(&entry.fetched_at)
        .ok()
        .map(|dt| dt.timestamp_millis())
        .unwrap_or(0);

    let now_ms = chrono::Utc::now().timestamp_millis();
    ((now_ms - fetched_at_ms) / 1000).max(0) as u64
}

/// Persist a freshly fetched CSV export.
pub fn write_cursor_cache(entry: CursorCacheEntry) {
    if environment_value("AITRACK_NO_CACHE").is_some() {
        return;
    }

    let cache_file = CursorCacheFile {
        format: CACHE_FORMAT,
        app_version: package_version().to_string(),
        timezone: machine_timezone(),
        fetched_at: entry.fetched_at,
        csv: entry.csv,
        working_auth_shape: entry.working_auth_shape,
    };

    let payload = match serde_json::to_string(&cache_file) {
        Ok(p) => p,
        Err(_) => return,
    };

    let target = cache_path();
    let temp_path = target.with_extension(format!("{}.tmp", std::process::id()));

    let _ = fs::create_dir_all(cache_dir());
    if fs::write(&temp_path, payload).is_ok() {
        let _ = fs::rename(&temp_path, &target);
    }
    let _ = fs::remove_file(&temp_path);
}
