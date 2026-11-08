use crate::data::messages::INIT_HINT;
use crate::providers::provider_label;

const DOCTOR_HINT: &str = "npx aitrack doctor";

/// Why there is no usage at all, or none for `providers`.
#[must_use]
pub fn usage_empty_message(not_configured: bool, providers: &[String]) -> String {
    if !providers.is_empty() {
        let labels: Vec<&str> = providers.iter().map(|p| provider_label(p)).collect();
        return format!(
            "No usage found for {}. Run: {DOCTOR_HINT} to see which sources were checked.",
            labels.join(", ")
        );
    }
    if not_configured {
        format!(
            "No local usage data found (Claude Code or Codex). Run: {DOCTOR_HINT} to see which logs were checked, or {INIT_HINT} to sync across machines."
        )
    } else {
        "No usage data found. Run: npx aitrack sync (Claude/Codex), or use Cursor locally.".to_owned()
    }
}

/// Data exists, but a window or ranking is empty.
#[must_use]
pub fn usage_empty_window_message(window_label: Option<&str>) -> String {
    match window_label {
        Some(label) if !label.is_empty() => format!("No usage recorded for {label}."),
        _ => "No usage recorded.".to_owned(),
    }
}
