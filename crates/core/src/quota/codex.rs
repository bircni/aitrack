use std::time::Duration;

use jiff::Timestamp;
use serde_json::{Map, Value};

use super::{
    QuotaError, QuotaErrorKind, QuotaFormat, QuotaResult, QuotaSnapshot, QuotaValue, QuotaWindow, SESSION_SECONDS,
    WEEK_SECONDS, assert_not_expired, instant_value, number_value, record, request_json, string_value, title_case,
};
use crate::Core;
use crate::http::Request;
use crate::readers::cursor::jwt::{decode_jwt_payload, jwt_expiry_ms};
use crate::readers::paths::codex_home_dirs;
use crate::time::iso_millis;

const CODEX_USAGE_URL: &str = "https://chatgpt.com/backend-api/wham/usage";
const ACCOUNT_CLAIM: &str = "https://api.openai.com/auth";

#[derive(Clone, Debug, PartialEq)]
pub struct CodexCredentials {
    pub access_token: String,
    pub account_id: Option<String>,
    pub expires_at: Option<f64>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum CodexAuth {
    Login(CodexCredentials),
    /// An API key but no `ChatGPT` login.
    ApiKeyOnly,
}

fn account_id_from_jwt(token: Option<&str>) -> Option<String> {
    let payload = decode_jwt_payload(token?)?;
    string_value(record(payload.get(ACCOUNT_CLAIM)).and_then(|c| c.get("chatgpt_account_id")))
        .or_else(|| string_value(payload.get("chatgpt_account_id")))
}

#[must_use]
pub fn parse_codex_auth(text: &str) -> Option<CodexAuth> {
    let document: Value = serde_json::from_str(text).ok()?;
    let root = record(Some(&document));
    let tokens = root.and_then(|r| record(r.get("tokens")));
    let Some(access_token) = string_value(tokens.and_then(|t| t.get("access_token"))) else {
        return string_value(root.and_then(|r| r.get("OPENAI_API_KEY"))).map(|_| CodexAuth::ApiKeyOnly);
    };
    let account_id = string_value(tokens.and_then(|t| t.get("account_id")))
        .or_else(|| account_id_from_jwt(string_value(tokens.and_then(|t| t.get("id_token"))).as_deref()));
    let expires_at = jwt_expiry_ms(&access_token);
    Some(CodexAuth::Login(CodexCredentials { access_token, account_id, expires_at }))
}

fn read_codex_credentials(core: &Core) -> Option<CodexAuth> {
    let mut api_key_only = false;
    for dir in codex_home_dirs(&core.env, true) {
        match std::fs::read_to_string(dir.join("auth.json")).ok().as_deref().and_then(parse_codex_auth) {
            Some(CodexAuth::ApiKeyOnly) => api_key_only = true,
            Some(login) => return Some(login),
            None => {}
        }
    }
    api_key_only.then_some(CodexAuth::ApiKeyOnly)
}

/// "prolite" and "pro" are `ChatGPT`'s names for the 5x and 20x Pro tiers.
#[must_use]
pub fn format_codex_plan(value: Option<&Value>) -> Option<String> {
    let raw = string_value(value)?;
    Some(match raw.to_lowercase().as_str() {
        "prolite" => "Pro 5x".to_owned(),
        "pro" => "Pro 20x".to_owned(),
        _ => title_case(&raw),
    })
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Session,
    Weekly,
}

#[expect(clippy::float_cmp, reason = "exact equality is what is meant here")]
fn exact_kind(window: &Map<String, Value>) -> Option<Kind> {
    match number_value(window.get("limit_window_seconds")) {
        Some(s) if s == SESSION_SECONDS => Some(Kind::Session),
        Some(s) if s == WEEK_SECONDS => Some(Kind::Weekly),
        _ => None,
    }
}

/// Primary is usually the session and secondary the week, but the window length decides when present.
#[expect(
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    reason = "a bounded, rounded number converted between float and integer"
)]
fn map_rate_limit(
    rate_limit: Option<&Map<String, Value>>,
    labels: [(&str, &str); 2],
    now: Timestamp,
) -> Vec<QuotaWindow> {
    let candidates: Vec<(&Map<String, Value>, Kind)> = [
        (rate_limit.and_then(|r| record(r.get("primary_window"))), Kind::Session),
        (rate_limit.and_then(|r| record(r.get("secondary_window"))), Kind::Weekly),
    ]
    .into_iter()
    .filter_map(|(w, k)| w.map(|w| (w, k)))
    .collect();
    let mut windows = Vec::new();
    for (kind, (id, label)) in [Kind::Session, Kind::Weekly].into_iter().zip(labels) {
        let window = candidates
            .iter()
            .find(|(w, _)| exact_kind(w) == Some(kind))
            .or_else(|| candidates.iter().find(|(w, fallback)| exact_kind(w).is_none() && *fallback == kind))
            .map(|(w, _)| *w);
        let Some(window) = window else { continue };
        let Some(used_percent) = number_value(window.get("used_percent")) else { continue };
        let reset_after = number_value(window.get("reset_after_seconds"));
        let resets_at = instant_value(window.get("reset_at")).or_else(|| {
            let ms = now.as_millisecond() as f64 + reset_after? * 1000.0;
            Timestamp::from_millisecond(ms.trunc() as i64).ok().map(iso_millis)
        });
        windows.push(QuotaWindow {
            id: id.to_owned(),
            label: label.to_owned(),
            used_percent,
            resets_at,
            period_seconds: number_value(window.get("limit_window_seconds")).unwrap_or(if kind == Kind::Session {
                SESSION_SECONDS
            } else {
                WEEK_SECONDS
            }),
            format: QuotaFormat::Percent,
            used_value: None,
            limit_value: None,
        });
    }
    windows
}

