use std::time::Duration;

use jiff::{Timestamp, ToSpan, tz::TimeZone};
use serde_json::{Map, Value};

use super::{
    QuotaError, QuotaErrorKind, QuotaFormat, QuotaResult, QuotaSnapshot, QuotaWindow, clamp_percent, number_value,
    record, request_json, string_value, title_case,
};
use crate::Core;
use crate::http::Request;
use crate::time::iso_millis;

/// Undocumented, but what Copilot's own clients read their quotas from.
const COPILOT_USER_URL: &str = "https://api.github.com/copilot_internal/user";
const GH_TIMEOUT: Duration = Duration::from_secs(5);
const MONTH_SECONDS: f64 = 30.0 * 24.0 * 60.0 * 60.0;
const SNAPSHOTS: [(&str, &str); 3] =
    [("premium_interactions", "Premium requests"), ("chat", "Chat"), ("completions", "Completions")];

/// The Copilot CLI's own order, minus its keychain item: environment, then the GitHub CLI's login.
fn read_copilot_token(core: &Core) -> Option<String> {
    ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"]
        .iter()
        .find_map(|name| core.env.var(name).map(crate::js::trim).filter(|t| !t.is_empty()).map(str::to_owned))
        .or_else(|| {
            let output = crate::process::run("gh", &["auth", "token"], &[], None, Some(GH_TIMEOUT)).ok()?;
            let token = String::from_utf8_lossy(&output.stdout);
            output.status.success().then(|| crate::js::trim(&token).to_owned()).filter(|t| !t.is_empty())
        })
}

/// The calendar month that ends at the reset, for pacing.
#[expect(clippy::cast_precision_loss, reason = "a month of seconds is far below 2^53")]
fn period_seconds(resets_at: Option<&str>) -> f64 {
    let Some(reset) = resets_at.and_then(|r| r.parse::<Timestamp>().ok()) else { return MONTH_SECONDS };
    reset
        .to_zoned(TimeZone::UTC)
        .checked_sub(1.month())
        .map_or(MONTH_SECONDS, |start| (reset.as_second() - start.timestamp().as_second()) as f64)
}

pub fn map_copilot_usage(body: &Map<String, Value>, now: Timestamp) -> QuotaSnapshot {
    let resets_at =
        string_value(body.get("quota_reset_date_utc")).and_then(|r| r.parse::<Timestamp>().ok()).map(iso_millis);
    let period = period_seconds(resets_at.as_deref());
    let snapshots = record(body.get("quota_snapshots"));
    let windows = SNAPSHOTS
        .iter()
        .filter_map(|(id, label)| {
            let snapshot = record(snapshots?.get(*id))?;
            if snapshot.get("unlimited").and_then(Value::as_bool) == Some(true) {
                return None;
            }
            let limit = number_value(snapshot.get("entitlement")).filter(|l| *l > 0.0)?;
            let remaining = number_value(snapshot.get("quota_remaining"))
                .or_else(|| number_value(snapshot.get("remaining")))
                .unwrap_or(limit);
            let used = (limit - remaining).max(0.0);
            Some(QuotaWindow {
                id: (*id).to_owned(),
                label: (*label).to_owned(),
                used_percent: clamp_percent(used / limit * 100.0),
                resets_at: resets_at.clone(),
                period_seconds: period,
                format: QuotaFormat::Count,
                used_value: Some(used),
                limit_value: Some(limit),
            })
        })
        .collect();
    QuotaSnapshot {
        provider: "copilot".into(),
        plan: string_value(body.get("copilot_plan")).map(|p| title_case(&p)),
        windows,
        values: Vec::new(),
        fetched_at: iso_millis(now),
    }
}

/// # Errors
///
/// When there is no GitHub login or the request fails.
pub fn fetch_copilot_quota(core: &Core, now: Timestamp) -> QuotaResult {
    let token = read_copilot_token(core).ok_or_else(|| {
        QuotaError::new(QuotaErrorKind::NoCredentials, "No GitHub login found. Run `gh auth login` or set GH_TOKEN.")
    })?;
    let request = Request::get(COPILOT_USER_URL, Duration::ZERO)
        .header("Accept", "application/json")
        .header("Authorization", &format!("token {token}"))
        .header("User-Agent", "aitrack")
        .header("X-GitHub-Api-Version", "2025-04-01");
    let body = request_json(core.http.as_ref(), "GitHub Copilot", request, now.as_millisecond())?;
    Ok(map_copilot_usage(&body, now))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn maps_limited_snapshots_as_counts_over_the_month() {
        let body = json!({
            "copilot_plan": "individual",
            "quota_reset_date_utc": "2026-12-01T00:00:00.000Z",
            "quota_snapshots": {
                "chat": { "unlimited": true, "entitlement": 0, "remaining": 0 },
                "premium_interactions": { "unlimited": false, "entitlement": 1500, "quota_remaining": 1408.8, "remaining": 1408 }
            }
        });
        let now = "2026-11-12T12:00:00Z".parse().unwrap();
        let snapshot = map_copilot_usage(body.as_object().unwrap(), now);
        assert_eq!(snapshot.plan.as_deref(), Some("Individual"));
        let [window] = snapshot.windows.as_slice() else { panic!("{:?}", snapshot.windows) };
        assert_eq!((window.id.as_str(), window.format), ("premium_interactions", QuotaFormat::Count));
        assert_eq!(window.resets_at.as_deref(), Some("2026-12-01T00:00:00.000Z"));
        assert!((window.period_seconds - 30.0 * 24.0 * 3600.0).abs() < 1e-9);
        assert!((window.used_value.unwrap() - 91.2).abs() < 1e-9 && window.limit_value == Some(1500.0));
        assert!((window.used_percent - 6.08).abs() < 1e-9);
    }
}
