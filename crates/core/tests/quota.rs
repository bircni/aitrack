//! Quota mappers, pacing, value parsing and JWTs against 4.x, recorded before 4.x was removed.
#![expect(clippy::unwrap_used, reason = "fixture helpers: a broken fixture should fail the test outright")]

use std::path::Path;

use aitrack_core::js;
use aitrack_core::quota::claude::{format_claude_plan, map_claude_usage, parse_claude_credentials};
use aitrack_core::quota::codex::{CodexAuth, format_codex_plan, map_codex_usage, parse_codex_auth};
use aitrack_core::quota::jwt::{decode_jwt_payload, jwt_expiry_ms};
use aitrack_core::quota::pacing::project_pace;
use aitrack_core::quota::{QuotaFormat, QuotaWindow, instant_value, parse_retry_after, title_case};
use serde_json::{Value, json};

fn expected() -> Value {
    let text =
        std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/quota/expected.json"))
            .unwrap();
    serde_json::from_str(&text).unwrap()
}

/// As JSON with undefined fields dropped, the way `JSON.stringify` writes the 4.x object.
fn as_json<T: serde::Serialize>(value: &T) -> Value {
    serde_json::from_str(&js::to_string(value).unwrap()).unwrap()
}

#[test]
fn matches_4x_in_every_recorded_zone() {
    let all = expected();
    for d in all.as_object().unwrap().values() {
        let now: jiff::Timestamp = d["now"].as_str().unwrap().parse().unwrap();
        let now_ms = now.as_millisecond();
        for row in d["instants"].as_array().unwrap() {
            assert_eq!(json!(instant_value(Some(&row[0]))), row[1], "instant {}", row[0]);
        }
        for row in d["retryAfters"].as_array().unwrap() {
            assert_eq!(json!(parse_retry_after(row[0].as_str(), now_ms)), row[1], "retry-after {}", row[0]);
        }
        for row in d["titles"].as_array().unwrap() {
            assert_eq!(title_case(row[0].as_str().unwrap()), row[1], "title {}", row[0]);
        }
        for row in d["plans"].as_array().unwrap() {
            assert_eq!(json!(format_claude_plan(row[0].as_str(), row[1].as_str())), row[2], "plan {row}");
        }
        for row in d["codexPlans"].as_array().unwrap() {
            assert_eq!(json!(format_codex_plan(Some(&row[0]))), row[1], "codex plan {}", row[0]);
        }
        for row in d["claude"].as_array().unwrap() {
            let snapshot =
                map_claude_usage(row[0].as_object().unwrap(), Some("pro"), Some("default_claude_max_5x"), now);
            assert_eq!(as_json(&snapshot), row[1], "claude {}", row[0]);
        }
        for row in d["claudeCredentials"].as_array().unwrap() {
            let ours = parse_claude_credentials(row[0].as_str().unwrap()).map(|c| {
                let mut out = serde_json::Map::new();
                out.insert("accessToken".into(), json!(c.access_token));
                out.insert("expiresAt".into(), json!(c.expires_at));
                out.insert("scopes".into(), json!(c.scopes));
                out.insert("subscriptionType".into(), json!(c.subscription_type));
                out.insert("rateLimitTier".into(), json!(c.rate_limit_tier));
                out.retain(|_, v| !v.is_null());
                as_json(&Value::Object(out))
            });
            assert_eq!(json!(ours), row[1], "credentials {}", row[0]);
        }
        for row in d["codexAuth"].as_array().unwrap() {
            let ours = parse_codex_auth(row[0].as_str().unwrap()).map(|auth| match auth {
                CodexAuth::ApiKeyOnly => json!("apiKeyOnly"),
                CodexAuth::Login(c) => {
                    let mut out =
                        json!({"accessToken": c.access_token, "accountId": c.account_id, "expiresAt": c.expires_at});
                    out.as_object_mut().unwrap().retain(|_, v| !v.is_null());
                    as_json(&out)
                }
            });
            assert_eq!(json!(ours), row[1], "codex auth {}", row[0]);
        }
        for row in d["codex"].as_array().unwrap() {
            assert_eq!(as_json(&map_codex_usage(row[0].as_object().unwrap(), now)), row[1], "codex {}", row[0]);
        }
        #[expect(
            clippy::cast_precision_loss,
            reason = "counts and millisecond times stay far below 2^53, like the JavaScript numbers 4.x used"
        )]
        for row in d["pace"].as_array().unwrap() {
            let window = QuotaWindow {
                id: String::new(),
                label: String::new(),
                used_percent: row[0]["usedPercent"].as_f64().unwrap(),
                resets_at: row[0]["resetsAt"].as_str().map(str::to_owned),
                period_seconds: row[0]["periodSeconds"].as_f64().unwrap(),
                format: QuotaFormat::Percent,
                used_value: None,
                limit_value: None,
            };
            assert_eq!(as_json(&project_pace(&window, now_ms as f64)), row[1], "pace {}", row[0]);
        }
        for row in d["jwt"].as_array().unwrap() {
            let token = row[0].as_str().unwrap();
            assert_eq!(json!(decode_jwt_payload(token)), row[1], "payload {token}");
            assert_eq!(as_json(&jwt_expiry_ms(token)), row[2], "exp {token}");
        }
    }
}
