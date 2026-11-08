use std::time::Duration;

use jiff::Timestamp;
use serde_json::{Map, Value};

use super::{
    QuotaError, QuotaErrorKind, QuotaFormat, QuotaResult, QuotaSnapshot, QuotaValue, QuotaWindow, SESSION_SECONDS,
    WEEK_SECONDS, assert_not_expired, clamp_percent, instant_value, number_value, record, request_json, string_value,
    title_case,
};
use crate::Core;
use crate::http::Request;
use crate::readers::paths::claude_home_dirs;
use crate::time::iso_millis;

const CLAUDE_USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const KEYCHAIN_SERVICE: &str = "Claude Code-credentials";
/// An access prompt nobody answers would otherwise hang the fetch.
const KEYCHAIN_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ClaudeCredentials {
    pub access_token: String,
    pub expires_at: Option<f64>,
    pub scopes: Option<Vec<String>>,
    pub subscription_type: Option<String>,
    pub rate_limit_tier: Option<String>,
}

pub fn parse_claude_credentials(text: &str) -> Option<ClaudeCredentials> {
    let document: Value = serde_json::from_str(text).ok()?;
    let oauth = record(record(Some(&document))?.get("claudeAiOauth"))?;
    Some(ClaudeCredentials {
        access_token: string_value(oauth.get("accessToken"))?,
        expires_at: number_value(oauth.get("expiresAt")),
        scopes: oauth
            .get("scopes")
            .and_then(Value::as_array)
            .map(|scopes| scopes.iter().filter_map(Value::as_str).map(str::to_owned).collect()),
        subscription_type: string_value(oauth.get("subscriptionType")),
        rate_limit_tier: string_value(oauth.get("rateLimitTier")),
    })
}

/// The file Claude Code writes, then on macOS the Keychain item it prefers there.
fn read_claude_credentials(core: &Core) -> Option<ClaudeCredentials> {
    for dir in claude_home_dirs(&core.env, true) {
        if let Some(credentials) =
            std::fs::read_to_string(dir.join(".credentials.json")).ok().as_deref().and_then(parse_claude_credentials)
        {
            return Some(credentials);
        }
    }
    // The Keychain item is the default account's, not the one CLAUDE_CONFIG_DIR points at.
    if !cfg!(target_os = "macos") || core.env.var("CLAUDE_CONFIG_DIR").is_some() {
        return None;
    }
    let args = ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"];
    let output = crate::process::run("security", &args, &[], None, Some(KEYCHAIN_TIMEOUT)).ok()?;
    output.status.success().then(|| parse_claude_credentials(&String::from_utf8_lossy(&output.stdout))).flatten()
}

/// `pro` with `default_claude_max_5x` is "Pro 5x"; Max 5x now sells as Max and Max 20x as Ultra.
#[must_use]
pub fn format_claude_plan(subscription: Option<&str>, tier: Option<&str>) -> Option<String> {
    let lower = subscription?.to_lowercase();
    let multiplier = tier.and_then(|tier| {
        tier.split(|c: char| !c.is_ascii_alphanumeric()).find(|part| {
            part.len() >= 2 && part[..part.len() - 1].bytes().all(|b| b.is_ascii_digit()) && part.ends_with(['x', 'X'])
        })
    });
    if lower == "max" {
        return Some(
            if multiplier.is_some_and(|m| m.eq_ignore_ascii_case("20x")) { "Ultra" } else { "Max" }.to_owned(),
        );
    }
    let plan = title_case(&lower);
    Some(match multiplier {
        Some(m) => format!("{plan} {m}"),
        None => plan,
    })
}

fn percent_window(
    id: &str,
    label: &str,
    percent: Option<&Value>,
    resets_at: Option<&Value>,
    period: f64,
) -> Option<QuotaWindow> {
    Some(QuotaWindow {
        id: id.to_owned(),
        label: label.to_owned(),
        used_percent: number_value(percent)?,
        resets_at: instant_value(resets_at),
        period_seconds: period,
        format: QuotaFormat::Percent,
        used_value: None,
        limit_value: None,
    })
}

