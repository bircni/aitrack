//! HTTP client for Cursor usage export.

use crate::env::environment_value;
use crate::readers::cursor::jwt::decode_jwt_payload;
use reqwest::blocking::Client;
use std::time::Duration;

const CURSOR_WEB_BASE_URL_ENV: &str = "CURSOR_WEB_BASE_URL";
const CURSOR_SESSION_COOKIE_NAME: &str = "WorkosCursorSessionToken";
const CURSOR_FETCH_TIMEOUT_MS: u64 = 20_000;

fn get_cursor_web_base_url() -> anyhow::Result<String> {
    let configured = environment_value(CURSOR_WEB_BASE_URL_ENV)
        .unwrap_or_else(|| "https://cursor.com".to_string());

    let url = reqwest::Url::parse(&configured)?;
    if url.scheme() != "https" {
        anyhow::bail!("CURSOR_WEB_BASE_URL must use HTTPS");
    }
    if !url.username().is_empty() || url.password().is_some() {
        anyhow::bail!("CURSOR_WEB_BASE_URL must not contain embedded credentials");
    }

    Ok(configured)
}

fn build_cookie_header_value(cookie_value: &str) -> String {
    format!("{}={}", CURSOR_SESSION_COOKIE_NAME, cookie_value)
}

#[derive(Debug, Clone)]
struct FetchAttempt {
    label: String,
    headers: Vec<(String, String)>,
}

fn get_cursor_fetch_attempts(access_token: &str, prefer_shape: Option<&str>) -> Vec<FetchAttempt> {
    let mut attempts = Vec::new();
    let mut seen = std::collections::HashSet::new();

    let subject = decode_jwt_payload(access_token)
        .and_then(|p| p.sub)
        .map(|s| s.trim().to_string());

    let mut cookie_values = vec![access_token.to_string()];
    if let Some(sub) = subject {
        cookie_values.push(format!("{}::{}", sub, access_token));
    }

    let mut push_attempt = |label: &str, headers: Vec<(String, String)>| {
        let signature = format!("{:?}", (&label, &headers));
        if seen.insert(signature) {
            attempts.push(FetchAttempt {
                label: label.to_string(),
                headers,
            });
        }
    };

    push_attempt(
        "bearer",
        vec![(
            "Authorization".to_string(),
            format!("Bearer {}", access_token),
        )],
    );

    for cookie_value in &cookie_values {
        push_attempt(
            "cookie",
            vec![(
                "Cookie".to_string(),
                build_cookie_header_value(cookie_value),
            )],
        );

        push_attempt(
            "cookie-encoded",
            vec![(
                "Cookie".to_string(),
                build_cookie_header_value(&urlencoding::encode(cookie_value)),
            )],
        );

        push_attempt(
            "bearer+cookie",
            vec![
                (
                    "Authorization".to_string(),
                    format!("Bearer {}", access_token),
                ),
                (
                    "Cookie".to_string(),
                    build_cookie_header_value(cookie_value),
                ),
            ],
        );

        push_attempt(
            "bearer+cookie-encoded",
            vec![
                (
                    "Authorization".to_string(),
                    format!("Bearer {}", access_token),
                ),
                (
                    "Cookie".to_string(),
                    build_cookie_header_value(&urlencoding::encode(cookie_value)),
                ),
            ],
        );
    }

    // Prioritize preferred shape
    if let Some(prefer) = prefer_shape {
        if let Some(index) = attempts.iter().position(|a| a.label == prefer) {
            let preferred = attempts.remove(index);
            attempts.insert(0, preferred);
        }
    }

    attempts
}

#[derive(Debug)]
pub struct CursorCsvResponse {
    pub response: String,
    pub shape: String,
}

pub async fn fetch_cursor_usage_csv(
    access_token: &str,
    prefer_shape: Option<&str>,
) -> anyhow::Result<CursorCsvResponse> {
    let base_url = get_cursor_web_base_url()?;
    let url = format!(
        "{}/api/dashboard/export-usage-events-csv?strategy=tokens",
        base_url
    );

    let client = Client::builder()
        .timeout(Duration::from_millis(CURSOR_FETCH_TIMEOUT_MS))
        .build()?;

    let mut failures = Vec::new();

    for attempt in get_cursor_fetch_attempts(access_token, prefer_shape) {
        let mut request = client
            .get(&url)
            .header("Accept", "text/csv,text/plain;q=0.9,*/*;q=0.8");

        for (key, value) in &attempt.headers {
            request = request.header(key, value);
        }

        match request.send() {
            Ok(response) if response.status().is_success() => {
                let text = response.text()?;
                return Ok(CursorCsvResponse {
                    response: text,
                    shape: attempt.label,
                });
            }
            Ok(response) => {
                let status = response.status();
                let body = response.text().unwrap_or_default();
                failures.push(format!(
                    "{}: {} ({:.200})",
                    attempt.label,
                    status,
                    body.trim()
                ));
            }
            Err(e) => {
                failures.push(format!("{}: {}", attempt.label, e));
            }
        }
    }

    Err(anyhow::anyhow!(
        "Failed to authenticate Cursor usage export. {}",
        failures.join("; ")
    ))
}
