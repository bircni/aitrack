//! Empty state messages for usage commands.

use super::messages::INIT_HINT;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UsageEmptyReason {
    NotConfigured,
    NoData,
    EmptyWindow,
}

pub fn format_usage_empty_message(reason: UsageEmptyReason, detail: Option<&str>) -> String {
    match reason {
        UsageEmptyReason::NotConfigured => {
            format!(
                "No local usage data found (Claude Code or Codex). Run: {} to sync across machines.",
                INIT_HINT
            )
        }
        UsageEmptyReason::NoData => {
            "No usage data found. Run: npx aitrack sync (Claude/Codex), or use Cursor locally."
                .to_string()
        }
        UsageEmptyReason::EmptyWindow => {
            if let Some(detail) = detail {
                format!("No usage recorded for {}.", detail)
            } else {
                "No usage recorded.".to_string()
            }
        }
    }
}

/// Message when merged provider data is unavailable entirely.
pub fn usage_empty_message(warned_not_configured: bool) -> String {
    format_usage_empty_message(
        if warned_not_configured {
            UsageEmptyReason::NotConfigured
        } else {
            UsageEmptyReason::NoData
        },
        None,
    )
}

/// Message when data exists but a filtered window or ranking is empty.
pub fn usage_empty_window_message(window_label: Option<&str>) -> String {
    format_usage_empty_message(UsageEmptyReason::EmptyWindow, window_label)
}