pub fn map_claude_usage(
    body: &Map<String, Value>,
    subscription: Option<&str>,
    tier: Option<&str>,
    now: Timestamp,
) -> QuotaSnapshot {
    let mut windows: Vec<QuotaWindow> = Vec::new();
    let mut values = Vec::new();
    // First source wins: a scoped "Sonnet" limit repeats seven_day_sonnet.
    let push = |windows: &mut Vec<QuotaWindow>, window: Option<QuotaWindow>| {
        if let Some(window) = window
            && !windows.iter().any(|w| w.id == window.id)
        {
            windows.push(window);
        }
    };
    for (key, id, label, period) in [
        ("five_hour", "session", "Session", SESSION_SECONDS),
        ("seven_day", "weekly", "Weekly", WEEK_SECONDS),
        ("seven_day_sonnet", "model:sonnet", "Sonnet", WEEK_SECONDS),
    ] {
        if let Some(window) = record(body.get(key)) {
            push(&mut windows, percent_window(id, label, window.get("utilization"), window.get("resets_at"), period));
        }
    }
    for limit in body.get("limits").and_then(Value::as_array).into_iter().flatten().filter_map(|e| e.as_object()) {
        if limit.get("kind").and_then(Value::as_str) != Some("weekly_scoped") {
            continue;
        }
        let Some(model) = string_value(
            record(record(limit.get("scope")).and_then(|s| s.get("model"))).and_then(|m| m.get("display_name")),
        ) else {
            continue;
        };
        let id = format!("model:{}", model.to_lowercase());
        push(&mut windows, percent_window(&id, &model, limit.get("percent"), limit.get("resets_at"), WEEK_SECONDS));
    }
    let extra = record(body.get("extra_usage"));
    if let Some(extra) = extra
        && extra.get("is_enabled").and_then(Value::as_bool) == Some(true)
        && let Some(cents) = number_value(extra.get("used_credits"))
    {
        let used = cents / 100.0;
        let limit = number_value(extra.get("monthly_limit")).unwrap_or(0.0) / 100.0;
        if limit > 0.0 {
            windows.push(QuotaWindow {
                id: "extra".into(),
                label: "Extra usage".into(),
                used_percent: clamp_percent((used / limit) * 100.0),
                resets_at: None,
                period_seconds: 0.0,
                format: QuotaFormat::Dollars,
                used_value: Some(used),
                limit_value: Some(limit),
            });
        } else if used > 0.0 {
            values.push(QuotaValue {
                id: "extra".into(),
                label: "Extra usage".into(),
                value: used,
                format: QuotaFormat::Dollars,
            });
        }
    }
    QuotaSnapshot {
        provider: "claude_code".into(),
        plan: format_claude_plan(subscription, tier),
        windows,
        values,
        fetched_at: iso_millis(now),
    }
}

pub fn fetch_claude_quota(core: &Core, now: Timestamp) -> QuotaResult {
    let credentials = read_claude_credentials(core).ok_or_else(|| {
        QuotaError::new(QuotaErrorKind::NoCredentials, "No Claude Code login found. Run `claude` and sign in.")
    })?;
    if credentials.scopes.as_ref().is_some_and(|scopes| !scopes.iter().any(|s| s == "user:profile")) {
        return Err(QuotaError::new(
            QuotaErrorKind::NoCredentials,
            "This Claude Code login cannot read usage limits (missing user:profile scope).",
        ));
    }
    let now_ms = now.as_millisecond();
    assert_not_expired(credentials.expires_at, now_ms, "Claude Code login expired. Open Claude Code to refresh it.")?;
    let request = Request::get(CLAUDE_USAGE_URL, Duration::ZERO)
        .header("Accept", "application/json")
        .header("Authorization", &format!("Bearer {}", credentials.access_token))
        .header("anthropic-beta", "oauth-2025-04-20");
    let body = request_json(core.http.as_ref(), "Claude", request, now_ms)?;
    Ok(map_claude_usage(&body, credentials.subscription_type.as_deref(), credentials.rate_limit_tier.as_deref(), now))
}
