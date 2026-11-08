//! Cursor usage: the IDE's saved login, the dashboard's CSV export, and a per-account cache of it.

pub mod auth_state;
pub mod csv;
pub mod jwt;
pub mod location;

use std::collections::HashSet;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use self::auth_state::read_cursor_auth_state;
use self::jwt::{cursor_account_id, jwt_subject};
use self::location::cursor_state_database_path;
use crate::Core;
use crate::data::types::DayMap;
use crate::fs::write_file_atomic;
use crate::http::Request;
use crate::js::{locale_compare, parse_number};
use crate::quota::{QuotaError, QuotaErrorKind, parse_retry_after};
use crate::time::iso_millis;

const CACHE_FORMAT: u32 = 2;
/// Served without a network call for this long unless `AITRACK_CURSOR_CACHE_TTL` says otherwise.
pub const DEFAULT_CACHE_TTL_SECONDS: f64 = 21_600.0;
/// Per attempt, so a stalled export cannot hang a report.
const FETCH_TIMEOUT: Duration = Duration::from_secs(20);
const SESSION_COOKIE: &str = "WorkosCursorSessionToken";

/// Failed refreshes back off; kept on `Core` for the life of the process.
#[derive(Clone, Debug, Default)]
pub struct CursorState {
    retry: Option<Retry>,
    last_aggregate: Option<(String, String, DayMap)>,
}

