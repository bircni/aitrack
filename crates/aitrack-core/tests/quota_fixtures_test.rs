//! Integration tests for quota module with fixtures.

use aitrack_core::quota::{ProviderSnapshot, QuotaWindow};
use std::fs;

#[test]
fn test_parse_claude_snapshot() {
    let fixture_path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/quota/claude_snapshot.json"
    );

    let content = fs::read_to_string(fixture_path).expect("Failed to read claude snapshot fixture");

    let snapshot: ProviderSnapshot =
        serde_json::from_str(&content).expect("Failed to parse claude snapshot");

    assert_eq!(snapshot.provider_key, "claude");
    assert_eq!(snapshot.provider_label, "Claude");
    assert_eq!(snapshot.windows.len(), 1);
    assert_eq!(snapshot.windows[0].unit, "tokens");
    assert_eq!(snapshot.windows[0].used, Some(1500000.0));
    assert!(snapshot.metadata.contains_key("input_tokens"));
    assert!(snapshot.metadata.contains_key("output_tokens"));
    assert!(snapshot.error.is_none());
}

#[test]
fn test_parse_codex_snapshot() {
    let fixture_path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/quota/codex_snapshot.json"
    );

    let content = fs::read_to_string(fixture_path).expect("Failed to read codex snapshot fixture");

    let snapshot: ProviderSnapshot =
        serde_json::from_str(&content).expect("Failed to parse codex snapshot");

    assert_eq!(snapshot.provider_key, "codex");
    assert_eq!(snapshot.provider_label, "Codex");
    assert_eq!(snapshot.windows.len(), 1);
    assert_eq!(snapshot.windows[0].unit, "tokens");
    assert_eq!(snapshot.windows[0].limit, Some(5000000.0));
    assert_eq!(snapshot.windows[0].used, Some(2500000.0));
    assert_eq!(snapshot.windows[0].remaining, Some(2500000.0));
    assert!(snapshot.metadata.contains_key("account_count"));
    assert!(snapshot.error.is_none());
}

#[test]
fn test_parse_cursor_snapshot() {
    let fixture_path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/quota/cursor_snapshot.json"
    );

    let content = fs::read_to_string(fixture_path).expect("Failed to read cursor snapshot fixture");

    let snapshot: ProviderSnapshot =
        serde_json::from_str(&content).expect("Failed to parse cursor snapshot");

    assert_eq!(snapshot.provider_key, "cursor");
    assert_eq!(snapshot.provider_label, "Cursor");
    assert_eq!(snapshot.windows.len(), 2);

    // First window: requests
    assert_eq!(snapshot.windows[0].unit, "requests");
    assert_eq!(snapshot.windows[0].limit, Some(500.0));
    assert_eq!(snapshot.windows[0].used, Some(250.0));
    assert_eq!(snapshot.windows[0].remaining, Some(250.0));

    // Second window: credits
    assert_eq!(snapshot.windows[1].unit, "credits");
    assert_eq!(snapshot.windows[1].remaining, Some(1000.0));

    assert!(snapshot.metadata.contains_key("plan_name"));
    assert!(snapshot.metadata.contains_key("credits_balance"));
    assert!(snapshot.error.is_none());
}

#[test]
fn test_quota_window_serialization() {
    let window = QuotaWindow {
        period_start: Some("2026-01-01".to_string()),
        period_end: Some("2026-01-31".to_string()),
        limit: Some(1000000.0),
        used: Some(500000.0),
        remaining: Some(500000.0),
        unit: "tokens".to_string(),
    };

    let json = serde_json::to_string(&window).expect("Failed to serialize quota window");

    let parsed: QuotaWindow =
        serde_json::from_str(&json).expect("Failed to deserialize quota window");

    assert_eq!(parsed.unit, "tokens");
    assert_eq!(parsed.limit, Some(1000000.0));
    assert_eq!(parsed.used, Some(500000.0));
    assert_eq!(parsed.remaining, Some(500000.0));
}
