//! Quota mappers, pacing, value parsing, JWTs and Cursor's CSV against 4.x, from `fixtures/quota/generate.ts`.

use jiff::tz::TimeZoneDatabase;
use std::path::Path;

use aitrack_core::js;
use aitrack_core::pricing::store::PricingStore;
use aitrack_core::quota::claude::{format_claude_plan, map_claude_usage, parse_claude_credentials};
use aitrack_core::quota::codex::{CodexAuth, format_codex_plan, map_codex_usage, parse_codex_auth};
use aitrack_core::quota::cursor::map_cursor_usage;
use aitrack_core::quota::pacing::project_pace;
use aitrack_core::quota::{QuotaFormat, QuotaWindow, instant_value, parse_retry_after, title_case};
use aitrack_core::readers::cursor::csv::aggregate_cursor_csv;
use aitrack_core::readers::cursor::jwt::{cursor_account_id, decode_jwt_payload, jwt_expiry_ms, jwt_subject};
use aitrack_core::time::Clock;
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
#[allow(clippy::too_many_lines)]
fn matches_4x_in_every_recorded_zone() {
    let all = expected();
    for (zone, d) in all.as_object().unwrap() {
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
        for row in d["cursor"].as_array().unwrap() {
            let ours = match map_cursor_usage(row[0].as_object().unwrap(), row[1].as_str(), now) {
                Ok(snapshot) => json!({"ok": as_json(&snapshot)}),
                Err(error) => json!({"error": {"kind": error.kind, "message": error.message}}),
            };
            assert_eq!(ours, row[2], "cursor {}", row[0]);
        }
        #[allow(clippy::cast_precision_loss)]
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
            assert_eq!(json!(jwt_subject(token)), row[3], "sub {token}");
            assert_eq!(cursor_account_id(token), row[4], "account {token}");
        }
        let clock = Clock::with_zone(None, TimeZoneDatabase::bundled().get(zone).unwrap());
        let pricing = PricingStore::bundled();
        for (csv, want) in d["csvInputs"].as_array().unwrap().iter().zip(d["csvDays"].as_array().unwrap()) {
            let days = aggregate_cursor_csv(csv.as_str().unwrap(), &clock, &pricing);
            let ours: Vec<Value> = days
                .iter()
                .map(|(date, day)| {
                    let models: Vec<Value> = day.by_model.iter().map(|(m, c)| json!([m, as_json(c)])).collect();
                    let totals = json!({"inputTokens": day.counts.input_tokens, "outputTokens": day.counts.output_tokens, "costUSD": day.counts.cost_usd, "hasUnpricedTokens": day.counts.has_unpriced_tokens});
                    json!([date.to_string(), models, totals])
                })
                .collect();
            assert_eq!(Value::from(ours), *want, "{zone} csv {csv}");
        }
    }
}

mod cursor_export {
    use std::sync::Mutex;

    use aitrack_core::Core;
    use aitrack_core::env::Env;
    use aitrack_core::http::{HttpClient, HttpError, Request, Response};
    use aitrack_core::output::VecOutput;
    use aitrack_core::readers::cursor::fetch_cursor_usage_csv;
    use aitrack_core::time::Clock;

    use super::*;

    /// Refuses every credential, recording the headers each attempt sent.
    #[derive(Default)]
    struct Refuse(Mutex<Vec<Vec<String>>>);

    impl HttpClient for Refuse {
        fn send(&self, request: &Request) -> Result<Response, HttpError> {
            let headers =
                request.headers.iter().filter(|(n, _)| n != "Accept").map(|(n, v)| format!("{n}={v}")).collect();
            self.0.lock().unwrap().push(headers);
            Ok(Response { status: 401, headers: Vec::new(), body: b"nope".to_vec() })
        }
    }

    struct Shared(std::sync::Arc<Refuse>);

    impl HttpClient for Shared {
        fn send(&self, request: &Request) -> Result<Response, HttpError> {
            self.0.send(request)
        }
    }