#[derive(Clone, Debug)]
struct Retry {
    key: String,
    until_ms: i64,
    server_until_ms: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheEntry {
    pub fetched_at: String,
    pub csv: String,
    pub account_id: String,
    /// The credential shape that produced this CSV, tried first next time.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub working_auth_shape: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CacheFile {
    format: u32,
    app_version: String,
    timezone: String,
    fetched_at: String,
    account_id: String,
    csv: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    working_auth_shape: Option<String>,
}

pub fn cache_ttl_seconds(core: &Core) -> f64 {
    core.env
        .var("AITRACK_CURSOR_CACHE_TTL")
        .and_then(parse_number)
        .filter(|t| t.is_finite() && *t >= 0.0)
        .unwrap_or(DEFAULT_CACHE_TTL_SECONDS)
}

fn read_cache(core: &Core) -> Option<CacheEntry> {
    if core.env.var("AITRACK_NO_CACHE").is_some() {
        return None;
    }
    let file: CacheFile =
        serde_json::from_str(&std::fs::read_to_string(core.paths.cache.join("cursor.json")).ok()?).ok()?;
    // A parser or app change must not keep serving a CSV read under old rules.
    let valid =
        file.format == CACHE_FORMAT && file.app_version == crate::VERSION && file.timezone == core.clock.zone_name();
    valid.then_some(CacheEntry {
        fetched_at: file.fetched_at,
        csv: file.csv,
        account_id: file.account_id,
        working_auth_shape: file.working_auth_shape,
    })
}

fn write_cache(core: &Core, entry: &CacheEntry) {
    if core.env.var("AITRACK_NO_CACHE").is_some() {
        return;
    }
    let file = CacheFile {
        format: CACHE_FORMAT,
        app_version: crate::VERSION.to_owned(),
        timezone: core.clock.zone_name().to_owned(),
        fetched_at: entry.fetched_at.clone(),
        account_id: entry.account_id.clone(),
        csv: entry.csv.clone(),
        working_auth_shape: entry.working_auth_shape.clone(),
    };
    if let Ok(json) = serde_json::to_string(&file) {
        let _ = write_file_atomic(&core.paths.cache.join("cursor.json"), &json, None); // Only ever a speed-up.
    }
}

#[allow(clippy::cast_precision_loss)]
fn cache_age_seconds(core: &Core, entry: &CacheEntry) -> f64 {
    core.clock
        .parse_timestamp(&entry.fetched_at)
        .map_or(f64::INFINITY, |at| (core.clock.now().as_millisecond() - at.as_millisecond()) as f64 / 1000.0)
}

/// `CURSOR_WEB_BASE_URL` must be HTTPS without credentials before a login is sent to it.
fn web_base_url(core: &Core) -> Result<String, String> {
    let configured = core.env.var("CURSOR_WEB_BASE_URL").unwrap_or("https://cursor.com");
    let Some((scheme, rest)) = configured.split_once("://") else {
        return Err("CURSOR_WEB_BASE_URL must be a valid HTTPS URL".to_owned());
    };
    if !scheme.eq_ignore_ascii_case("https") {
        return Err("CURSOR_WEB_BASE_URL must use HTTPS before Cursor credentials are sent".to_owned());
    }
    let authority = &rest[..rest.find(['/', '?', '#']).unwrap_or(rest.len())];
    if authority.contains('@') {
        return Err("CURSOR_WEB_BASE_URL must not contain embedded credentials".to_owned());
    }
    if authority.is_empty() {
        return Err("CURSOR_WEB_BASE_URL must be a valid HTTPS URL".to_owned());
    }
    Ok(format!("https://{}", authority.to_lowercase()))
}

fn encode_uri_component(value: &str) -> String {
    value
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

/// Every credential shape Cursor has accepted over time, the one that last worked first.
fn fetch_attempts(token: &str, prefer: Option<&str>) -> Vec<(String, Vec<(String, String)>)> {
    let mut attempts: Vec<(String, Vec<(String, String)>)> = Vec::new();
    let mut seen = HashSet::new();
    let mut push = |label: String, mut headers: Vec<(String, String)>| {
        headers.sort_by(|a, b| locale_compare(&a.0, &b.0));
        if seen.insert(headers.clone()) {
            attempts.push((label, headers));
        }
    };
    let bearer = ("Authorization".to_owned(), format!("Bearer {token}"));
    let cookie = |value: &str| ("Cookie".to_owned(), format!("{SESSION_COOKIE}={value}"));
    push("bearer".into(), vec![bearer.clone()]);
    let mut cookie_values = vec![token.to_owned()];
    if let Some(subject) = jwt_subject(token) {
        cookie_values.push(format!("{subject}::{token}"));
    }
    for (index, value) in cookie_values.iter().enumerate() {
        let scope = if index == 0 { "token" } else { "subject" };
        push(format!("cookie:{scope}"), vec![cookie(value)]);
        push(format!("cookie-encoded:{scope}"), vec![cookie(&encode_uri_component(value))]);
        push(format!("bearer+cookie:{scope}"), vec![bearer.clone(), cookie(value)]);
        push(format!("bearer+cookie-encoded:{scope}"), vec![bearer.clone(), cookie(&encode_uri_component(value))]);
    }
    if let Some(prefer) = prefer
        && let Some(index) = attempts.iter().position(|(label, _)| label == prefer)
        && index > 0
    {
        let preferred = attempts.remove(index);
        attempts.insert(0, preferred);
    }
    attempts
}

/// Retries authentication failures with the next shape; any other failure stops with a typed error.
pub fn fetch_cursor_usage_csv(core: &Core, token: &str, prefer: Option<&str>) -> Result<(String, String), FetchError> {
    let base = web_base_url(core).map_err(FetchError::Other)?;
    let url = format!("{base}/api/dashboard/export-usage-events-csv?strategy=tokens");
    let mut failures = Vec::new();
    for (label, headers) in fetch_attempts(token, prefer) {
        let mut request = Request::get(&url, FETCH_TIMEOUT).header("Accept", "text/csv,text/plain;q=0.9,*/*;q=0.8");
        request.headers.extend(headers);
        let response = core.http.send(&request).map_err(|e| FetchError::Other(e.to_string()))?;
        if response.is_ok() {
            return Ok((response.text(), label));
        }
        if response.status != 401 && response.status != 403 {
            let kind = if response.status == 429 { QuotaErrorKind::RateLimited } else { QuotaErrorKind::Network };
            return Err(FetchError::Quota(QuotaError {
                retry_after_seconds: parse_retry_after(
                    response.header("retry-after"),
                    core.clock.now().as_millisecond(),
                ),
                ..QuotaError::new(kind, format!("Cursor export returned HTTP {}", response.status))
            }));
        }
        let body: String = response.text().trim().chars().take(200).collect();
        let line = format!("{label}: {}", response.status);
        failures.push(if body.is_empty() { line } else { format!("{line} ({body})") });
    }
    Err(FetchError::Other(format!(
        "Failed to authenticate Cursor usage export with local auth state from {base}. {}",
        failures.join("; ")
    )))
}

#[derive(Debug, thiserror::Error)]
pub enum FetchError {
    #[error("{0}")]
    Quota(QuotaError),
    #[error("{0}")]
    Other(String),
}

/// Cursor usage, served from a fresh-enough cache of the same account, else fetched; a failed refresh
/// falls back to a stale export of that account. Empty when Cursor is not installed or signed in.
/// `max_age_seconds` of `None` or `0` forces a refresh.
pub fn read_cursor_data(core: &Core, max_age_seconds: Option<f64>) -> DayMap {
    let Some(database) = cursor_state_database_path(&core.env) else { return DayMap::new() };
    let state = match read_cursor_auth_state(&database) {
        Ok(state) => state,
        Err(error) => {
            core.output.warn(&format!("aitrack: Cursor skipped — could not read {}: {error}", database.display()));
            return DayMap::new();
        }
    };
    let Some(token) = state.access_token else {
        core.output.warn("aitrack: Cursor skipped — no cursorAuth/accessToken in state.vscdb.");
        return DayMap::new();
    };
    let account = cursor_account_id(&token);
    let cached = read_cache(core).filter(|entry| entry.account_id == account);
    let rates = core.pricing().current();
    let rules = format!("{}\0{}", rates.fingerprint(), core.clock.zone_name());
    let from_cache = |entry: Option<&CacheEntry>| -> DayMap {
        let Some(entry) = entry else { return DayMap::new() };
        let mut cursor = core.cursor.lock().expect("not poisoned");
        if let Some((csv, known_rules, days)) = &cursor.last_aggregate
            && *csv == entry.csv
            && *known_rules == rules
        {
            return days.clone();
        }
        let days = csv::aggregate_cursor_csv(&entry.csv, &core.clock, &rates);
        cursor.last_aggregate = Some((entry.csv.clone(), rules.clone(), days.clone()));
        days
    };
    let retry_key = format!("{}:{account}", database.display());
    let forced = max_age_seconds.is_none_or(|age| age <= 0.0);
    let now_ms = core.clock.now().as_millisecond();
    let retry = core.cursor.lock().expect("not poisoned").retry.clone();
    // A forced refresh skips the local backoff floor but still honours a server Retry-After.
    if let Some(retry) = retry.filter(|r| r.key == retry_key)
        && now_ms < if forced { retry.server_until_ms } else { retry.until_ms }
    {
        core.output.warn(&match &cached {
            Some(entry) => format!(
                "aitrack: Cursor — using cached export from {} (retrying after a failed refresh).",
                entry.fetched_at
            ),
            None => "aitrack: Cursor skipped — retrying after a failed refresh.".to_owned(),
        });
        return from_cache(cached.as_ref());
    }
    if !forced
        && let Some(entry) = &cached
        && cache_age_seconds(core, entry) <= max_age_seconds.unwrap_or(0.0)
    {
        return from_cache(cached.as_ref());
    }
    let (text, shape) =
        match fetch_cursor_usage_csv(core, &token, cached.as_ref().and_then(|c| c.working_auth_shape.as_deref())) {
            Ok(fetched) => {
                core.cursor.lock().expect("not poisoned").retry = None;
                fetched
            }
            Err(error) => {
                let server_seconds = match &error {
                    FetchError::Quota(q) => q.retry_after_seconds.unwrap_or(0),
                    FetchError::Other(_) => 0,
                };
                let server_until_ms = now_ms + i64::try_from(server_seconds).unwrap_or(i64::MAX / 2_000) * 1000;
                core.cursor.lock().expect("not poisoned").retry =
                    Some(Retry { key: retry_key, until_ms: (now_ms + 60_000).max(server_until_ms), server_until_ms });
                core.output.warn(&match &cached {
                    Some(entry) => format!(
                        "aitrack: Cursor — using cached export from {} (refresh failed: {error}).",
                        entry.fetched_at
                    ),
                    None => format!("aitrack: Cursor skipped — {error}"),
                });
                return from_cache(cached.as_ref());
            }
        };
    let days = csv::aggregate_cursor_csv(&text, &core.clock, &rates);
    if days.is_empty() {
        // Not cached: an empty 200 (an interstitial, a renamed column) would hide Cursor for the whole TTL.
        core.output.warn("aitrack: Cursor — no usage rows in CSV export.");
        return from_cache(cached.as_ref());
    }
    write_cache(
        core,
        &CacheEntry {
            fetched_at: iso_millis(core.clock.now()),
            csv: text,
            account_id: account,
            working_auth_shape: Some(shape),
        },
    );
    days
}
