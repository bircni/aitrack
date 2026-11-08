use std::time::Duration;

use jiff::Timestamp;
use serde_json::{Map, Value};

use super::{
    QuotaError, QuotaErrorKind, QuotaFormat, QuotaResult, QuotaSnapshot, QuotaValue, QuotaWindow, assert_not_expired,
    instant_value, number_value, record, request_json, string_value, title_case,
};
use crate::Core;
use crate::http::Request;
use crate::readers::cursor::auth_state::read_cursor_auth_state;
use crate::readers::cursor::jwt::jwt_expiry_ms;
use crate::readers::cursor::location::cursor_state_database_path;
use crate::time::iso_millis;

const DASHBOARD_URL: &str = "https://api2.cursor.sh/aiserver.v1.DashboardService";
const BILLING_PERIOD_SECONDS: f64 = 30.0 * 24.0 * 60.0 * 60.0;

fn billing_cycle(usage: &Map<String, Value>) -> (Option<String>, f64) {
    let start = number_value(usage.get("billingCycleStart"));
    let end = number_value(usage.get("billingCycleEnd"));
    let period = match (start, end) {
        (Some(s), Some(e)) if e > s => crate::quota::pacing::js_round((e - s) / 1000.0),
        _ => BILLING_PERIOD_SECONDS,
    };
    (instant_value(usage.get("billingCycleEnd")), period)
}

/// A reported positive spend wins; otherwise it is inferred from limit minus remaining.
fn on_demand_spent_cents(spend: &Map<String, Value>, limit: f64, remaining: f64) -> f64 {
    let reported: Vec<f64> =
        ["individualUsed", "pooledUsed", "totalSpend"].iter().filter_map(|k| number_value(spend.get(*k))).collect();
    if let Some(positive) = reported.iter().find(|v| **v > 0.0) {
        return *positive;
    }
    let inferred = (limit - remaining).max(0.0);
    if inferred > 0.0 { inferred } else { reported.first().copied().unwrap_or(0.0) }
}

/// `GetCurrentPeriodUsage` with `GetPlanInfo`'s plan name; amounts arrive in cents.
pub fn map_cursor_usage(usage: &Map<String, Value>, plan_name: Option<&str>, now: Timestamp) -> QuotaResult {
    let plan_usage = record(usage.get("planUsage"));
    let Some(plan_usage) = plan_usage.filter(|_| usage.get("enabled").and_then(Value::as_bool) != Some(false)) else {
        return Err(QuotaError::new(QuotaErrorKind::InvalidResponse, "Cursor reports no active usage-based plan."));
    };
    let spend = record(usage.get("spendLimitUsage"));
    let limit_cents = number_value(plan_usage.get("limit"));
    let total_percent = number_value(plan_usage.get("totalPercentUsed"));
    if limit_cents.is_none() && total_percent.is_none() {
        return Err(QuotaError::new(QuotaErrorKind::InvalidResponse, "Cursor did not report a usage limit."));
    }
    let used_cents = number_value(plan_usage.get("totalSpend"))
        .unwrap_or_else(|| limit_cents.unwrap_or(0.0) - number_value(plan_usage.get("remaining")).unwrap_or(0.0))
        .max(0.0);
    let (resets_at, period_seconds) = billing_cycle(usage);
    let team = plan_name.is_some_and(|p| p.eq_ignore_ascii_case("team"))
        || string_value(spend.and_then(|s| s.get("limitType"))).is_some_and(|t| t.eq_ignore_ascii_case("team"))
        || number_value(spend.and_then(|s| s.get("pooledLimit"))).unwrap_or(0.0) > 0.0;
    let window = |id: &str, label: &str, used_percent: f64, format, used_value, limit_value| QuotaWindow {
        id: id.to_owned(),
        label: label.to_owned(),
        used_percent,
        resets_at: resets_at.clone(),
        period_seconds,
        format,
        used_value,
        limit_value,
    };
    let mut windows = Vec::new();
    match limit_cents {
        Some(limit) if team && limit > 0.0 => windows.push(window(
            "usage",
            "Total usage",
            (used_cents / limit) * 100.0,
            QuotaFormat::Dollars,
            Some(used_cents / 100.0),
            Some(limit / 100.0),
        )),
        _ => {
            let computed = limit_cents.filter(|l| *l != 0.0).map_or(0.0, |l| (used_cents / l) * 100.0);
            windows.push(window(
                "usage",
                "Total usage",
                total_percent.unwrap_or(computed),
                QuotaFormat::Percent,
                None,
                None,
            ));
        }
    }
    for (key, id, label) in [("autoPercentUsed", "auto", "Auto usage"), ("apiPercentUsed", "api", "API usage")] {
        if let Some(used) = number_value(plan_usage.get(key)) {
            windows.push(window(id, label, used, QuotaFormat::Percent, None, None));
        }
    }
    let mut values = Vec::new();
    if let Some(spend) = spend {
        let pick = |a: &str, b: &str| number_value(spend.get(a)).or_else(|| number_value(spend.get(b))).unwrap_or(0.0);
        let limit = pick("individualLimit", "pooledLimit");
        let remaining = pick("individualRemaining", "pooledRemaining");
        let on_demand = on_demand_spent_cents(spend, limit, remaining);
        if limit > 0.0 {
            windows.push(window(
                "onDemand",
                "On-demand",
                (on_demand / limit) * 100.0,
                QuotaFormat::Dollars,
                Some(on_demand / 100.0),
                Some(limit / 100.0),
            ));
        } else if on_demand > 0.0 {
            values.push(QuotaValue {
                id: "onDemand".into(),
                label: "On-demand".into(),
                value: on_demand / 100.0,
                format: QuotaFormat::Dollars,
            });
        }
    }
    Ok(QuotaSnapshot {
        provider: "cursor".into(),
        plan: plan_name.map(title_case),
        windows,
        values,
        fetched_at: iso_millis(now),
    })
}

fn connect_post(core: &Core, method: &str, token: &str, now_ms: i64) -> Result<Map<String, Value>, QuotaError> {
    let mut request = Request::get(format!("{DASHBOARD_URL}/{method}"), Duration::ZERO)
        .header("Authorization", &format!("Bearer {token}"))
        .header("Content-Type", "application/json")
        .header("Connect-Protocol-Version", "1");
    request.method = "POST";
    request.body = Some(b"{}".to_vec());
    request_json(core.http.as_ref(), "Cursor", request, now_ms)
}

pub fn fetch_cursor_quota(core: &Core, now: Timestamp) -> QuotaResult {
    let token = cursor_state_database_path(&core.env)
        .and_then(|db| read_cursor_auth_state(&db).ok())
        .and_then(|state| state.access_token);
    let Some(token) = token else {
        return Err(QuotaError::new(QuotaErrorKind::NoCredentials, "No Cursor login found. Sign in to Cursor."));
    };
    let now_ms = now.as_millisecond();
    assert_not_expired(jwt_expiry_ms(&token), now_ms, "Cursor login expired. Open Cursor to refresh it.")?;
    let usage = connect_post(core, "GetCurrentPeriodUsage", &token, now_ms)?;
    let plan = connect_post(core, "GetPlanInfo", &token, now_ms).ok();
    let plan_name = plan.as_ref().and_then(|p| string_value(record(p.get("planInfo")).and_then(|i| i.get("planName"))));
    map_cursor_usage(&usage, plan_name.as_deref(), now)
}
