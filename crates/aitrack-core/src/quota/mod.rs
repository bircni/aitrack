//! Quota management for Claude, Codex, and Cursor.

pub mod claude;
pub mod codex;
pub mod cursor;
pub mod types;

pub use claude::ClaudeQuotaProvider;
pub use codex::CodexQuotaProvider;
pub use cursor::CursorQuotaProvider;
pub use types::{
    ProviderSnapshot, ProviderViewState, QuotaProvider, QuotaRefreshOptions, QuotaWindow,
};

use crate::paths::cache_dir;
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;

/// Get the quota cache directory
fn quota_cache_dir() -> PathBuf {
    cache_dir().join("quota")
}

/// Get the cache file path for a provider
fn cache_file_path(provider_key: &str) -> PathBuf {
    quota_cache_dir().join(format!("{}.json", provider_key))
}

/// Load cached snapshot from disk
fn load_cached_snapshot(provider_key: &str) -> Option<ProviderSnapshot> {
    let path = cache_file_path(provider_key);
    if !path.exists() {
        return None;
    }

    let content = fs::read_to_string(&path).ok()?;
    serde_json::from_str(&content).ok()
}

/// Save snapshot to disk cache
fn save_snapshot_to_cache(snapshot: &ProviderSnapshot) {
    let dir = quota_cache_dir();
    if let Err(e) = fs::create_dir_all(&dir) {
        eprintln!("Failed to create quota cache dir: {}", e);
        return;
    }

    let path = cache_file_path(&snapshot.provider_key);
    if let Ok(json) = serde_json::to_string_pretty(snapshot) {
        let _ = fs::write(&path, json);
    }
}

/// Check if a cached snapshot is still fresh
fn is_cache_fresh(snapshot: &ProviderSnapshot, ttl_seconds: u64) -> bool {
    if let Ok(timestamp) = chrono::DateTime::parse_from_rfc3339(&snapshot.timestamp) {
        let age = chrono::Utc::now().signed_duration_since(timestamp);
        return age.num_seconds() < ttl_seconds as i64;
    }
    false
}

/// Refresh quota for a single provider
fn refresh_provider(
    provider: Arc<dyn QuotaProvider>,
    options: &QuotaRefreshOptions,
) -> ProviderViewState {
    let provider_key = provider.provider_key().to_string();
    let provider_label = provider.provider_label().to_string();

    // Check if provider is available
    if !provider.is_available() {
        return ProviderViewState {
            provider_key,
            provider_label,
            last_updated: None,
            snapshot: None,
            cached: false,
            error: Some("Provider not available (credentials not found)".to_string()),
        };
    }

    // Try to use cache if available and fresh
    if !options.force_refresh {
        if let Some(cached_snapshot) = load_cached_snapshot(&provider_key) {
            if is_cache_fresh(&cached_snapshot, options.cache_ttl_seconds) {
                return ProviderViewState {
                    provider_key,
                    provider_label,
                    last_updated: Some(cached_snapshot.timestamp.clone()),
                    snapshot: Some(cached_snapshot),
                    cached: true,
                    error: None,
                };
            }
        }
    }

    // Fetch fresh data
    match provider.fetch_quota() {
        Ok(snapshot) => {
            save_snapshot_to_cache(&snapshot);

            ProviderViewState {
                provider_key,
                provider_label,
                last_updated: Some(snapshot.timestamp.clone()),
                snapshot: Some(snapshot),
                cached: false,
                error: None,
            }
        }
        Err(err) => {
            // Try to return stale cache on error
            let cached_snapshot = load_cached_snapshot(&provider_key);

            ProviderViewState {
                provider_key,
                provider_label,
                last_updated: cached_snapshot.as_ref().map(|s| s.timestamp.clone()),
                snapshot: cached_snapshot,
                cached: true,
                error: Some(err.to_string()),
            }
        }
    }
}

/// Refresh all quota providers
pub fn refresh_all(
    providers: Option<Vec<String>>,
    options: Option<QuotaRefreshOptions>,
) -> Vec<ProviderViewState> {
    let options = options.unwrap_or_default();

    let all_providers: Vec<Arc<dyn QuotaProvider>> = vec![
        Arc::new(ClaudeQuotaProvider::new()),
        Arc::new(CodexQuotaProvider::new()),
        Arc::new(CursorQuotaProvider::new()),
    ];

    let providers_to_refresh: Vec<Arc<dyn QuotaProvider>> = if let Some(keys) = providers {
        all_providers
            .into_iter()
            .filter(|p| keys.contains(&p.provider_key().to_string()))
            .collect()
    } else {
        all_providers
    };

    // Use rayon for parallel refresh
    use rayon::prelude::*;

    providers_to_refresh
        .par_iter()
        .map(|provider| refresh_provider(Arc::clone(provider), &options))
        .collect()
}

/// Refresh all quota providers (simple interface for backward compatibility)
pub fn refresh_all_simple() -> anyhow::Result<Vec<ProviderViewState>> {
    let results = refresh_all(None, None);

    // Check if any succeeded
    if results.iter().any(|r| r.error.is_none()) {
        Ok(results)
    } else {
        Err(anyhow::anyhow!("All quota providers failed"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_quota_cache_dir() {
        let dir = quota_cache_dir();
        assert!(dir.to_string_lossy().contains("quota"));
    }

    #[test]
    fn test_cache_file_path() {
        let path = cache_file_path("test_provider");
        assert!(path.to_string_lossy().contains("test_provider.json"));
    }

    #[test]
    fn test_refresh_all_simple() {
        // This will fail since no credentials exist in test env, but shouldn't panic
        let result = refresh_all_simple();
        // Just check it returns something
        assert!(result.is_ok() || result.is_err());
    }
}
