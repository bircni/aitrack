//! `aitrack report --csv`.

use super::format::to_fixed;
use crate::data::usage_report::UsageReport;

const HEADER: [&str; 9] = [
    "provider",
    "model",
    "input_tokens",
    "cached_input_tokens",
    "output_tokens",
    "total_tokens",
    "cost_usd",
    "pricing_status",
    "unpriced_models",
];

fn field(value: &str) -> String {
    // Neutralises spreadsheet formula injection from untrusted model names.
    let text = if value.starts_with(['=', '+', '-', '@', '\t', '\r']) { format!("'{value}") } else { value.to_owned() };
    if text.contains(['"', ',', '\r', '\n']) { format!("\"{}\"", text.replace('"', "\"\"")) } else { text }
}

fn line(fields: &[String]) -> String {
    fields.iter().map(|f| field(f)).collect::<Vec<_>>().join(",")
}

const fn pricing_status(has_cost: bool, has_unpriced: bool, tokens: u64) -> &'static str {
    match (has_cost, has_unpriced) {
        (false, _) if tokens == 0 => "complete",
        (false, _) => "unpriced",
        (true, true) => "partial",
        (true, false) => "complete",
    }
}

fn optional(present: bool, value: u64) -> String {
    if present { value.to_string() } else { String::new() }
}

/// An unpriced cost is blank, not 0.
fn cost(has_cost: bool, cost: f64) -> String {
    if has_cost { to_fixed(cost, 4) } else { String::new() }
}

pub fn render_usage_report_csv(report: &UsageReport) -> String {
    let mut lines = vec![line(&HEADER.map(str::to_owned))];
    for provider in &report.providers {
        for row in &provider.rows {
            lines.push(line(&[
                provider.label.clone(),
                row.model.clone(),
                row.input_tokens.to_string(),
                optional(row.has_cached, row.cached_input_tokens),
                row.output_tokens.to_string(),
                row.tokens.to_string(),
                cost(row.has_cost, row.cost_usd),
                pricing_status(row.has_cost, row.has_unpriced_tokens, row.tokens).to_owned(),
                if row.has_unpriced_tokens { row.model.clone() } else { String::new() },
            ]));
        }
    }
    let totals = &report.totals;
    lines.push(line(&[
        "TOTAL".to_owned(),
        String::new(),
        totals.input_tokens.to_string(),
        optional(totals.has_cached, totals.cached_input_tokens),
        totals.output_tokens.to_string(),
        totals.tokens.to_string(),
        cost(totals.has_cost, totals.cost_usd),
        pricing_status(totals.has_cost, totals.has_unpriced_tokens, totals.tokens).to_owned(),
        totals.unpriced_models.as_deref().unwrap_or_default().join("; "),
    ]));
    format!("{}\n", lines.join("\n"))
}
