//! Cursor reader modules.

pub mod auth_state;
pub mod cache;
pub mod csv;
pub mod http;
pub mod jwt;
pub mod location;

pub use auth_state::*;
pub use cache::*;
pub use csv::*;
pub use http::*;
pub use jwt::*;
pub use location::*;

use crate::data::types::DayMap;

/// Read Cursor usage from local IDE auth DB + dashboard CSV export.
///
/// Returns an empty map if the DB is missing, there is no access token, or the
/// request fails with no cache to fall back on.
pub async fn read_cursor_data(max_age_seconds: Option<u64>) -> anyhow::Result<DayMap> {
    let cached = read_cursor_cache();

    // Serve fresh-enough cached CSV without network
    if let Some(ref cache_entry) = cached {
        if let Some(max_age) = max_age_seconds {
            if cursor_cache_age_seconds(cache_entry) <= max_age {
                return Ok(aggregate_cursor_csv_to_day_map(&cache_entry.csv));
            }
        }
    }

    let database_path = match get_cursor_state_database_path() {
        Some(p) => p,
        None => {
            return Ok(cached
                .map(|c| aggregate_cursor_csv_to_day_map(&c.csv))
                .unwrap_or_default());
        }
    };

    let auth_state = match read_cursor_auth_state(&database_path).await {
        Ok(state) => state,
        Err(err) => {
            eprintln!(
                "aitrack: Cursor skipped — could not read {}: {}",
                database_path.display(),
                err
            );
            return Ok(cached
                .map(|c| aggregate_cursor_csv_to_day_map(&c.csv))
                .unwrap_or_default());
        }
    };

    let access_token = match auth_state.access_token {
        Some(token) => token,
        None => {
            eprintln!("aitrack: Cursor skipped — no cursorAuth/accessToken in state.vscdb.");
            return Ok(cached
                .map(|c| aggregate_cursor_csv_to_day_map(&c.csv))
                .unwrap_or_default());
        }
    };

    // Fetch CSV from Cursor dashboard
    let result = fetch_cursor_usage_csv(
        &access_token,
        cached
            .as_ref()
            .and_then(|c| c.working_auth_shape.as_deref()),
    )
    .await;

    let (text, shape) = match result {
        Ok(response) => (response.response, response.shape),
        Err(err) => {
            if let Some(cache_entry) = cached {
                eprintln!(
                    "aitrack: Cursor — using cached export from {} (refresh failed: {}).",
                    cache_entry.fetched_at, err
                );
                return Ok(aggregate_cursor_csv_to_day_map(&cache_entry.csv));
            }
            eprintln!("aitrack: Cursor skipped — {}", err);
            return Ok(DayMap::new());
        }
    };

    let map = aggregate_cursor_csv_to_day_map(&text);

    if map.is_empty() {
        eprintln!("aitrack: Cursor — no usage rows in CSV export.");
        return Ok(cached
            .map(|c| aggregate_cursor_csv_to_day_map(&c.csv))
            .unwrap_or_default());
    }

    write_cursor_cache(CursorCacheEntry {
        fetched_at: chrono::Utc::now().to_rfc3339(),
        csv: text,
        working_auth_shape: Some(shape),
    });

    Ok(map)
}

/// Synchronous wrapper for read_cursor_data.
pub fn read_cursor_data_sync(max_age_seconds: Option<u64>) -> anyhow::Result<DayMap> {
    pollster::block_on(read_cursor_data(max_age_seconds))
}

pub use location::get_cursor_state_database_path;
