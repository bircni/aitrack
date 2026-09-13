//! CSV export with formula injection protection.

use crate::data::usage_report::UsageReport;
use crate::providers::provider_label;

const HEADER: &[&str] = &[
    "provider",
    "model",
    "input_tokens",
    "cached_input_tokens",
    "output_tokens",
    "total_tokens",
    "cost_usd",
];

fn csv_field(value: &str) -> String {
    let mut text = value.to_string();

    // Neutralize spreadsheet formula injection from untrusted model names
    if text.starts_with('=')
        || text.starts_with('+')
        || text.starts_with('-')
        || text.starts_with('@')
        || text.starts_with('\t')
        || text.starts_with('\r')
    {
        text = format!("'{}", text);
    }

    // Escape if contains special CSV characters
    if text.contains(',') || text.contains('"') || text.contains('\n') || text.contains('\r') {
        format!("\"{}\"", text.replace('"', "\"\""))
    } else {
        text
    }
}

fn csv_line(fields: &[String]) -> String {
    fields
        .iter()
        .map(|f| csv_field(f))
        .collect::<Vec<_>>()
        .join(",")
}

/// Render usage report as CSV with formula injection protection.
pub fn render_usage_report_csv(report: &UsageReport) -> String {
    let mut lines = vec![csv_line(
        &HEADER.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
    )];

    for provider in &report.providers {
        let label = provider_label(&provider.key);

        for row in &provider.rows {
            let cached_str = if row.has_cached {
                row.cached_input_tokens.to_string()
            } else {
                String::new()
            };

            let cost_str = if row.has_cost {
                format!("{:.4}", row.cost_usd)
            } else {
                String::new()
            };

            lines.push(csv_line(&[
                label.clone(),
                row.model.clone(),
                row.input_tokens.to_string(),
                cached_str,
                row.output_tokens.to_string(),
                row.tokens.to_string(),
                cost_str,
            ]));
        }
    }

    // Add total row
    let cached_total_str = if report.totals.has_cached {
        report.totals.cached_input_tokens.to_string()
    } else {
        String::new()
    };

    let cost_total_str = if report.totals.has_cost {
        format!("{:.4}", report.totals.cost_usd)
    } else {
        String::new()
    };

    lines.push(csv_line(&[
        "TOTAL".to_string(),
        String::new(),
        report.totals.input_tokens.to_string(),
        cached_total_str,
        report.totals.output_tokens.to_string(),
        report.totals.tokens.to_string(),
        cost_total_str,
    ]));

    format!("{}\n", lines.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::usage_report::{UsageReportProvider, UsageReportRow, UsageReportTotals};

    #[test]
    fn test_csv_field_escaping() {
        assert_eq!(csv_field("normal"), "normal");
        assert_eq!(csv_field("=SUM(A1:A10)"), "'=SUM(A1:A10)");
        assert_eq!(csv_field("+123"), "'+123");
        assert_eq!(csv_field("text,with,comma"), "\"text,with,comma\"");
        assert_eq!(
            csv_field("text\"with\"quotes"),
            "\"text\"\"with\"\"quotes\""
        );
    }

    #[test]
    fn test_render_csv() {
        let report = UsageReport {
            window_label: "Test Week".to_string(),
            providers: vec![UsageReportProvider {
                key: "claude_code".to_string(),
                label: "Claude Code".to_string(),
                rows: vec![UsageReportRow {
                    model: "claude-3.5-sonnet".to_string(),
                    input_tokens: 1000,
                    output_tokens: 500,
                    tokens: 1500,
                    cached_input_tokens: 100,
                    has_cached: true,
                    cost_usd: 0.05,
                    has_cost: true,
                }],
                subtotal_tokens: 1500,
                subtotal_cost_usd: 0.05,
                subtotal_has_cost: true,
            }],
            totals: UsageReportTotals {
                input_tokens: 1000,
                output_tokens: 500,
                tokens: 1500,
                cached_input_tokens: 100,
                has_cached: true,
                cost_usd: 0.05,
                has_cost: true,
            },
            row_count: 1,
        };

        let csv = render_usage_report_csv(&report);
        assert!(csv.contains("provider,model,input_tokens"));
        assert!(csv.contains("Claude Code"));
        assert!(csv.contains("claude-3.5-sonnet"));
        assert!(csv.contains("TOTAL"));
    }
}
