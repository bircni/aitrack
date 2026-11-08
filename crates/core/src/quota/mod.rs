//! Live limits: each provider's usage endpoint, read with the login its own tool saved.

pub mod claude;
pub mod codex;
pub mod cursor;
pub mod pacing;

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::Core;
use crate::http::{HttpClient, Request};
use crate::js::{parse_number, trim};
use crate::time::{Clock, iso_millis};

pub const SESSION_SECONDS: f64 = 5.0 * 60.0 * 60.0;
pub const WEEK_SECONDS: f64 = 7.0 * 24.0 * 60.0 * 60.0;
/// One stalled provider must not hold up a refresh.
const QUOTA_FETCH_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum QuotaFormat {
    Percent,
    Dollars,
    Count,
}

/// One limit that resets on a schedule, such as Claude's five-hour session.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaWindow {
    pub id: String,
    pub label: String,
    pub used_percent: f64,
    /// Absent when the provider does not say.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resets_at: Option<String>,
    /// Window length, for pacing; zero when it has no fixed period.
    pub period_seconds: f64,
    pub format: QuotaFormat,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub used_value: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit_value: Option<f64>,
}

/// A balance without a limit, such as remaining credits.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct QuotaValue {
    pub id: String,
    pub label: String,
    pub value: f64,
    pub format: QuotaFormat,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaSnapshot {
    pub provider: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
    pub windows: Vec<QuotaWindow>,
    pub values: Vec<QuotaValue>,
    pub fetched_at: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum QuotaErrorKind {
    NoCredentials,
    Expired,
    Auth,
    RateLimited,
    Network,
    InvalidResponse,
}

/// Why a provider's limits could not be read.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, thiserror::Error)]
#[serde(rename_all = "camelCase")]
#[error("{message}")]
pub struct QuotaError {
    pub kind: QuotaErrorKind,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_after_seconds: Option<u64>,
}

impl QuotaError {
    pub fn new(kind: QuotaErrorKind, message: impl Into<String>) -> Self {
        Self { kind, message: message.into(), retry_after_seconds: None }
    }
}

pub type QuotaResult = Result<QuotaSnapshot, QuotaError>;

/// Seconds from a `retry-after` header, which may be delta-seconds or an HTTP date.
#[must_use]
pub fn parse_retry_after(value: Option<&str>, now_ms: i64) -> Option<u64> {
    let value = value.filter(|v| !trim(v).is_empty())?;
    #[expect(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "the seconds are rounded up and clamped to zero or above first"
    )]
    let seconds = |s: f64| s.max(0.0).ceil() as u64;
    if let Some(n) = parse_number(value).filter(|n| n.is_finite()) {
        return Some(seconds(n));
    }
    // V8 ignores the weekday of an HTTP date, so a wrong one must not reject it.
    let without_weekday = value.split_once(", ").filter(|(day, _)| day.len() == 3).map_or(value, |(_, rest)| rest);
    let date = jiff::fmt::rfc2822::parse(without_weekday)
        .map(|z| z.timestamp())
        .ok()
        .or_else(|| Clock::system().parse_timestamp(value))?;
    #[expect(
        clippy::cast_precision_loss,
        reason = "counts and millisecond times stay far below 2^53, like the JavaScript numbers 4.x used"
    )]
    Some(seconds((date.as_millisecond() - now_ms) as f64 / 1000.0))
}

/// A GET or POST resolving to a JSON object, or a typed failure. 401/403 mean the saved token is no longer
/// accepted; aitrack does not refresh tokens, so the fix is to reopen the provider's own tool.
///
/// # Errors
///
/// When the request fails, the login is rejected or the body is not a JSON object.
pub fn request_json(
    http: &dyn HttpClient,
    label: &str,
    request: Request,
    now_ms: i64,
) -> Result<Map<String, Value>, QuotaError> {
    let request = Request { timeout: QUOTA_FETCH_TIMEOUT, ..request };
    let response = http
        .send(&request)
        .map_err(|e| QuotaError::new(QuotaErrorKind::Network, format!("{label} request failed: {e}")))?;
    if !response.is_ok() {
        return Err(match response.status {
            401 | 403 => QuotaError::new(
                QuotaErrorKind::Auth,
                format!("{label} rejected the saved login (HTTP {})", response.status),
            ),
            429 => QuotaError {
                retry_after_seconds: parse_retry_after(response.header("retry-after"), now_ms),
                ..QuotaError::new(QuotaErrorKind::RateLimited, format!("{label} is rate limiting quota requests"))
            },
            status => QuotaError::new(QuotaErrorKind::Network, format!("{label} returned HTTP {status}")),
        });
    }
    let body: Value = serde_json::from_slice(&response.body).map_err(|_| {
        QuotaError::new(QuotaErrorKind::InvalidResponse, format!("{label} returned a non-JSON response"))
    })?;
    match body {
        Value::Object(map) => Ok(map),
        _ => Err(QuotaError::new(QuotaErrorKind::InvalidResponse, format!("{label} returned an unexpected response"))),
    }
}