    #[test]
    fn tries_credential_shapes_in_4x_order_and_reports_each_refusal() {
        let d = &expected()["UTC"]["cursorAttempts"];
        let refuse = std::sync::Arc::new(Refuse::default());
        let core = Core::new(
            Env::new("/nowhere", Vec::<(String, String)>::new()),
            Clock::system(),
            Box::new(VecOutput::default()),
        )
        .with_http(Box::new(Shared(refuse.clone())));
        let token = expected()["UTC"]["jwt"][0][0].as_str().unwrap().to_owned();
        let error = fetch_cursor_usage_csv(&core, &token, Some("cookie-encoded:subject")).unwrap_err();
        assert_eq!(error.to_string(), d["failure"].as_str().unwrap());
        let mut calls: Vec<Vec<String>> = refuse.0.lock().unwrap().clone();
        let mut want: Vec<Vec<String>> = serde_json::from_value(d["calls"].clone()).unwrap();
        for list in calls.iter_mut().chain(want.iter_mut()) {
            list.sort();
        }
        assert_eq!(calls, want);
    }
}

mod cursor_cache {
    use std::sync::{Arc, Mutex};

    use aitrack_core::Core;
    use aitrack_core::env::Env;
    use aitrack_core::http::{HttpClient, HttpError, Request, Response};
    use aitrack_core::output::{Level, VecOutput};
    use aitrack_core::readers::cursor::read_cursor_data;
    use aitrack_core::time::Clock;

    struct Script(Mutex<Vec<Response>>, Mutex<usize>);

    struct Client(Arc<Script>);

    impl HttpClient for Client {
        fn send(&self, _: &Request) -> Result<Response, HttpError> {
            *self.0.1.lock().unwrap() += 1;
            Ok(self.0.0.lock().unwrap().remove(0))
        }
    }

    struct Out(Arc<VecOutput>);

    impl aitrack_core::output::Output for Out {
        fn info(&self, m: &str) {
            self.0.info(m);
        }
        fn warn(&self, m: &str) {
            self.0.warn(m);
        }
        fn error(&self, m: &str) {
            self.0.error(m);
        }
    }

    const CSV: &str = "Date,Model,Input (w/o Cache Write),Output Tokens\n2026-03-08,auto,100,10\n";

    #[test]
    fn serves_a_fresh_cache_backs_off_after_a_failure_and_honours_retry_after() {
        let home = tempfile::tempdir().unwrap();
        let db = home.path().join("state.vscdb");
        let connection = rusqlite::Connection::open(&db).unwrap();
        connection.execute_batch("CREATE TABLE ItemTable (key TEXT, value BLOB); INSERT INTO ItemTable VALUES ('cursorAuth/accessToken', 'tok');").unwrap();
        let script = Arc::new(Script(Mutex::new(Vec::new()), Mutex::new(0)));
        let output = Arc::new(VecOutput::default());
        let vars =
            [("CURSOR_STATE_DB_PATH", db.to_string_lossy().into_owned()), ("AITRACK_NO_PRICING_REFRESH", "1".into())];
        let core =
            Core::new(Env::new(home.path(), vars), Clock::in_zone("UTC").unwrap(), Box::new(Out(output.clone())))
                .with_http(Box::new(Client(script.clone())));
        let calls = || *script.1.lock().unwrap();

        script.0.lock().unwrap().push(Response { status: 200, headers: Vec::new(), body: CSV.into() });
        assert_eq!(read_cursor_data(&core, None).len(), 1);
        assert_eq!(read_cursor_data(&core, Some(3600.0)).len(), 1, "served from the cache");
        assert_eq!(calls(), 1);

        let busy = Response { status: 429, headers: vec![("retry-after".into(), "120".into())], body: Vec::new() };
        script.0.lock().unwrap().push(busy);
        assert_eq!(read_cursor_data(&core, None).len(), 1, "a failed refresh falls back to the cache");
        assert_eq!(read_cursor_data(&core, None).len(), 1, "a forced refresh still waits out Retry-After");
        assert_eq!(calls(), 2);
        let warnings: Vec<String> =
            output.messages().into_iter().filter(|(l, _)| *l == Level::Warn).map(|(_, m)| m).collect();
        assert!(
            warnings[0].starts_with("aitrack: Cursor — using cached export from ")
                && warnings[0].ends_with("(refresh failed: Cursor export returned HTTP 429)."),
            "{warnings:?}"
        );
        assert!(warnings[1].ends_with("(retrying after a failed refresh)."), "{warnings:?}");
        assert!(home.path().join(".config/aitrack/cache/cursor.json").exists());
    }
}