pub fn map_codex_usage(body: &Map<String, Value>, now: Timestamp) -> QuotaSnapshot {
    let mut windows =
        map_rate_limit(record(body.get("rate_limit")), [("session", "Session"), ("weekly", "Weekly")], now);
    let spark = body
        .get("additional_rate_limits")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
        .find(|entry| {
            ["limit_name", "metered_feature"]
                .iter()
                .any(|k| string_value(entry.get(*k)).is_some_and(|n| n.to_lowercase().contains("spark")))
        });
    if let Some(spark) = spark {
        windows.extend(map_rate_limit(
            record(spark.get("rate_limit")),
            [("spark", "Spark"), ("sparkWeekly", "Spark weekly")],
            now,
        ));
    }
    let mut values = Vec::new();
    let credits = record(body.get("credits"));
    let balance = number_value(credits.and_then(|c| c.get("balance"))).or_else(|| {
        (credits.and_then(|c| c.get("has_credits")).and_then(Value::as_bool) == Some(false)).then_some(0.0)
    });
    if let Some(balance) = balance {
        values.push(QuotaValue {
            id: "credits".into(),
            label: "Credits".into(),
            value: balance.floor().max(0.0),
            format: QuotaFormat::Count,
        });
    }
    QuotaSnapshot {
        provider: "codex".into(),
        plan: format_codex_plan(body.get("plan_type")),
        windows,
        values,
        fetched_at: iso_millis(now),
    }
}

pub fn fetch_codex_quota(core: &Core, now: Timestamp) -> QuotaResult {
    let credentials = match read_codex_credentials(core) {
        Some(CodexAuth::ApiKeyOnly) => {
            return Err(QuotaError::new(
                QuotaErrorKind::NoCredentials,
                "Codex is signed in with an API key; usage limits need a ChatGPT login.",
            ));
        }
        Some(CodexAuth::Login(credentials)) => credentials,
        None => return Err(QuotaError::new(QuotaErrorKind::NoCredentials, "No Codex login found. Run `codex login`.")),
    };
    let now_ms = now.as_millisecond();
    assert_not_expired(credentials.expires_at, now_ms, "Codex login expired. Run Codex to refresh it.")?;
    let mut request = Request::get(CODEX_USAGE_URL, Duration::ZERO)
        .header("Accept", "application/json")
        .header("Authorization", &format!("Bearer {}", credentials.access_token));
    if let Some(account) = &credentials.account_id {
        request = request.header("ChatGPT-Account-Id", account);
    }
    let body = request_json(core.http.as_ref(), "Codex", request, now_ms)?;
    Ok(map_codex_usage(&body, now))
}