/// # Errors
///
/// When the expiry has passed.
pub fn assert_not_expired(expires_at_ms: Option<f64>, now_ms: i64, message: &str) -> Result<(), QuotaError> {
    #[expect(
        clippy::cast_precision_loss,
        reason = "counts and millisecond times stay far below 2^53, like the JavaScript numbers 4.x used"
    )]
    match expires_at_ms {
        Some(at) if at <= now_ms as f64 => Err(QuotaError::new(QuotaErrorKind::Expired, message)),
        _ => Ok(()),
    }
}

pub fn record(value: Option<&Value>) -> Option<&Map<String, Value>> {
    value.and_then(Value::as_object)
}

/// A finite number, accepting numeric strings as providers sometimes send them.
#[must_use]
pub fn number_value(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::String(text) if !trim(text).is_empty() => parse_number(text),
        Value::Number(n) => n.as_f64(),
        _ => None,
    }
    .filter(|n| n.is_finite())
}

/// A trimmed string, `None` when blank or not a string.
pub fn string_value(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).map(trim).filter(|s| !s.is_empty()).map(str::to_owned)
}

/// An ISO instant from an ISO string (a missing zone means UTC) or epoch seconds or milliseconds.
pub fn instant_value(value: Option<&Value>) -> Option<String> {
    if let Some(text) = string_value(value)
        && parse_number(&text).is_none()
    {
        let zoned = if has_zone(&text) { text } else { format!("{text}Z") };
        return Clock::system().parse_timestamp(&zoned).map(iso_millis);
    }
    let raw = number_value(value)?;
    let ms = if raw.abs() < 10_000_000_000.0 { raw * 1000.0 } else { raw };
    #[expect(clippy::cast_possible_truncation, reason = "the value is rounded and bounded to the target range first")]
    jiff::Timestamp::from_millisecond(ms.trunc() as i64).ok().map(iso_millis)
}

/// `/(?:Z|[+-]\d{2}:?\d{2})$/i`
fn has_zone(text: &str) -> bool {
    if text.ends_with(['Z', 'z']) {
        return true;
    }
    let b = text.as_bytes();
    let digits = |s: &[u8]| s.iter().all(u8::is_ascii_digit);
    let tail = |n: usize| b.len() >= n && matches!(b[b.len() - n], b'+' | b'-');
    (tail(6) && digits(&b[b.len() - 5..b.len() - 3]) && b[b.len() - 3] == b':' && digits(&b[b.len() - 2..]))
        || (tail(5) && digits(&b[b.len() - 4..]))
}

/// `"prolite_plan"` as `"Prolite Plan"`: words split on whitespace and underscores, first letters capitalised.
#[must_use]
pub fn title_case(value: &str) -> String {
    value
        .split(|c: char| crate::js::is_space(c) || c == '_')
        .filter(|w| !w.is_empty())
        .map(|w| {
            let mut chars = w.chars();
            chars.next().map(|f| f.to_uppercase().chain(chars).collect::<String>()).unwrap_or_default()
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[must_use]
pub const fn clamp_percent(value: f64) -> f64 {
    value.clamp(0.0, 100.0)
}

/// Never fails as a whole, so one signed-out provider does not take the others down.
///
/// # Errors
///
/// When the provider has no quota or its fetch fails.
pub fn fetch_quota(core: &Core, provider: &str) -> QuotaResult {
    let now = core.clock.now();
    match provider {
        "claude_code" => claude::fetch_claude_quota(core, now),
        "codex" => codex::fetch_codex_quota(core, now),
        "cursor" => cursor::fetch_cursor_quota(core, now),
        other => Err(QuotaError::new(QuotaErrorKind::InvalidResponse, format!("no quota for {other}"))),
    }
}
